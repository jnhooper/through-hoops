# through-hoops

Peer-to-peer video calls with no server in the middle that we operate. Built
with [Tauri v2](https://v2.tauri.app/), a React 19 + TypeScript frontend, and a
Rust backend.

- **Signaling** (ring, offer, answer, ICE candidates, hangup) travels over
  [iroh](https://www.iroh.computer/) QUIC connections, in `src-tauri/src/signaling.rs`
  and `src/services/signaling.ts`.
- **Media** travels over WebRTC inside the webview (`src/views/ActiveCall.tsx`),
  using public STUN servers to find a direct path.
- **Contacts and your profile** live in a local SQLite database. Contacts are
  added by pasting a peer's node ID; the two sides exchange name and avatar.

There is deliberately no TURN or hosted relay for media. Calls between networks
behind strict (symmetric or carrier-grade) NATs may therefore fail to connect.

## Prerequisites

- Node.js and [pnpm](https://pnpm.io/)
- Rust (see `rust-version` in `src-tauri/Cargo.toml`)
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS
- For Android: Android Studio with the SDK and NDK, `ANDROID_HOME` set, and the
  Rust Android targets (`rustup target add aarch64-linux-android` and friends)

## Run on desktop

```sh
pnpm install
pnpm tauri dev
```

macOS may ask for camera, microphone and local network access (the usage
descriptions are in `src-tauri/Info.plist`). Allow them.

## Run on Android

Debug APK, which bundles the frontend and needs no dev server (this is what the
device testing in `docs/hardening.md` used):

```sh
pnpm tauri android build --apk --debug
# adb is in <Android SDK>/platform-tools
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
pnpm android:logs   # filter for [DEBUG-ice] and [WebRTC]
```

Live-reload development works with `pnpm tauri android dev`, with caveats:

- **Camera and microphone need a secure context.** If the page isn't one,
  `navigator.mediaDevices` is undefined and calls start without local media.
  Tauri's dev proxy serves the app from `http://tauri.localhost`, but this
  hasn't been verified for camera access on a physical device. If the camera
  doesn't work in dev mode, use the debug APK above.
- **Port 5173 is shared.** `vite.config.ts` uses `strictPort`, so
  `tauri android dev` and a desktop `tauri dev` can't run at the same time.
- **Android 17 and later** blocks LAN traffic for apps targeting SDK 37 until the
  user grants the local network permission. The app asks at launch. Without it,
  calls on the same Wi-Fi never connect (calls over cellular still can).

Release builds are signed with `src-tauri/gen/android/keystore.properties`
(`keyAlias`, `password`, `storeFile`; the file is git-ignored). A release build
without it fails on purpose instead of producing an unsigned APK.

## Checks

```sh
pnpm build                                        # tsc -b && vite build
pnpm lint
pnpm test                                         # vitest
cd src-tauri && cargo test && cargo clippy --all-targets
```

## Layout

| Path | What |
| --- | --- |
| `src/` | React app: `views/` (Home, ActiveCall), `components/`, `services/` (signaling, db, avatar) |
| `src-tauri/src/signaling.rs` | iroh node, signaling protocol, handshakes, rate limiting |
| `src-tauri/src/db.rs` | the single SQLite pool and profile/contact commands |
| `src-tauri/src/avatar.rs` | avatar validation and storage |
| `src-tauri/gen/android/` | generated Android project (committed; edit in place) |
| `docs/hardening.md` | the security and robustness plan, with findings |

The signaling protocol identifier (`SIGNALING_ALPN`) is part of the wire
format. Don't change it, or installs on different builds can't call each other.
