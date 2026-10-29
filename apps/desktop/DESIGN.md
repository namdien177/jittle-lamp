# Jittle Lamp for macOS — native desktop app

The desktop app is a native GPUI app written in Rust; it replaced the Electron companion. macOS
(15+, Apple Silicon) is the first platform. This document is the contract between the crates and
the design spec for the interface.

Toolchain: rustup stable (≥ 1.95; GPUI uses `std::hint::cold_path`). Homebrew's `rustc` is too
old, so run cargo as `PATH="$HOME/.cargo/bin:$PATH" cargo …` (`rust-toolchain.toml` pins stable).
WebM playback links a static libvpx: Homebrew's in development, `crates/jl-media/scripts/build-libvpx.sh`
(macOS 15 target) for releases, which `scripts/bundle.sh` runs.

```bash
bun run --cwd apps/desktop dev      # cargo run (JITTLE_LAMP_HOME=<dir> to use another config folder)
bun run --cwd apps/desktop test     # cargo test --workspace
bun run --cwd apps/desktop bundle   # signed "Jittle Lamp.app" (JL_SIGN_IDENTITY, ad-hoc by default)
cargo run -p jl-app -- --demo       # mock data; add --snapshot out.png with --features snapshot
```

Capture, notifications and launch-at-login belong to the bundle's signed identity: test them from
the `.app`, not `cargo run`.

## Crates

```
crates/
  jl-core     pure Rust: archive model, config, SQLite library, companion HTTP server, zip, timeline
  jl-api      blocking HTTP client for the backend: device sign-in, Keychain token, orgs, evidence, sync, test runs
  jl-capture  macOS: ScreenCaptureKit screen/window/app recording, unified-log capture, input events
  jl-media    macOS: video playback to CVPixelBuffer (AVPlayer for mp4/mov, libvpx for VP8/VP9 WebM), thumbnails
  jl-macos    macOS: menu bar extra, global hotkeys (Carbon), notifications, Trash, login item, app icons
  jl-intelligence  on-device title/description suggestions: a Swift helper (FoundationModels + Vision OCR), heuristic fallback
  jl-app      the GPUI application (binary `jittle-lamp`)
```

Rules shared by every crate:

- No async runtime. Every library API is **blocking and `Send + Sync`**; the app calls it from
  `cx.background_executor().spawn(...)`. Long-running work (recording, companion server, log
  streams) runs on owned `std::thread`s and reports through `crossbeam_channel` senders.
  Exceptions, because AppKit/AVFoundation objects are main-thread only: `jl_media::Player`
  (open the `MediaSource` in the background, then `Player::from_source` on the main thread) and
  `jl_macos`'s `StatusItem`/`Hotkeys`.
- GPUI's Metal renderer accepts one surface format, `420f` (NV12 full range, BT.601); every
  `CVPixelBuffer` handed to `surface()` must be that.
- Errors are `anyhow::Result` at crate boundaries.
- On-disk formats stay **compatible with the extension and existing installs**: same
  `~/.jittle-lamp/companion.json`, same `~/.jittle-lamp/sessions.db` schema, same session folder
  layout `<outputDir>/<sessionId>/{recording.webm|recording.mp4, session.archive.json}`, same
  companion HTTP protocol on `127.0.0.1:48115`.
