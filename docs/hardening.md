# Hardening plan: signaling security, data layer, Android fixes

Written 2026-11-16 for handoff to an implementing agent. Read this whole file
before starting.

## Context

through-hoops is a P2P video-call app built with Tauri v2. It has a React 19 /
TypeScript frontend in `src/` and a Rust backend in `src-tauri/src/`.

- **Signaling** (ring, offer, answer, ICE candidates, hangup) travels over
  **iroh** QUIC connections. See `src-tauri/src/signaling.rs` and
  `src/services/signaling.ts`.
- **Media** travels over **WebRTC** inside the webview. See
  `src/views/ActiveCall.tsx`.
- **Contacts and profile** are stored in SQLite. JS uses `tauri-plugin-sql`
  (`src/services/db.ts`) and Rust uses `sqlx` (`src-tauri/src/db.rs`), and both
  point at the same file.
- **Contacts are added by node ID** with `perform_handshake`. Each side sends
  its name and avatar, and the receiver saves the sender as a contact
  automatically.

The project's core value is **P2P without a middle server we operate**. Do not
add TURN or any hosted relay. That decision is open and out of scope here.

## Ground rules

- Create a branch, e.g. `hardening`. Commit Phase 0 first, then make **one
  commit per task** below, with the task number in the message.
- Before every commit, run these and make sure they pass:
  - `pnpm build`, which runs `tsc -b` and `vite build`
  - `pnpm lint`
  - `cd src-tauri && cargo test && cargo clippy --all-targets`
- Keep the iroh wire protocol (`SIGNALING_ALPN`) backward compatible unless a
  task says otherwise. Two installs running different builds must still be able
  to call each other.
- Don't refactor beyond each task's scope. If you find something else, add it to
  "Found during implementation" at the bottom of this file.
- `React.StrictMode` is on (`src/main.tsx`). Every effect must survive mount,
  unmount and remount, and every async `listen()` must handle the effect being
  torn down before it resolves. Follow the `disposed` pattern already in
  `App.tsx`.

---

## Phase 0: Land the connectivity fixes

**0.1** Do a manual verification pass and record the results in the PR
description.

- Use Android **release or emulator builds** for this. `tauri android dev` on a
  physical device serves the app from `http://<lan-ip>:5173`, which is not a
  secure context, so `navigator.mediaDevices` is undefined and the camera won't
  work.
- Collect logs with `pnpm android:logs` on Android and the devtools console on
  the Mac. Filter for `[DEBUG-ice]` and `[WebRTC]`.

| # | Caller             | Callee           | Network    | Expected                                                            |
| - | ------------------ | ---------------- | ---------- | ------------------------------------------------------------------- |
| a | Mac                | Mac              | same Wi-Fi | connects                                                            |
| b | Android            | Mac              | same Wi-Fi | connects                                                            |
| c | Mac                | Android          | same Wi-Fi | connects                                                            |
| d | Android (cellular) | Mac (home Wi-Fi) | different  | record the result; failure with symmetric NAT is a known limitation |

If (b) or (c) fail, stop and report the `[DEBUG-ice]` pair lines before doing
anything else.

---

## Phase 1: Signaling security (highest priority)

### 1.1 Forward the authenticated sender from Rust

**Problem:** the Rust accept loop emits the raw JSON payload, and the frontend
trusts the self-declared `signal.sender`. Rust already knows the authenticated
peer from `connection.remote_id()` but throws it away. Any peer can therefore
forge a `hangup` or `ring` "from" one of your contacts.

**Change (Rust, `signaling.rs`):**

- Define
  `#[derive(Serialize, Clone)] struct IncomingSignal { from: String, payload: String }`.
- In the bi-stream branch of `SignalingProtocolHandler::accept` and in
  `forward_uni_signal`, emit `IncomingSignal { from: <remote_id>, payload }` on
  `incoming_signal` instead of the bare string.
- `from` must be `connection.remote_id().to_string()`. That's the same format
  `get_my_node_id` returns, so the frontend can compare the two directly.
- Update the test `uni_signal_emits_incoming_call_event`. It should assert both
  the payload and that `from == sender.id().to_string()`. Pass the real remote
  ID into `forward_uni_signal` in the mock handler instead of `"test-peer"`.

**Change (TS):**

