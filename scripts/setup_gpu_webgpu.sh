#!/usr/bin/env bash
# Rebuild the WebGPU-on-NVIDIA test environment after a container relaunch.
#
# Everything below the container's persistent disk (/workspace, /home/claude)
# resets on relaunch: apt-installed libs, the Vulkan ICD json, device-node
# perms, Xvfb. Only the operator-side `--device /dev/nvidia-modeset` at
# `docker run` persists (via the launch config) -- without it the NVIDIA
# Vulkan driver returns VK_ERROR_INITIALIZATION_FAILED and this script's
# vulkaninfo check fails loudly.
#
# The load-bearing, non-obvious fact: the NVIDIA Vulkan ICD links libX11 and
# refuses to initialize without a live X display (negotiate -> -3 headless).
# So we run Xvfb and export DISPLAY. Headed Chrome under that Xvfb is the only
# config that yields a working WebGPU adapter+device+pixel (headless Chrome
# tears the WGPU instance down).
#
# Usage:  source scripts/setup_gpu_webgpu.sh    # exports DISPLAY etc. into shell
set -u

echo "== 1. GPU device visible =="
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || { echo "NO GPU -- relaunch with --gpus"; return 1 2>/dev/null || exit 1; }

echo "== 2. modeset node openable (operator --device /dev/nvidia-modeset) =="
python3 -c "import os;os.close(os.open('/dev/nvidia-modeset',os.O_RDWR));print('  modeset OK')" \
  || { echo "  modeset BLOCKED -- relaunch with: --device /dev/nvidia-modeset"; return 1 2>/dev/null || exit 1; }

echo "== 3. Vulkan loader + tools + X/EGL libs =="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq libvulkan1 vulkan-tools \
  libxext6 libx11-6 libxcb1 libxau6 libxdmcp6 libegl1 xvfb x11-utils >/dev/null

echo "== 4. NVIDIA Vulkan ICD json =="
sudo mkdir -p /usr/share/vulkan/icd.d
echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}' \
  | sudo tee /usr/share/vulkan/icd.d/nvidia_icd.json >/dev/null

echo "== 5. DRM render node perms (NVIDIA EGL path warns without it) =="
[ -e /dev/dri/renderD128 ] && sudo chmod 666 /dev/dri/renderD128

echo "== 6. Xvfb display + runtime dir =="
export XDG_RUNTIME_DIR=/tmp/xdg-claude
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export DISPLAY=:99
# Pin the NVIDIA ICD so software llvmpipe doesn't win adapter selection.
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d/nvidia_icd.json
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json

# NOTE: feed grep via a here-string, never `vulkaninfo | grep -q`. With grep -q
# closing the pipe early, vulkaninfo dies on SIGPIPE and — under `set -o
# pipefail` in a caller (e.g. run_all_tests.sh) — the pipeline reports failure
# even when the GPU IS listed. Capturing first avoids that.
_gpu_seen() {
  local o; o="$(vulkaninfo 2>/dev/null || true)"
  grep -q "deviceName.*Quadro\|deviceName.*NVIDIA" <<<"$o"
}
_gpu_line() {
  local o; o="$(vulkaninfo 2>/dev/null || true)"
  grep -m1 "deviceName.*Quadro\|deviceName.*NVIDIA" <<<"$o" || true
}
_start_xvfb() { Xvfb :99 -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 & sleep 2; }

# A pre-existing :99 can be alive to xdpyinfo yet broken for Vulkan (stale from a
# prior session). Don't trust xdpyinfo — trust vulkaninfo. Start Xvfb if the GPU
# isn't visible, and if a stale server is in the way, replace it once.
if ! xdpyinfo -display :99 >/dev/null 2>&1; then _start_xvfb; fi

echo "== 7. verify Vulkan sees the discrete GPU =="
if ! _gpu_seen; then
  echo "  display present but Vulkan can't use it — restarting Xvfb :99"
  pkill -f "Xvfb :99" 2>/dev/null; sleep 1; _start_xvfb
fi
if _gpu_seen; then
  echo "  $(_gpu_line)"
else
  echo "  Vulkan did NOT enumerate the NVIDIA GPU"; return 1 2>/dev/null || exit 1
fi

echo "== 8. real Chrome for WebGPU (bundled chromium compiles WebGPU out) =="
which google-chrome-stable >/dev/null 2>&1 || {
  wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y -qq /tmp/chrome.deb >/dev/null
}
google-chrome-stable --version

cat <<'EOF'

WebGPU env ready. DISPLAY=:99, NVIDIA ICD pinned, Chrome installed.
Drive WebGPU with playwright: channel="chrome", headless=False,
ignore_default_args=["--disable-gpu"], args include
--enable-unsafe-webgpu --use-vulkan --no-sandbox, over a http://127.0.0.1
origin (navigator.gpu is hidden on opaque about:blank).
Smoke test: python scripts/webgpu_smoke.py  (expects pixel [64,128,192,255]).
EOF
