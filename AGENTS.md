# AGENTS.md

Context for anyone (human or AI agent) changing this repo. Read this before editing; the
"Things that already cost time" section exists so nobody has to rediscover them.

## What this is

Watch2Gether is a Windows desktop app (Electron + mpv) for watching a **local video file**
together, in sync, over **Tailscale**. The host's PC serves the file over HTTP (range
requests, no re-encoding) and runs the room clock; every viewer plays it in their own mpv
and stays within ~50 ms. It also has Discord-style voice chat, an in-app player, auto-update,
and resume-after-update. There is no cloud server: the host's app is the server.

Users are friends sharing an installer; most changes should keep "it just works" for
non-technical people (clear messages, no extra setup).

## Layout

```
src/main/            Electron main process (Node)
  main.js            app lifecycle, window, IPC handlers, settings, wiring of everything below
  server.js          HostServer: HTTP file serving + WebSocket room (clock, members, chat, voice relay)
  session.js         Session: one per app in a lobby; connects to a HostServer, drives mpv to the room clock
  mpv.js             mpv process + JSON IPC over a named pipe
  videohost.js       in-app player: native BaseWindow kept over the stage; mpv draws into it (--wid); cursor auto-hide
  hotkeys.js         global push-to-talk / mute / deafen keys (polls GetAsyncKeyState via koffi)
  overlay.js         fullscreen play bar: a small transparent window floating over the video
  updater.js         electron-updater state machine (GitHub Releases)
  changelog.js       reads CHANGELOG.md sections (What's new + release notes)
  env.js             finds Tailscale and mpv, installs mpv via winget
  util.js            small pure helpers (invite parsing, address filters, cursor math)
  preload.js         the only bridge to the page: window.w2g API (contextIsolation, sandbox)
src/renderer/        the page (no bundler, classic <script>s sharing globals)
  index.html         all markup; CSP: script-src 'self' 'wasm-unsafe-eval'
  app.js             screens, lobby, player chrome, volume, fullscreen, drag & drop, resume, What's new
  overlay.html/.js/.css  the fullscreen play bar's own page (same preload / window.w2g API)
  voice.js           VoiceEngine: mic -> noise model -> gate -> Opus (WebCodecs) and back
  voice-worklets.js  AudioWorklets: 20 ms capture frames, jitter-buffered playback
  voice-ui.js        voice bar, member decorations/menu, Voice & Audio settings, hotkeys, ducking
  styles.css         the whole look (dark, Apple-style)
test/                see "Tests"
scripts/             start.js (dev launcher), release-notes.js (CI)
.github/workflows/release.yml   build + test + publish on push to main
```

Script load order in `index.html` is `voice.js`, `app.js`, `voice-ui.js`. They share globals
(`$`, `el`, `api`, `lobby`, `last`, `voice`, `voiceUi`, `paintRange`, ...). **Anything app.js
calls during startup must be defined in app.js or voice.js**, not voice-ui.js (a startup
crash from that once hid the status badges).

## How the pieces talk

- **Room protocol** (JSON over `ws://host:8787/ws?k=CODE`): `hello` -> `welcome {clientId, state, members}`;
  `state {paused, position, updatedAt, waiting, waitingFor, media}`; `cmd {action: play|pause|seek, position}`;
  `status {buffering, drift, source, rtt}`; `ping`/`pong` (clock sync, every 2 s); `chat`; `event`;
  `media-info {duration}`; voice control `voice-join|leave|state|mod|peers|peer-joined|peer-left|kicked`.
- **Room clock** (server.js): `current = position + (now - updatedAt)` while playing and nobody is
  buffering. Call `_rebase()` before anything that changes the effective play state.
- **Sync** (session.js `_sync`, every 250 ms): small drift -> nudge mpv speed (up to +/-8 %);
  > 1.5 s -> seek; paused -> line up within 0.1 s. Users' own actions in mpv are detected and
  turned into room commands; the app's own seeks/pauses are told apart from the user's.
- **Voice audio**: binary WebSocket frames `[1][seq u32][opus]` from the talker; the host relays
  `[1][8-byte sender id][seq][opus]` to everyone else in voice. Frames are only sent while talking.
