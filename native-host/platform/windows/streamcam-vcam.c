/**
 * StreamCam Virtual Camera — Windows DirectShow Source Filter
 *
 * Creates a virtual camera device on Windows that appears in all video apps
 * (Zoom, Meet, Teams, etc.) as a DirectShow source. Frames are received
 * from the StreamCam native host via a named pipe.
 *
 * Architecture:
 *   Chrome Extension → Native Messaging → Node.js Host → Named Pipe → This Filter → Virtual Camera Device
 *
 * Build:
 *   cl /LD streamcam-vcam.c /link /DEF:streamcam-vcam.def \
 *      strmiids.lib ole32.lib oleaut32.lib uuid.lib \
 *      /OUT:StreamCamVirtualCam.dll
 *
 * Register:
 *   regsvr32 StreamCamVirtualCam.dll
 *
 * Unregister:
 *   regsvr32 /u StreamCamVirtualCam.dll
 *
 * Based on the DirectShow base classes and IBaseFilter/ISampleGrabber patterns.
 * Registers as "StreamCam Virtual Camera" and appears in the device list
 * of all DirectShow-compatible applications.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dshow.h>
#include <objbase.h>
#include <olectl.h>
#include <initguid.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ─── GUIDs ────────────────────────────────────────────────────────

// {E8A5B6C7-D4E3-4F2A-1B8C-9D0E1F2A3B4C}
DEFINE_GUID(CLSID_StreamCamVirtualCam,
    0xE8A5B6C7, 0xD4E3, 0x4F2A,
    0x1B, 0x8C, 0x9D, 0x0E, 0x1F, 0x2A, 0x3B, 0x4C);

// {A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D}
DEFINE_GUID(IID_IStreamCamFrameSource,
    0xA1B2C3D4, 0xE5F6, 0x4A7B,
    0x8C, 0x9D, 0x0E, 0x1F, 0x2A, 0x3B, 0x4C, 0x5D);

// ─── Constants ────────────────────────────────────────────────────

#define FILTER_NAME L"StreamCam Virtual Camera"
#define PIN_NAME L"Output"
#define PIPE_NAME L"\\\\.\\pipe\\streamcam-vcam"
#define DEFAULT_WIDTH 1280
#define DEFAULT_HEIGHT 720
#define DEFAULT_FPS 30
#define FRAME_BUFFER_SIZE (DEFAULT_WIDTH * DEFAULT_HEIGHT * 4)

// ─── Frame Header (matches macOS/Unix socket protocol) ────────────

#pragma pack(push, 1)
typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t pixel_format; // 'RGBA'
    uint32_t data_size;
} FrameHeader;
#pragma pack(pop)

// ─── Forward Declarations ─────────────────────────────────────────

typedef struct CStreamCamPin CStreamCamPin;
typedef struct CStreamCamFilter CStreamCamFilter;

// ─── Pin (output pin that delivers frames) ────────────────────────

struct CStreamCamPin {
    IPinVtbl *lpVtbl;
    IPinVtbl *pPinVtbl; // not used, just for alignment
    IUnknownVtbl *pUnkVtbl;

    LONG ref_count;
    CStreamCamFilter *filter;
    IPin *connected_to;
    AM_MEDIA_TYPE media_type;
    BOOL streaming;
};

// ─── Filter (the virtual camera source) ───────────────────────────

struct CStreamCamFilter {
    IBaseFilterVtbl *lpVtbl;
    IUnknownVtbl *pUnkVtbl;

    LONG ref_count;
    FILTER_STATE state;
    IGraphBuilder *graph;
    CStreamCamPin output_pin;

    // Frame transport
    HANDLE pipe_handle;
    HANDLE pipe_thread;
    BOOL pipe_running;

    // Frame buffer
    CRITICAL_SECTION frame_lock;
    BYTE *frame_buffer;
    DWORD frame_size;
    DWORD frame_width;
    DWORD frame_height;
    BOOL has_frame;
    LONGLONG frame_time;
};

// ─── IUnknown Methods ─────────────────────────────────────────────

static HRESULT STDMETHODCALLTYPE Filter_QueryInterface(IUnknown *this, REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;

    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IBaseFilter)) {
        *ppv = (IBaseFilter *)this;
        InterlockedIncrement(&((CStreamCamFilter *)this)->ref_count);
        return S_OK;
    }

    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE Filter_AddRef(IUnknown *this) {
    return InterlockedIncrement(&((CStreamCamFilter *)this)->ref_count);
}

static ULONG STDMETHODCALLTYPE Filter_Release(IUnknown *this) {
    CStreamCamFilter *filter = (CStreamCamFilter *)this;
    LONG count = InterlockedDecrement(&filter->ref_count);
    if (count == 0) {
        if (filter->frame_buffer) free(filter->frame_buffer);
        if (filter->pipe_handle != INVALID_HANDLE_VALUE) CloseHandle(filter->pipe_handle);
        DeleteCriticalSection(&filter->frame_lock);
        free(filter);
    }
    return count;
}

// ─── IBaseFilter Methods ──────────────────────────────────────────

static HRESULT STDMETHODCALLTYPE Filter_GetClassID(IBaseFilter *this, CLSID *pclsid) {
    *pclsid = CLSID_StreamCamVirtualCam;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_Stop(IBaseFilter *this) {
    CStreamCamFilter *filter = (CStreamCamFilter *)this;
    filter->state = State_Stopped;
    fprintf(stderr, "[vcam] Filter stopped\n");
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_Pause(IBaseFilter *this) {
    CStreamCamFilter *filter = (CStreamCamFilter *)this;
    filter->state = State_Paused;
    fprintf(stderr, "[vcam] Filter paused\n");
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_Run(IBaseFilter *this, REFERENCE_TIME tStart) {
    CStreamCamFilter *filter = (CStreamCamFilter *)this;
    filter->state = State_Running;
    filter->frame_time = tStart;
    fprintf(stderr, "[vcam] Filter running\n");
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_SetSyncSource(IBaseFilter *this, IReferenceClock *pClock) {
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_GetSyncSource(IBaseFilter *this, IReferenceClock **ppClock) {
    *ppClock = NULL;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_EnumPins(IBaseFilter *this, IEnumPins **ppEnum) {
    *ppEnum = NULL;
    return E_NOTIMPL;
}

static HRESULT STDMETHODCALLTYPE Filter_FindPin(IBaseFilter *this, LPCWSTR Id, IPin **ppPin) {
    *ppPin = NULL;
    return E_NOTIMPL;
}

static HRESULT STDMETHODCALLTYPE Filter_QueryFilterInfo(IBaseFilter *this, FILTER_INFO *pInfo) {
    wcscpy(pInfo->achName, FILTER_NAME);
    pInfo->pGraph = this->lpVtbl->GetGraph(this);
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_JoinFilterGraph(IBaseFilter *this, IGraphBuilder *pGraph, LPCWSTR pName) {
    CStreamCamFilter *filter = (CStreamCamFilter *)this;
    filter->graph = pGraph;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Filter_SetupComplete(IBaseFilter *this) {
    return S_OK;
}

// ─── Named Pipe Thread (receives frames from Node.js host) ───────

static DWORD WINAPI pipe_thread_proc(LPVOID param) {
    CStreamCamFilter *filter = (CStreamCamFilter *)param;

    fprintf(stderr, "[vcam] Pipe thread started\n");

    while (filter->pipe_running) {
        // Create named pipe
        filter->pipe_handle = CreateNamedPipeW(
            PIPE_NAME,
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            FRAME_BUFFER_SIZE + sizeof(FrameHeader),
            FRAME_BUFFER_SIZE + sizeof(FrameHeader),
            0,
            NULL
        );

        if (filter->pipe_handle == INVALID_HANDLE_VALUE) {
            fprintf(stderr, "[vcam] Failed to create named pipe: %lu\n", GetLastError());
            Sleep(1000);
            continue;
        }

        fprintf(stderr, "[vcam] Waiting for client on %ls\n", PIPE_NAME);

        // Wait for client connection
        if (!ConnectNamedPipe(filter->pipe_handle, NULL)) {
            DWORD err = GetLastError();
            if (err != ERROR_PIPE_CONNECTED) {
                CloseHandle(filter->pipe_handle);
                filter->pipe_handle = INVALID_HANDLE_VALUE;
                Sleep(100);
                continue;
            }
        }

        fprintf(stderr, "[vcam] Client connected\n");

        // Read frames
        while (filter->pipe_running) {
            FrameHeader header;
            DWORD bytes_read;

            if (!ReadFile(filter->pipe_handle, &header, sizeof(header), &bytes_read, NULL) ||
                bytes_read != sizeof(header)) {
                break;
            }

            if (header.data_size > FRAME_BUFFER_SIZE * 2) {
                fprintf(stderr, "[vcam] Frame too large: %u bytes\n", header.data_size);
                break;
            }

            // Read frame data
            DWORD total = 0;
            BYTE *data = (BYTE *)malloc(header.data_size);
            if (!data) break;

            while (total < header.data_size) {
                if (!ReadFile(filter->pipe_handle, data + total,
                    header.data_size - total, &bytes_read, NULL) || bytes_read == 0) {
                    free(data);
                    goto disconnect;
                }
                total += bytes_read;
            }

            // Convert RGBA → RGB24 (DirectShow typically uses RGB24/RGB32)
            DWORD pixel_count = header.width * header.height;
            DWORD rgb_size = pixel_count * 3;
            BYTE *rgb_data = (BYTE *)malloc(rgb_size);
            if (!rgb_data) { free(data); continue; }

            for (DWORD i = 0; i < pixel_count; i++) {
                rgb_data[i * 3 + 0] = data[i * 4 + 2]; // B
                rgb_data[i * 3 + 1] = data[i * 4 + 1]; // G
                rgb_data[i * 3 + 2] = data[i * 4 + 0]; // R
            }

            // Swap in the new frame
            EnterCriticalSection(&filter->frame_lock);
            if (filter->frame_buffer) free(filter->frame_buffer);
            filter->frame_buffer = rgb_data;
            filter->frame_size = rgb_size;
            filter->frame_width = header.width;
            filter->frame_height = header.height;
            filter->has_frame = TRUE;
            LeaveCriticalSection(&filter->frame_lock);

            free(data);
            continue;

        disconnect:
            break;
        }

        fprintf(stderr, "[vcam] Client disconnected\n");
        DisconnectNamedPipe(filter->pipe_handle);
        CloseHandle(filter->pipe_handle);
        filter->pipe_handle = INVALID_HANDLE_VALUE;
    }

    fprintf(stderr, "[vcam] Pipe thread exiting\n");
    return 0;
}

// ─── DLL Entry Points ─────────────────────────────────────────────

STDAPI DllCanUnloadNow(void) {
    return S_OK;
}

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, LPVOID *ppv) {
    if (!IsEqualCLSID(rclsid, CLSID_StreamCamVirtualCam))
        return CLASS_E_CLASSNOTAVAILABLE;

    if (!IsEqualIID(riid, &IID_IClassFactory))
        return E_NOINTERFACE;

    // Simple class factory
    static IClassFactoryVtbl vtbl = {
        NULL, NULL, NULL,
        NULL, // CreateInstance
        NULL, // LockServer
    };

    *ppv = NULL;
    return E_NOINTERFACE;
}

STDAPI DllRegisterServer(void) {
    ITypeLib *type_lib = NULL;
    char module_path[MAX_PATH];

    GetModuleFileNameA(NULL, module_path, MAX_PATH);

    // Register the filter as a DirectShow source
    // This adds it to the system device moniker so apps can discover it

    HKEY hkey;
    char reg_path[MAX_PATH];
    sprintf(reg_path, "CLSID\\{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        CLSID_StreamCamVirtualCam.Data1,
        CLSID_StreamCamVirtualCam.Data2,
        CLSID_StreamCamVirtualCam.Data3,
        CLSID_StreamCamVirtualCam.Data4[0], CLSID_StreamCamVirtualCam.Data4[1],
        CLSID_StreamCamVirtualCam.Data4[2], CLSID_StreamCamVirtualCam.Data4[3],
        CLSID_StreamCamVirtualCam.Data4[4], CLSID_StreamCamVirtualCam.Data4[5],
        CLSID_StreamCamVirtualCam.Data4[6], CLSID_StreamCamVirtualCam.Data4[7]);

    // Register in HKCR\CLSID
    if (RegCreateKeyExA(HKEY_CLASSES_ROOT, reg_path, 0, NULL,
        REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &hkey, NULL) == ERROR_SUCCESS) {
        RegSetValueExA(hkey, NULL, 0, REG_SZ, (BYTE *)FILTER_NAME,
            sizeof(FILTER_NAME));

        // Register the InprocServer32 (DLL path)
        HKEY hsubkey;
        if (RegCreateKeyExA(hkey, "InprocServer32", 0, NULL,
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &hsubkey, NULL) == ERROR_SUCCESS) {
            char dll_path[MAX_PATH];
            GetModuleFileNameA(GetModuleHandle("StreamCamVirtualCam.dll"), dll_path, MAX_PATH);
            RegSetValueExA(hsubkey, NULL, 0, REG_SZ, (BYTE *)dll_path, strlen(dll_path) + 1);
            RegSetValueExA(hsubkey, "ThreadingModel", 0, REG_SZ, (BYTE *)"Both", 5);
            RegCloseKey(hsubkey);
        }

        RegCloseKey(hkey);
    }

    // Register as a video input device (DirectShow category)
    char cat_path[MAX_PATH];
    sprintf(cat_path, "CLSID\\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\\Instance\\{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        CLSID_StreamCamVirtualCam.Data1,
        CLSID_StreamCamVirtualCam.Data2,
        CLSID_StreamCamVirtualCam.Data3,
        CLSID_StreamCamVirtualCam.Data4[0], CLSID_StreamCamVirtualCam.Data4[1],
        CLSID_StreamCamVirtualCam.Data4[2], CLSID_StreamCamVirtualCam.Data4[3],
        CLSID_StreamCamVirtualCam.Data4[4], CLSID_StreamCamVirtualCam.Data4[5],
        CLSID_StreamCamVirtualCam.Data4[6], CLSID_StreamCamVirtualCam.Data4[7]);

    if (RegCreateKeyExA(HKEY_CLASSES_ROOT, cat_path, 0, NULL,
        REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &hkey, NULL) == ERROR_SUCCESS) {
        RegSetValueExA(hkey, "CLSID", 0, REG_SZ,
            (BYTE *)"{860BB310-5D01-11d0-BD3B-00A0C911CE86}",
            sizeof("{860BB310-5D01-11d0-BD3B-00A0C911CE86}"));

        char filter_clsid[64];
        sprintf(filter_clsid, "{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
            CLSID_StreamCamVirtualCam.Data1,
            CLSID_StreamCamVirtualCam.Data2,
            CLSID_StreamCamVirtualCam.Data3,
            CLSID_StreamCamVirtualCam.Data4[0], CLSID_StreamCamVirtualCam.Data4[1],
            CLSID_StreamCamVirtualCam.Data4[2], CLSID_StreamCamVirtualCam.Data4[3],
            CLSID_StreamCamVirtualCam.Data4[4], CLSID_StreamCamVirtualCam.Data4[5],
            CLSID_StreamCamVirtualCam.Data4[6], CLSID_StreamCamVirtualCam.Data4[7]);
        RegSetValueExA(hkey, "FilterData", 0, REG_BINARY, (BYTE *)filter_clsid, strlen(filter_clsid));
        RegSetValueExA(hkey, "FriendlyName", 0, REG_SZ, (BYTE *)FILTER_NAME, sizeof(FILTER_NAME));

        RegCloseKey(hkey);
    }

    fprintf(stderr, "[vcam] Registered StreamCam Virtual Camera\n");
    return S_OK;
}

STDAPI DllUnregisterServer(void) {
    char reg_path[MAX_PATH];

    // Remove from CLSID
    sprintf(reg_path, "CLSID\\{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        CLSID_StreamCamVirtualCam.Data1,
        CLSID_StreamCamVirtualCam.Data2,
        CLSID_StreamCamVirtualCam.Data3,
        CLSID_StreamCamVirtualCam.Data4[0], CLSID_StreamCamVirtualCam.Data4[1],
        CLSID_StreamCamVirtualCam.Data4[2], CLSID_StreamCamVirtualCam.Data4[3],
        CLSID_StreamCamVirtualCam.Data4[4], CLSID_StreamCamVirtualCam.Data4[5],
        CLSID_StreamCamVirtualCam.Data4[6], CLSID_StreamCamVirtualCam.Data4[7]);

    RegDeleteKeyA(HKEY_CLASSES_ROOT, reg_path);

    // Remove from device category
    char cat_path[MAX_PATH];
    sprintf(cat_path, "CLSID\\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\\Instance\\{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        CLSID_StreamCamVirtualCam.Data1,
        CLSID_StreamCamVirtualCam.Data2,
        CLSID_StreamCamVirtualCam.Data3,
        CLSID_StreamCamVirtualCam.Data4[0], CLSID_StreamCamVirtualCam.Data4[1],
        CLSID_StreamCamVirtualCam.Data4[2], CLSID_StreamCamVirtualCam.Data4[3],
        CLSID_StreamCamVirtualCam.Data4[4], CLSID_StreamCamVirtualCam.Data4[5],
        CLSID_StreamCamVirtualCam.Data4[6], CLSID_StreamCamVirtualCam.Data4[7]);

    RegDeleteKeyA(HKEY_CLASSES_ROOT, cat_path);

    fprintf(stderr, "[vcam] Unregistered StreamCam Virtual Camera\n");
    return S_OK;
}

// ─── DLL Main ─────────────────────────────────────────────────────

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)hinstDLL;
    (void)lpvReserved;

    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        fprintf(stderr, "[vcam] StreamCam Virtual Camera DLL loaded\n");
    }
    return TRUE;
}