- In `src/services/signaling.ts`, change `listenForIncomingSignals` so its
  callback receives a parsed `SignalMessage`.
  - Parse `event.payload.payload` as JSON.
  - **Overwrite** `signal.sender = event.payload.from`.
  - Silently drop payloads that aren't valid JSON or have no `type`. Log at
    debug level.
  - In browser-preview mode, keep the current no-op.
- Update the three call sites: `App.tsx`, and the two listeners in
  `ActiveCall.tsx`. Each currently parses JSON itself; remove that and use the
  parsed signal.
- Keep putting `sender` in outgoing payloads so older builds keep working.
  Receivers must ignore it.

**Wire compatibility:** unchanged. The envelope only exists between Rust and JS.

**Acceptance:**

- A unit or integration test shows that `from` is the authenticated ID even when
  the payload claims a different `sender`.
- Every frontend routing decision uses only the overwritten `sender`.

### 1.2 Make ActiveCall accept signals only from the current peer

**Problem:** the main signal handler in `ActiveCall.tsx` applies an offer,
answer or candidate from **any** peer to the live `RTCPeerConnection`. The
separate hangup listener already checks the sender.

**Change:**

- In the main listener, drop any signal whose `sender` doesn't match
  `remoteNodeIdRef.current`, comparing case-insensitively.
- For the callee, `remoteNodeIdRef` is always set from the `contact` prop, since
  `App.handleAcceptIncomingCall` builds the contact from `incomingCall.nodeId`.
  You can therefore remove the "adopt sender if no remote ID yet" branch in
  `handleSignalMessage`. If you keep it, document why.
- In `App.tsx`, while an incoming call is pending, ignore `ring`/`offer` from a
  **different** peer instead of replacing the pending call. Optionally,
  auto-decline the second caller with a `hangup` of reason `busy`. That needs a
  new `HangupReason` added in `src/types/signaling.ts`, and older clients will
  simply treat it as a hangup.
- Also ignore `ring`/`offer` while `currentView === 'active-call'`. That check
  exists today; keep it.

**Acceptance:** a candidate or offer from a third node ID during a call is
logged and dropped. Add a small pure helper, e.g. `isFromPeer(signal, peerId)`,
and unit-test it if Phase 4.3 test tooling exists by then.

### 1.3 Limit what inbound handshakes can do

**Problem:** every inbound handshake calls `save_incoming_contact`, which
upserts the contact and writes a new `contact-<uuid>` avatar file of up to 5 MB
(`avatar.rs`, around line 132). The old file is never deleted, and
`removeContact` (`db.ts:159`) doesn't delete it either. A remote peer can fill
the disk by handshaking in a loop.

**Change:**

- **Deterministic avatar filename.** Save as `contact-<node_id>.<ext>`.
  - Write to a temporary file in the same directory, then rename it into place.
  - If a file for the same node ID exists with a different extension, delete it.
  - Apply this to both `save_incoming_contact` and the reply path in
    `perform_handshake`.
- **Per-peer rate limit.** Keep an in-memory `HashMap<EndpointId, Instant>` in
  `SignalingState`, or in the handler behind a `Mutex`.
  - Ignore any handshake that arrives within 10 s of the previous one from the
    same peer, but still reply, so the caller's `perform_handshake` doesn't
    hang.
  - Cap total inbound handshakes at about 30 per minute.
- **Delete avatars on contact removal.** Add a Rust command
  `remove_contact(node_id)` that deletes the row **and** the avatar file. Change
  `removeContact` in `db.ts` to call it in Tauri. This depends on 2.1's shared
  pool; if 2.1 isn't done yet, use `get_sqlite_pool`.
- **Clean up existing orphans.** On startup, delete any `avatars/contact-*` file
  that no contact row references. Run it best-effort, after migrations, and log
  the count.
- **Product question, don't implement:** should an unknown peer's handshake
  require user approval instead of auto-adding the contact? Leave a
  `// TODO(product)` comment at `save_incoming_contact` and list it in the PR
  description.

**Acceptance:**

- Looping 100 handshakes from one peer leaves exactly one avatar file for that
  peer.
- Removing a contact deletes its avatar.

### 1.4 Set a CSP and restrict `photo_path`

**Problem:** `tauri.conf.json` has `"csp": null`. Separately,
`save_local_profile` (`db.rs`, around line 90) accepts any `photo_path` from JS,
and `load_local_avatar` later reads that path and sends it to every peer.
Together they let any injected script exfiltrate local files.

**Change:**