- **Access**: only loopback and Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) addresses, plus the
  6-character room code; LAN is opt-in. The host is whoever presents the 32-hex `hostToken`.
- **Liveness**: the server drops apps silent for 15 s; guests treat 10 s of host silence as a dead
  connection and reconnect (2 s retries). `1001 "Host closed the lobby"` sends guests home;
  `1012 "Host is restarting"` (update) makes them keep reconnecting.
- **Resume after update**: before "Restart to update", main saves the lobby (host: code, token,
  video id, position; guest: invite) + voice state in settings; the new version restores it once,
  within 15 minutes.

## Commands

```powershell
npm install
npm start                      # run the app (scripts/start.js strips ELECTRON_RUN_AS_NODE)
npm test                       # unit + integration (server/session with a fake mpv, updater, hotkeys); what CI runs
npm run test:voice             # voice e2e: hidden, SILENT Electron windows, real VoiceEngine + server
npm run test:hotkeys-real      # real Windows keyboard state; presses synthetic F23/F24 only
npm run test:embed             # real mpv inside a window; visible for a few seconds
npm run test:app -- <video>    # whole app + real mpv: layouts, fullscreen, pop out, resume, ... (~1.5 min, visible,
                               # moves and clicks the real mouse); use a video WITHOUT an audio track. Keep your hands
                               # off the mouse while it runs: the "bar fades" / "pointer hides" checks need it still
npm run test:mpv -- <video>    # two real mpv windows syncing (audible if the video has sound)
npm run dist                   # installer into dist/ (needs vendor/mpv, see README)
```

A silent test video: `vendor\mpv\mpv.com --no-config "av://lavfi:testsrc2=size=1280x720:rate=30:duration=120" --o=clip.mkv --ovc=libx264 --ovcopts=preset=ultrafast`
(no `--oac`, so there's no audio track). The voice e2e needs Windows text-to-speech (for a speech
sample); it generates one into %TEMP%.

### Which tests to run

| You changed | Run |
|---|---|
| server.js, session.js, util.js, mpv.js | `npm test` (+ `test:app` if it touches the player or lobby flow) |
| updater.js | `npm test` |
| hotkeys.js | `npm test` and `test:hotkeys-real` |
| overlay.js / overlay.* (fullscreen play bar) | `test:app` |
| voice*.js, voice-ui.js | `npm test` and `test:voice` |
| videohost.js, layout / fullscreen / player chrome | `test:embed` and `test:app` |
| anything in the renderer | `test:app` (it fails on any page error) |

Tests must not disturb the person at the PC: keep audio output off (voice tests render to no
device), never send real keystrokes other than F23/F24, restore the mouse if you move it, and
never let an Electron test show an error dialog (`dialog.showErrorBox` is stubbed; uncaught errors
exit the run).

## Releasing

1. Bump `version` in `package.json` (semver: features -> minor, fixes -> patch).
2. Add a `## <version>` section at the top of **CHANGELOG.md**, written for users. It becomes the
   GitHub release notes (scripts/release-notes.js) and the in-app "What's new" after updating.