- `CVPixelBuffer` values cross crate boundaries as `objc2_core_foundation::CFRetained<objc2_core_video::CVPixelBuffer>`
  (objc2-core-video 0.3, the version GPUI's `surface()` element takes).

## Session archive

`packages/shared/src/session.ts` is the source of truth (schema v5; v3 and v4 upgrade on parse).
`jl-core::archive` mirrors it with serde. Native recordings add:

- recorder `{ "kind": "desktop-recorder", "recorder": { "name": "jittle-lamp-desktop", "version", "os", "source": { "type": "display" | "window" | "application", "name", "bundleId"?, "pid"? } } }`
- artifact kind `"recording.mp4"` (mimeType `video/mp4`)
- `page.url` is `app://<bundle id>` for app/window captures and `screen://display/<id>` for displays;
  `page.title` is the app or display name.
- console entries come from the captured app's unified log (`log stream --style ndjson`);
  actions are clicks, shortcut keys (never typed text), app/window switches and user markers.
- markers are `lifecycle` actions (phase `recording`, detail = label) tagged `marker`.

## Design

The web workspace (`apps/evidence-web/src/index.css`) supplies the palette: neutral greys,
hairline borders, brand green as the only accent. The desktop app is the same product with
macOS manners, built for being open all day.

### Surfaces

- Flat colour only. **No gradients**, anywhere (a test in `jl-app` enforces it). Colour comes from
  content: app icons, video frames, status badges. Depth comes from one hairline border and, for
  floating panels, a soft shadow.
- The palette is the web workspace's; brand green is the only accent, system red means recording.

### Everyday surface: the quick recorder

The app lives in the menu bar (`LSUIElement`, no Dock icon). Clicking the icon or pressing ⌥⇧R
opens the quick recorder under it: source tabs, type-to-filter list (last used first), capture
toggles, Record. ⏎ records; a second ⌥⇧R records straight away; ⌥⇧R while recording stops. When a
recording stops the same panel shows the saved card — title and description pre-filled on device
(Apple Intelligence when available), Copy link, Review, Done. The full window (and the Dock icon)
appears only for Library/Review/Settings, and closing it returns the app to the menu bar.

### Shell

- One window, transparent title bar with traffic lights inset at (16, 18); the window background is
  `Blurred` so the sidebar reads as vibrant material over the desktop. Content panes are opaque.
- Sidebar (232 pt): Record ⌘1 · Library ⌘2 · Cloud ⌘3 · Test runs ⌘4 · Logs ⌘5, Settings ⌘, at the
  bottom with the account chip and a companion status line ("Extension connected").
- Menu bar extra (status item) with Start/Stop recording, the last three sessions and Open.
  Global shortcut ⌥⇧R starts or stops a recording from anywhere.
- Command palette ⌘K: jump to any page, session or action. No open/close animation.

### Recording

- Record page: source picker as three large cards (Entire screen · Window · App) with live
  thumbnails, then toggles (system audio, microphone, show clicks, capture app logs, capture
  shortcuts). One primary button, red, `Start recording` with its shortcut shown.
- While recording, a floating HUD pill (PopUp window, blurred): pulsing red dot, tabular timer,
  live counters (clicks · logs · errors), Marker (⌘⇧M), Stop. The main window gets out of the way.
- On stop, the session is indexed and the viewer opens on it; a toast offers Upload.

### Review

- Viewer: video on the left with a hairline control bar (play, time, rate, copy frame), a timeline
  under it with lanes for actions, network, console errors and markers; the playhead tracks the
  pointer 1:1 while scrubbing. Inspector on the right with tabs Actions · Network · Console ·
  Notes; the row at the playhead stays highlighted and in view; clicking a row seeks.
- Network detail: method, status, timing, headers, bodies (JSON pretty-printed).
- Library: dense list (thumbnail, name, source, duration, counts, size, sync state), search, tag
  filter, keyboard-first (↑↓, ⏎ open, Space preview, ⌘⌫ delete with undo toast).

### Motion

From Apple's *Designing Fluid Interfaces* and Emil Kowalski's rules:

- Springs, not durations, for anything spatial: `damping 1.0, response 0.3` by default; `0.8 / 0.35`
  only after a gesture with momentum. Springs retarget from their current value and velocity, so
  every motion is interruptible.
- Never animate keyboard-driven changes (page switches by shortcut, list navigation, palette).
- Press feedback on mouse-down, not release. Enter ease-out, exits faster than entries.
- Panels leave along the path they entered. Popovers grow from their trigger.
- Reduce Motion (NSWorkspace) swaps movement for short cross-fades.