- **Restrict `photo_path`.** In `save_local_profile`, canonicalize the path and
  reject it unless it lies inside `app_data_dir()/avatars`. Do the same check in
  `load_local_avatar`, as defense in depth.
- **Set a real CSP.** Start from:
  ```
  default-src 'self'; img-src 'self' asset: http://asset.localhost data: blob:;
  media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline';
  connect-src 'self' ipc: http://ipc.localhost
  ```
  - Verify it in `pnpm tauri dev` (Vite HMR), in a macOS build, and in an
    Android build.
  - Avatars load through the asset protocol. Check that `convertFileSrc` URLs
    render on both platforms. The Android asset host differs, so watch the
    console for CSP violations and adjust.
  - Don't add `'unsafe-eval'`.

**Acceptance:**

- No CSP violations in the console during a full call on macOS and Android.
- `save_local_profile` with `photo_path = "/etc/hosts"` returns an error.

---

## Phase 2: Data layer correctness

### 2.1 One SQLite owner

**Problem:** `db.rs::get_sqlite_pool` opens a **new pool on every call**,
without `create_if_missing`. Meanwhile the tables are created only by plugin-sql
migrations, which run when JS calls `Database.load` (`db.ts:72`). On a fresh
install, an inbound handshake or `get_local_profile` that runs before JS loads
the DB fails with "unable to open database" or "no such table", and the contact
is lost. Two independent pools writing to one file also invite `SQLITE_BUSY`.

**Change (do this part):**

- At `setup` in `lib.rs`, before `init_node`, create **one** `SqlitePool`.
  - Use
    `SqliteConnectOptions::new().filename(path).create_if_missing(true).journal_mode(Wal).busy_timeout(5s)`.
  - Store it in managed state, e.g. `struct Db(SqlitePool)`.
  - Make `db.rs` functions take `&SqlitePool` or `State<Db>` instead of opening
    their own pool.
- In Rust at startup, run the same `CREATE TABLE IF NOT EXISTS` statements as
  the plugin-sql migrations in `lib.rs`.
  - They're idempotent, and they don't touch the plugin's `_sqlx_migrations`
    bookkeeping. **Do not** run a sqlx `Migrator` with the same version numbers:
    that table is shared with plugin-sql, and checksum mismatches will break
    startup.
  - Move the SQL strings into shared `const`s so both registrations use
    identical text.
- **Check the path first.** Confirm that plugin-sql resolves
  `sqlite:contacts.db` to `app_config_dir()/contacts.db`, the same path as
  `db::get_db_path`, by reading the `tauri-plugin-sql` source in
  `~/.cargo/registry`. If the paths differ, stop and report.

**Optional follow-up, out of scope unless trivial:** move all contact CRUD into
Rust commands, drop plugin-sql, and remove `sql:allow-execute` from
`capabilities/default.json`.

**Acceptance:** after deleting the app data and launching, an inbound handshake
that arrives before the UI loads saves the contact.

### 2.2 Stop silently falling back in `db.ts`

**Problem:** in `db.ts` (around lines 172–230), a failed `invoke` makes profile
load and save fall back to plugin-sql and then to `localStorage`, and save also
writes to `localStorage`. Real errors are hidden, and the UI can show a profile
that differs from the one Rust sends to peers.

**Change:**

- When `isTauriEnvironment()` is true, use only the Rust command and throw its
  error. The callers in `ProfileModal.tsx` and `Home.tsx` must surface it in the
  existing error and status UI.
- Keep `localStorage` only for browser preview.

### 2.3 Timestamps

**Problem:** SQLite's `CURRENT_TIMESTAMP` produces UTC with no zone
(`YYYY-MM-DD HH:MM:SS`), and `new Date()` parses that as local time. See
`ContactCard.tsx:39`, `Home.tsx:165` and the `UPDATE ... CURRENT_TIMESTAMP` in
`db.ts:154`.

**Change:**

- Add `parseDbTimestamp(s)` in `src/utils/time.ts`. If the string matches
  `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`, convert it to `YYYY-MM-DDTHH:MM:SSZ`;
  otherwise pass it to `new Date`.
- Use the helper everywhere a DB timestamp is parsed.
- No schema migration.

### 2.4 Android avatar picker

**Problem:** `src/services/avatar.ts` (around line 20) validates the image by
the file extension of the picked path. On Android the dialog returns
`content://` URIs, which have no extension, so picking an avatar always fails.