3. Merge to `main`. `.github/workflows/release.yml` runs `npm test`, downloads the latest shinchiro
   mpv build, builds the installer, and publishes `v<version>` with the installer, `.blockmap` and
   `latest.yml` (what installed apps' updater reads). No version bump -> it builds but doesn't release.

## Conventions

- Plain CommonJS on Node/Electron, no bundler, no TypeScript, no framework. Keep it that way.
- Comments explain **why** (constraints, things that went wrong), not what the line does.
- User-facing text: short, plain, friendly; say what to do next. Errors go through `cleanError`.
- Renderer DOM is built with `el()` / `textContent`. Never put user text into `innerHTML`.
- Security: the page has no Node access; every capability is an explicit `api.*` in preload.js and
  an `ipcMain.handle` in main.js that validates its input. The window can't navigate or open windows.
  Only microphone permission is granted.
- Anything persisted goes through `saveSettings` (main) or localStorage (voice prefs, per-person volumes).

## Things that already cost time

- **ELECTRON_RUN_AS_NODE**: VS Code terminals set it, which turns Electron into plain Node. Strip it
  (scripts/start.js and the test runners do). `electron.exe --version` without it opens a window.
- **Chromium WebRTC ignores the Tailscale adapter** (a /32 "IP"-type tunnel) when gathering ICE
  candidates, so peer-to-peer voice only worked on a shared LAN. That's why voice is Opus via WebCodecs
  relayed through the host over the lobby WebSocket.
- **Embedded mpv shows black** unless Chromium's own "Intermediate D3D Window" child inside the video
  host is hidden (user32 ShowWindow via koffi), and it must be **re-hidden after every show/resize**;
  Chromium re-shows it shortly after.
- **HTML can't be drawn over the native video.** Dialogs hide the video while open; the fullscreen
  sidebar pushes the video aside; messages over the video use mpv's OSD (`session.osd`); the
  fullscreen play bar is its own transparent, non-focusable window (overlay.js) kept above the video.
- **mpv can't hide the cursor when embedded** (the parent keeps resetting it; even
  `--cursor-autohide=always` does nothing). The app calls `ShowCursor` from its UI thread instead;
  calls must stay strictly paired.
- **No low-level input hook.** uiohook-napi kept ending up silently dead in the installed app (no
  events, no error; first after restarts, later even on its first start), so push-to-talk and key
  assignment broke, while every test outside the installed app passed. Hotkeys now poll
  `GetAsyncKeyState` for the bound keys only (20 ms), which can't die that way. Don't bring a hook back.
- **electron-builder `npmRebuild: false`**: the native module (koffi) is N-API with
  prebuilt binaries; rebuilding needs Visual Studio, which isn't installed.
- **CSP needs `'wasm-unsafe-eval'`** for the noise-suppression model (WebAssembly). Without it the
  model silently outputs silence; a watchdog in voice.js falls back to Chromium's suppression.
- **GTCRN, not RNNoise**: on steady room noise RNNoise varied 1.5-24 dB between runs; GTCRN gave
  44-49 dB consistently at ~0.3 % CPU.
- **Fullscreen sidebar + multiple monitors**: only cursor positions *inside* the window count
  (`cursorXInWindow`); a monitor to the left is "away", not "at the left edge".
- **Audio device choices** are saved as id *and* name (`inputDeviceLabel` / `outputDeviceLabel`). Windows
  can hand a device a new id (another USB port turns "(4- GSP 370)" into "(5- GSP 370)"), so voice.js
  falls back to matching the name (`deviceKey`). Never overwrite the saved choice when a device is
  missing or `setSinkId` fails: that used to reset it to the Windows default for good.
- **mpv `af-command`** on this build needs the filter target named explicitly:
  `af-command w2gduck volume 0.4 volume`.
- **Electron 33 removed `File.path`**: dropped files go through `webUtils.getPathForFile` in preload.
- **Never hide() / show() the fullscreen play bar window.** A non-focusable Electron window stops
  receiving mouse clicks after a hide / show cycle (0 of 3 after a few cycles, measured), which left
  every button on the bar dead in v0.9.0. The bar fades instead (`setOpacity` + `setIgnoreMouseEvents`)
  and is created / destroyed when entering / leaving fullscreen. Test real input with real clicks
  (`mouse_event`): a DOM `.click()` passed while real clicks failed.
- **Tests that look for "the app window"** must pick the main window by its page (index.html):
  the fullscreen play bar is a second BrowserWindow.
- **Screen captures in tests** (`CopyFromScreen`) can land mid-way through Windows' fullscreen
  animation; wait ~2.5 s. A popped-out mpv window opens mid-screen, over the app.
- **Editing files through shell heredocs** can eat a level of backslash escaping (regexes like
  `\r?\n` turned into real line breaks). Prefer a proper file edit, then `node --check`.

## Platform

Windows only for now (mpv bundled from the shinchiro build, Win32 calls in videohost.js, NSIS
installer). The sync engine, server and voice are platform-neutral; porting mostly means the
in-app player and packaging.

## License notes

mpv is GPL and bundled in the installer; release notes point to https://mpv.io for its source.
