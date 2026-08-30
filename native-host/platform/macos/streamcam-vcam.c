/**
 * StreamCam Virtual Camera — macOS CoreMediaIO DAL Plugin
 *
 * Creates a virtual camera device on macOS that appears in all video apps
 * (Zoom, Meet, Teams, FaceTime, etc.). Frames are received from the
 * StreamCam native host via a Unix domain socket.
 *
 * Architecture:
 *   Chrome Extension → Native Messaging → Node.js Host → Unix Socket → This Plugin → Virtual Camera Device
 *
 * Build:
 *   clang -dynamiclib -framework CoreMediaIO -framework CoreVideo \
 *         -framework CoreFoundation -framework Foundation \
 *         -o StreamCamVirtualCam.plugin/Contents/MacOS/StreamCamVirtualCam \
 *         streamcam-vcam.c
 *
 * Based on the CoreMediaIO DAL plugin API. Registers as "StreamCam Virtual Camera"
 * and appears as a selectable camera in all macOS applications.
 */

#include <CoreMediaIO/CoreMediaIO.h>
#include <CoreMedia/CMFormatDescription.h>
#include <CoreVideo/CVPixelBuffer.h>
#include <CoreFoundation/CFString.h>
#include <Foundation/Foundation.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// ─── Constants ────────────────────────────────────────────────────

#define PLUGIN_ID "com.alresia.streamcam.virtualcam"
#define DEVICE_NAME "StreamCam Virtual Camera"
#define SOCKET_PATH "/tmp/streamcam-vcam.sock"
#define DEFAULT_WIDTH 1280
#define DEFAULT_HEIGHT 720
#define DEFAULT_FPS 30

// ─── State ────────────────────────────────────────────────────────

static pthread_mutex_t g_frame_mutex = PTHREAD_MUTEX_INITIALIZER;
static CVPixelBufferRef g_current_frame = NULL;
static CMTime g_frame_time = {0, 0, 0, 0, 0};
static pthread_t g_socket_thread;
static int g_running = 0;
static int g_socket_fd = -1;

static CMClockRef g_clock = NULL;
static CMIOStreamRef g_stream = NULL;
static CMIODeviceRef g_device = NULL;

// ─── Frame Transport (Unix Socket) ────────────────────────────────
// The Node.js native host writes raw RGBA frames to this socket.
// This thread reads them and makes them available to the virtual camera.

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t pixel_format; // 'RGBA'
    uint32_t data_size;
    // followed by raw pixel data
} FrameHeader;