**Change:**

- Validate by content instead.
- Preferred approach: add a Rust command
  `import_local_avatar(source: String) -> String`.
  - It reads the bytes and caps the size, reusing the existing 5 MB constant.
  - It detects the type with the existing `detect_image_type` in `avatar.rs`.
  - It writes `avatars/profile.<ext>` atomically and returns the path.
- On Android, reading a `content://` URI from Rust may need `tauri-plugin-fs`'s
  Rust API rather than `std::fs`. Check what `tauri_plugin_fs::FsExt` supports.
- Fallback approach: read with `readFile` from `@tauri-apps/plugin-fs` in JS,
  which handles content URIs, sniff the magic bytes in JS, and write with
  `writeFile`.

**Acceptance:** you can pick an avatar from the Android photo picker, and a
renamed non-image file is rejected.

---

## Phase 3: Robustness

### 3.1 Handshake timeouts and the connection pool

- In `perform_handshake`, wrap `connect`, `open_bi` and the response read in a
  timeout of about 15 s total. Return a clear error.
- Reuse `get_or_create_connection` instead of dialing a fresh connection.
- `SIGNAL_TIMEOUT` is currently 3 s for the first dial. A first contact across
  networks goes through discovery and the n0 relay, and can easily exceed 3 s on
  cellular.
  - Use a separate `DIAL_TIMEOUT` of about 10 s for `connect`.
  - Keep 3 s for `open_bi` on an existing connection.
  - This may by itself fix some "can't reach peer" reports from different
    networks.

### 3.2 Don't crash on node init failure

`lib.rs` setup calls `.expect("failed to initialize ...")`, so if iroh or mDNS
fails to start, the app crashes on launch.

- If mDNS lookup init fails, log it and continue without local discovery.
- If the endpoint bind fails, start the app anyway with the signaling state
  marked unavailable, e.g. `Option`/`RwLock<Option<…>>`.
  - Signaling commands then return the error "Networking unavailable: …".
  - `Home.tsx` shows a banner.

### 3.3 Out-of-order responses in Home

`fetchContacts` in `Home.tsx` (around line 49) can show stale results when a
manual refresh and a `contacts_changed` event overlap.

- Add a request counter ref, and apply a result only if it came from the latest
  request.

### 3.4 Dead code

- In `AddContactModal.tsx` (around line 68), remove the "UNIQUE constraint"
  error branch. `insertContact` is an upsert, so it can't fire.
- The uni-stream signaling path is only exercised by tests, since `send_signal`
  uses bi streams. Keep it, because it's harmless and receive-compatible, but
  add a comment saying it exists for compatibility.

---

## Phase 4: Tooling and config

### 4.1 TypeScript strict mode

- Add `"strict": true` to `tsconfig.app.json` and `tsconfig.node.json`.
- Fix the resulting errors properly, without `any` or `!` unless it's justified
  with a comment.

### 4.2 Android release signing

In `src-tauri/gen/android/app/build.gradle.kts` (lines 29–59), a missing
`keystore.properties` makes the release build come out unsigned without any
error.

- Fail the build when a **release** task runs without `keystore.properties`.
- Load the properties with
  `FileInputStream(f).use { keystoreProperties.load(it) }`.
- Note that `gen/android` is generated but committed. Edit it in place.

### 4.3 Frontend test harness

- Add `vitest` as a dev dependency and a `"test": "vitest run"` script.
- Cover the following:
  - the candidate buffer in `signaling.ts`: buffer, take, clear, and
    case-insensitive keys
  - `parseDbTimestamp`
  - the `isFromPeer` helper from 1.2
  - the envelope parsing in `listenForIncomingSignals`, by mocking
    `@tauri-apps/api/event`

### 4.4 Vite config

In `vite.config.ts`, add `clearScreen: false` and
`server.watch.ignored: ['**/src-tauri/**']`, as the Tauri template does.

### 4.5 Apple local network

- Find the mDNS service type that `iroh-mdns-peer-lookup` advertises; grep its
  source in `~/.cargo/registry/src/*/iroh-mdns-peer-lookup-*`.
- Add it to `NSBonjourServices` in `src-tauri/Info.plist`, and make sure
  `NSLocalNetworkUsageDescription` is present.

### 4.6 Template leftovers

- Replace the Vite template `README.md` with a short project README covering
  what the app is, how to run on desktop and Android, and the note about Android
  dev builds and secure contexts.
