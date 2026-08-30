#!/usr/bin/env bash
#
# Alresia StreamCam — Virtual Camera Setup (Linux / v4l2loopback)
#
# A system-wide virtual camera needs an OS-level driver. On Linux that's
# v4l2loopback — a kernel module that creates a /dev/videoN device any
# app (Zoom, Meet, Teams, OBS...) can pick up like a real webcam. This
# script installs it, loads it, and labels the device so it's easy to
# find in your video app's camera list.
#
# macOS and Windows aren't supported yet — those need a signed
# CoreMediaIO/Camera Extension plugin or a DirectShow/Media Foundation
# filter respectively, which is a much bigger undertaking than a setup
# script (proper driver signing, installers, etc.). If you're on one of
# those platforms, OBS Studio's built-in Virtual Camera is currently
# the most practical alternative.

set -e

DEVICE_NUM="10"
DEVICE_PATH="/dev/video${DEVICE_NUM}"
LABEL="StreamCam Virtual Camera"

echo "Alresia StreamCam — Virtual Camera Setup"
echo "=========================================="
echo

if [ "$(uname)" != "Linux" ]; then
  echo "This script only supports Linux."
  echo "Virtual camera on macOS/Windows isn't available yet — see the note"
  echo "in this script's header for why, and consider OBS Studio's"
  echo "built-in Virtual Camera as a workaround in the meantime."
  exit 1
fi

if lsmod | grep -q "^v4l2loopback"; then
  echo "v4l2loopback is already loaded."
else
  echo "Installing v4l2loopback..."
  if command -v apt >/dev/null 2>&1; then
    sudo apt update
    sudo apt install -y v4l2loopback-dkms v4l-utils
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y v4l2loopback v4l-utils
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm v4l2loopback-dkms v4l-utils
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y v4l2loopback-kmp-default v4l-utils
  else
    echo "Could not detect apt, dnf, pacman, or zypper."
    echo "Install v4l2loopback manually for your distro, then re-run this script."
    exit 1
  fi

  echo
  echo "Loading the v4l2loopback kernel module..."
  sudo modprobe v4l2loopback video_nr="${DEVICE_NUM}" card_label="${LABEL}" exclusive_caps=1
fi

echo
echo "Checking for ${DEVICE_PATH}..."
if [ -e "${DEVICE_PATH}" ]; then
  echo "${DEVICE_PATH} is ready, labeled '${LABEL}'."
  echo "It should now show up as a camera option in Zoom, Meet, Teams, etc."
else
  echo "Could not find ${DEVICE_PATH}."
  echo "Try rebooting, or run 'v4l2-ctl --list-devices' to see what's available."
  exit 1
fi

echo
echo "To make this persist across reboots, run:"
echo
echo "  echo 'v4l2loopback' | sudo tee /etc/modules-load.d/v4l2loopback.conf"
echo "  echo 'options v4l2loopback video_nr=${DEVICE_NUM} card_label=\"${LABEL}\" exclusive_caps=1' | sudo tee /etc/modprobe.d/v4l2loopback.conf"
echo
echo "Done. Open the studio and click 'Virtual Cam' to start sending frames to it."
