#!/usr/bin/env bash
set -euo pipefail

ADB="${ANDROID_HOME:-${HOME}/Library/Android/sdk}/platform-tools/adb"
if [[ ! -x "${ADB}" ]]; then
  ADB="$(command -v adb)"
fi

if ! "${ADB}" get-state >/dev/null 2>&1; then
  printf 'No Android emulator or device is connected. Check `adb devices`.\n' >&2
  exit 1
fi

# Rust panics/logs, Android crashes, Chromium, WebView console messages, and app activity.
exec "${ADB}" logcat -v threadtime | grep --line-buffered -E \
  'RustStdoutStderr|AndroidRuntime|DEBUG|chromium|Tauri/Console|app_lib|com\.nissenhooper\.throughhoops'