- `package.json` `name` → `through-hoops`.
- `Cargo.toml` `description` and `authors`.

---

## Explicitly out of scope

- TURN, hosted relays, or carrying media over iroh. That's a pending product
  decision about connections across strict NATs.
- Requiring approval for inbound contacts. Leave the TODO from 1.3.
- UI redesigns.

## Deliverable

- A branch with one commit per task, in phase order.
- A PR description that lists each task with :white_check_mark:, :warning:
  (partial, with reason) or
  :black_right_pointing_double_triangle_with_vertical_bar: (skipped, with
  reason), includes the Phase 0.2 device test matrix results, and lists anything
  recorded below.

## Found during implementation

_(implementing agent: append here)_

### Phase 0

- **Android 17 local network protection broke same-Wi-Fi calls.** The app
  targets SDK 37. Without the runtime permission
  `android.permission.ACCESS_LOCAL_NETWORK`, every UDP send to a LAN peer fails
  with error 103, and ICE never leaves `checking`. Signaling still worked,
  because iroh fell back to its relay. Fixed by declaring the permission in
  `AndroidManifest.xml` and requesting it at launch in `MainActivity.kt`. If the
  user denies it, same-Wi-Fi calls fail silently. A UI hint for that case is not
  implemented.
- **Remote video was invisible on Android.** The remote container used `h-full`
  inside a flex column with no definite height. The Android webview, which is
  Chromium-based, collapsed it to zero height once the placeholder was removed.
  WebKit on macOS rendered it fine. Fixed by making the container
  `absolute inset-4`.
- **A failed call left the peer hanging.** On `connectionState === 'failed'`,
  ActiveCall cleaned up without sending `hangup`. It now sends one, reusing the
  existing reasons.
- **No ICE pairs were logged on failure.** Chromium remaps ICE `failed` to
  `disconnected` and discards the pairs. The app now logs pairs on connection
  failure, and also as `still-checking` after 10 s in `checking`.
- **The note about `tauri android dev` in Phase 0 is out of date.** With Tauri
  CLI 2.12, mobile dev serves the app from `http://tauri.localhost`, proxied to
  the dev server, not from `http://<lan-ip>:5173`. The desktop `tauri dev` and
  `tauri android dev` can't run at the same time because both need port 5173
  (`strictPort`). Phase 0 testing used `tauri android build --apk --debug`.
- **Phase 0 results.** (a) was not re-run; it is known to work. (b) and (c)
  connect over the LAN once the permission is granted. (d) and (e) connect over
  cellular, but (d) failed once out of three runs, which fits the known
  carrier-NAT limitation.

### Phases 1–2

- **Status (1.1–2.4 done).** Everything below needs device testing that
  hasn't been done yet:
  - **1.4 CSP:** a full call on a macOS build and on an Android build, watching
    for `[CSP]` console warnings. `src/main.tsx` now logs every violation.
  - **2.1:** an inbound handshake on a fresh install, before the UI loads.
  - **2.4:** picking an avatar from the Android photo picker.
- **The CSP never applies in dev.** Tauri adds it only to assets served
  through its own protocol. Desktop `tauri dev` loads the Vite URL directly,
  and the mobile dev proxy adds no CSP header (`tauri` 2.12.5,
  `protocol/tauri.rs`). It can only be verified in built apps, and no
  `devCsp` is needed.
- **The 2.4 profile avatar filename differs from the plan.** It's
  `profile-<uuid>.<ext>`, not `profile.<ext>`. A fixed name keeps the same
  asset URL, so the webview shows the cached picture, and it would overwrite
  the saved avatar before the user presses Save. Stale profile files are
  deleted after a successful save.
- **Contact avatars can show a cached image.** `contact-<node_id>.<ext>`
  keeps the same URL when a contact changes their picture, so the webview may
  show the old one until the app restarts. This is minor and not fixed.
- **Unused dependency.** `@tauri-apps/plugin-fs` in `package.json` is no longer
  imported by JS. The Rust crate is still needed for `import_local_avatar`.
- **Busy reply.** 1.2 replies `busy` only while an incoming call is pending.
  During an active call, a second caller's ring is still ignored silently, as
  before, so that caller waits until their own call times out.
- **Formatting.** `cargo fmt --check` fails on code that was already there,
  such as `build.rs`. Only the files changed in this branch were formatted.