static void *socket_listener(void *arg) {
    (void)arg;

    // Remove stale socket
    unlink(SOCKET_PATH);

    g_socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (g_socket_fd < 0) {
        fprintf(stderr, "[vcam] Failed to create socket: %s\n", strerror(errno));
        return NULL;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, SOCKET_PATH, sizeof(addr.sun_path) - 1);

    if (bind(g_socket_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        fprintf(stderr, "[vcam] Failed to bind socket: %s\n", strerror(errno));
        close(g_socket_fd);
        return NULL;
    }

    listen(g_socket_fd, 1);
    fprintf(stderr, "[vcam] Listening on %s\n", SOCKET_PATH);

    while (g_running) {
        int client = accept(g_socket_fd, NULL, NULL);
        if (client < 0) {
            if (g_running) fprintf(stderr, "[vcam] Accept failed: %s\n", strerror(errno));
            continue;
        }

        fprintf(stderr, "[vcam] Client connected\n");

        // Read frames from this client
        while (g_running) {
            FrameHeader header;
            ssize_t n = read(client, &header, sizeof(header));
            if (n <= 0) break;
            if (n != sizeof(header)) break;

            if (header.data_size > 50 * 1024 * 1024) {
                fprintf(stderr, "[vcam] Frame too large: %u bytes\n", header.data_size);
                break;
            }

            uint8_t *data = malloc(header.data_size);
            if (!data) break;

            size_t total = 0;
            while (total < header.data_size) {
                ssize_t r = read(client, data + total, header.data_size - total);
                if (r <= 0) { free(data); goto next_client; }
                total += r;
            }

            // Convert RGBA to BGRA (macOS wants BGRA)
            uint32_t pixel_count = header.width * header.height;
            for (uint32_t i = 0; i < pixel_count; i++) {
                uint8_t r = data[i * 4 + 0];
                uint8_t g = data[i * 4 + 1];
                uint8_t b = data[i * 4 + 2];
                data[i * 4 + 0] = b;
                data[i * 4 + 1] = g;
                data[i * 4 + 2] = r;
                // data[i*4+3] = alpha — keep as-is
            }

            // Create CVPixelBuffer from the frame data
            CVPixelBufferRef pixel_buffer = NULL;
            CVReturn ret = CVPixelBufferCreateWithBytes(
                kCFAllocatorDefault,
                header.width,
                header.height,
                kCVPixelFormatType_32BGRA,
                data,
                header.width * 4,
                NULL, NULL, NULL,
                &pixel_buffer
            );

            if (ret != kCVReturnSuccess || !pixel_buffer) {
                fprintf(stderr, "[vcam] Failed to create pixel buffer: %d\n", ret);
                free(data);
                continue;
            }

            // Swap in the new frame (old one gets released)
            pthread_mutex_lock(&g_frame_mutex);
            if (g_current_frame) CFRelease(g_current_frame);
            g_current_frame = pixel_buffer;
            g_frame_time = CMClockGetTime(g_clock);
            pthread_mutex_unlock(&g_frame_mutex);

            free(data);
            continue;

        next_client:
            break;
        }

        fprintf(stderr, "[vcam] Client disconnected\n");
        close(client);
    }

    close(g_socket_fd);
    unlink(SOCKET_PATH);
    return NULL;
}

// ─── CMIOHardware Callbacks ───────────────────────────────────────

static OSStatus plugin_init(void) {
    fprintf(stderr, "[vcam] Plugin init\n");
    return noErr;
}

static OSStatus plugin_initialize(CMIOComponentInstance self) {
    fprintf(stderr, "[vcam] Plugin initialize\n");

    // Create the clock
    CMClockCreate(kCFAllocatorDefault, &g_clock);

    // Start the socket listener
    g_running = 1;
    pthread_create(&g_socket_thread, NULL, socket_listener, NULL);

    return noErr;
}

static OSStatus plugin_finalize(CMIOComponentInstance self) {
    fprintf(stderr, "[vcam] Plugin finalize\n");

    g_running = 0;

    // Close socket to unblock accept()
    if (g_socket_fd >= 0) {
        shutdown(g_socket_fd, SHUT_RDWR);
        close(g_socket_fd);
        g_socket_fd = -1;
    }

    // Unlink socket file
    unlink(SOCKET_PATH);

    // Wait for socket thread to finish
    pthread_join(g_socket_thread, NULL);

    // Release frame
    pthread_mutex_lock(&g_frame_mutex);
    if (g_current_frame) {
        CFRelease(g_current_frame);
        g_current_frame = NULL;
    }
    pthread_mutex_unlock(&g_frame_mutex);

    // Release clock
    if (g_clock) {
        CFRelease(g_clock);
        g_clock = NULL;
    }

    return noErr;
}

static OSStatus plugin_get_class_id(CMIOComponentInstance self, CFUUIDBytes *class_id) {
    *class_id = kCMIOPluginClassID;
    return noErr;
}

static OSStatus plugin_get_factory(CMIOComponentInstance self, CFUUIDUUID *factory_id) {
    *factory_id = kCMIOHardwareFactoryID;
    return noErr;
}

// ─── Device Callbacks ─────────────────────────────────────────────

static OSStatus device_query_interface(CMIODeviceRef self, CFUUIDBytes iid, void **ppv) {
    if (!ppv) return kCMIOHardwareBadObjectErr;

    CFUUIDRef interface_id = CFUUIDCreateFromUUIDBytes(kCFAllocatorDefault, iid);

    if (CFEqual(interface_id, kCMIOHardwarePluginInterfaceID) ||
        CFEqual(interface_id, IUnknownUUID)) {
        *ppv = self;
        CFRetain(self);
        CFRelease(interface_id);
        return noErr;
    }

    CFRelease(interface_id);
    *ppv = NULL;
    return kCMIOHardwareUnsupportedOperationErr;
}

static OSStatus device_add_device_bulk(CMIODeviceRef self, CMIOClassID class_id,
                                        UInt32 *number_of_devices) {
    *number_of_devices = 1;
    return noErr;
}

static OSStatus device_get_device_at_index(CMIODeviceRef self, CMIOClassID class_id,
                                            UInt32 index, CMIODeviceRef *device) {
    if (index == 0) {
        *device = g_device;
        return noErr;
    }
    return kCMIOHardwareBadObjectErr;
}

// ─── Stream Callbacks ─────────────────────────────────────────────

static OSStatus stream_query_interface(CMIOStreamRef self, CFUUIDBytes iid, void **ppv) {
    if (!ppv) return kCMIOHardwareBadObjectErr;

    CFUUIDRef interface_id = CFUUIDCreateFromUUIDBytes(kCFAllocatorDefault, iid);

    if (CFEqual(interface_id, kCMIOHardwarePluginInterfaceID) ||
        CFEqual(interface_id, IUnknownUUID)) {
        *ppv = self;
        CFRetain(self);
        CFRelease(interface_id);
        return noErr;
    }

    CFRelease(interface_id);
    *ppv = NULL;
    return kCMIOHardwareUnsupportedOperationErr;
}

static OSStatus stream_get_class_id(CMIOStreamRef self, CMIOClassID *class_id) {
    *class_id = kCMIOStreamClassID;
    return noErr;
}

static OSStatus stream_get_property_info(CMIOStreamRef self, CMIOPropertyProperty property,
                                          UInt32 *property_data_size, UInt32 *number_of_data_elements) {
    switch (property) {
        case kCMIOStreamPropertyFormatDescription:
            *property_data_size = sizeof(CMFormatDescriptionRef);
            *number_of_data_elements = 1;
            return noErr;
        case kCMIOStreamPropertyFrameRate:
            *property_data_size = sizeof(Float64);
            *number_of_data_elements = 1;
            return noErr;
        case kCMIOStreamPropertyFrameRateRanges:
            *property_data_size = sizeof(AudioValueRange);
            *number_of_data_elements = 1;
            return noErr;
        default:
            return kCMIOHardwareUnsupportedOperationErr;
    }
}

static OSStatus stream_get_property_data(CMIOStreamRef self, CMIOPropertyProperty property,
                                          UInt32 qualifier_data_size, const void *qualifier_data,
                                          UInt32 property_data_size, UInt32 *number_of_data_elements,
                                          void *property_data) {
    switch (property) {
        case kCMIOStreamPropertyFormatDescription: {
            CMVideoFormatDescriptionRef format_desc = NULL;
            CMVideoFormatDescriptionCreate(
                kCFAllocatorDefault,
                kCVPixelFormatType_32BGRA,
                DEFAULT_WIDTH,
                DEFAULT_HEIGHT,
                NULL,
                &format_desc
            );
            *(CMFormatDescriptionRef *)property_data = format_desc;
            *number_of_data_elements = 1;
            return noErr;
        }
        case kCMIOStreamPropertyFrameRate:
            *(Float64 *)property_data = DEFAULT_FPS;
            *number_of_data_elements = 1;
            return noErr;
        case kCMIOStreamPropertyFrameRateRanges: {
            AudioValueRange range;
            range.mMinimum = DEFAULT_FPS;
            range.mMaximum = DEFAULT_FPS;
            *(AudioValueRange *)property_data = range;
            *number_of_data_elements = 1;
            return noErr;
        }
        default:
            *number_of_data_elements = 0;
            return kCMIOHardwareUnsupportedOperationErr;
    }
}

static OSStatus stream_start(CMIOStreamRef self) {
    fprintf(stderr, "[vcam] Stream started\n");
    return noErr;
}

static OSStatus stream_stop(CMIOStreamRef self) {
    fprintf(stderr, "[vcam] Stream stopped\n");
    return noErr;
}

static OSStatus stream_copy_buffer(CMIOStreamRef self, CMSampleBufferRef *sample_buffer,
                                    CMTime *frame_time) {
    pthread_mutex_lock(&g_frame_mutex);

    if (!g_current_frame) {
        pthread_mutex_unlock(&g_frame_mutex);
        return kCMIOHardwareNotReadyErr;
    }

    // Create a new CVPixelBuffer reference for this consumer
    CVPixelBufferRef frame = g_current_frame;
    CFRetain(frame);

    // Create CMFormatDescription for the frame
    CMFormatDescriptionRef format_desc = NULL;
    CMVideoFormatDescriptionCreateForImageBuffer(
        kCFAllocatorDefault,
        frame,
        &format_desc
    );

    // Create timing info
    CMSampleTimingInfo timing;
    timing.duration = CMTimeMake(1, DEFAULT_FPS);
    timing.presentationTimeStamp = g_frame_time;
    timing.decodeTimeStamp = kCMTimeInvalid;

    // Create the sample buffer
    OSStatus status = CMSampleBufferCreateReadyWithImageBuffer(
        kCFAllocatorDefault,
        frame,
        format_desc,
        &timing,
        sample_buffer
    );

    if (frame_time) *frame_time = g_frame_time;

    CFRelease(format_desc);
    CFRelease(frame);

    pthread_mutex_unlock(&g_frame_mutex);

    return status;
}

// ─── Plugin Entry Point ───────────────────────────────────────────

static OSStatus StreamCamVirtualCam_Initialize(CMIOComponentPluginInterfaceStruct **interface,
                                                CFAllocatorRef allocator,
                                                CFUUIDRef requestedType) {
    static CMIOComponentPluginInterfaceStruct vtable = {
        // IUnknown
        NULL, // QueryInterface
        NULL, // AddRef
        NULL, // Release
        // Plugin
        plugin_init,
        plugin_initialize,
        plugin_finalize,
        plugin_get_class_id,
        plugin_get_factory,
        // Device
        device_query_interface,
        device_add_device_bulk,
        device_get_device_at_index,
        // Stream
        stream_query_interface,
        stream_get_class_id,
        stream_get_property_info,
        stream_get_property_data,
        stream_start,
        stream_stop,
        stream_copy_buffer,
    };

    *interface = &vtable;
    fprintf(stderr, "[vcam] StreamCam Virtual Camera plugin loaded\n");
    return noErr;
}

// ─── Shared Library Entry Point ───────────────────────────────────
// CoreMediaIO looks for a function named "StreamCamVirtualCam_Initialize"
// in the DAL plugin bundle. The function name must match the plugin filename.

__attribute__((visibility("default")))
OSStatus StreamCamVirtualCam_Initialize(CMIOComponentPluginInterfaceStruct **interface,
                                         CFAllocatorRef allocator,
                                         CFUUIDRef requestedType) {
    static CMIOComponentPluginInterfaceStruct vtable = {
        NULL, NULL, NULL,
        plugin_init,
        plugin_initialize,
        plugin_finalize,
        plugin_get_class_id,
        plugin_get_factory,
        device_query_interface,
        device_add_device_bulk,
        device_get_device_at_index,
        stream_query_interface,
        stream_get_class_id,
        stream_get_property_info,
        stream_get_property_data,
        stream_start,
        stream_stop,
        stream_copy_buffer,
    };

    *interface = &vtable;
    fprintf(stderr, "[vcam] StreamCam Virtual Camera DAL plugin loaded\n");
    return noErr;
}
