# Watch2Gether

Watch a video file from one person's PC together with friends, in sync. Anyone in the lobby can pause, play or seek, and it happens for everyone.

- **Full quality, no re-encoding.** The host's PC serves the original file and friends stream it over [Tailscale](https://tailscale.com). 4K HEVC, HDR, MKV, DTS and TrueHD all work.
- **No server to rent.** The host's PC is the server.
- **Tight sync.** Players line up to within ~50 ms. Small drift is corrected by nudging playback speed (±8 %); large drift triggers a seek.
- **Buffer-aware.** If someone is buffering, the room waits for them. After 20 s it carries on, and they catch up.
- **Local-copy mode.** A friend who already has the same file plays it from their own disk and only syncs, so it costs the host no bandwidth.

## Setup (everyone)

1. **Install Tailscale** (https://tailscale.com/download/windows) and log in.
   - The host either invites friends to their tailnet, or uses **Share** on their machine in the Tailscale admin console to share just that PC with each friend.
   - Check it works: `ping 100.x.y.z` (the host's Tailscale IP) from a friend's PC.
2. **Run `Watch2Gether-Setup-x.y.z.exe`.** It installs per-user with no admin prompt, includes the mpv video engine, and adds a desktop shortcut.
   - Windows SmartScreen may warn *"Windows protected your PC"* because the installer isn't code-signed. Click **More info → Run anyway**.
   - When you host for the first time, Windows Firewall asks whether to allow Watch2Gether. Click **Allow**.

## Using it

**Host:** enter your name → **Choose video…** → **Start lobby** → **Copy invite** and send it to your friends. An invite looks like `100.101.102.103:8787/K7M2QX`.

**Friends:** enter your name → paste the invite → **Join**. If you already have the file, open *"I already have this video"* first and pick it.

The video plays in an mpv window, and the Watch2Gether window shows the lobby, the status of each person and chat. You can control playback from either window:

| Key (in the player window) | Action |
|---|---|
| Space | Play / pause for everyone |
| ← / → | Seek 5 s for everyone (↑/↓ seeks 1 min) |
| f | Fullscreen (just you) |
| # | Switch audio track (just you) |
| j | Switch subtitles (just you) |
| 9 / 0 | Volume (just you) |

When the video ends, the room pauses on the last frame. Press play to watch it again from the start.

## Voice chat

Click **Join voice** in the lobby to talk while you watch. It's optional, and everyone else keeps watching either way.

- **Voice activity:** your mic only sends while you talk. Adjust the sensitivity under ⚙ → *Input sensitivity*, or leave it on automatic.
- **Mute / deafen:** the mic and headphones buttons, or **Ctrl+Shift+M** / **Ctrl+Shift+D**.
- **Per-person volume:** click someone in the lobby to set their volume (0–200 %) or mute them just for you. It's remembered by name.
- **Settings (⚙):** input/output device, input/output volume, noise suppression, echo cancellation, automatic gain, voice quality (32–128 kbps), sound cues.
- **Use headphones** if you can: the movie plays in mpv, outside the voice engine, so with speakers your friends may hear it through your mic.

Voice goes over the same Tailscale connection as the lobby: the host relays each person's voice (Opus, ~64 kbps, only while they talk) to everyone else in voice.

## Updates

The app checks GitHub for a new release when it starts and downloads it in the background (it won't start a download while you're in a lobby). When it's ready, the top bar shows **Restart to update**; otherwise it installs the next time you close the app.

## Bandwidth (the one thing to check)

Each streaming friend pulls the file's bitrate from the host's **upload** connection:

> needed upload ≈ file bitrate × streaming friends × 1.2

The lobby shows the file's average bitrate, the upload it needs and the actual upload in real time. For example, a 4K HEVC file at 20 Mbps with 3 friends needs about 72 Mbps of upload. If the host's upload is too slow, friends can get the file ahead of time and use local-copy mode.

## Troubleshooting

- **"Timed out reaching…"**
  - Make sure Tailscale shows *Connected* on both PCs.
  - The first time you host, Windows Firewall asks whether to allow Watch2Gether. Allow it. If you missed that prompt, run this in an admin PowerShell:
    ```powershell
    New-NetFirewallRule -DisplayName "Watch2Gether" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
    ```
- **"The host refused the connection"**
  - The room code is wrong, or you aren't connecting through a `100.x.y.z` Tailscale address.
  - LAN connections are off by default. The host can turn them on under *Advanced*.
- **Stuttering:** run `tailscale status` and check whether the friend's line says `relay`. If it does, Tailscale couldn't make a direct connection and the bandwidth is limited. Restarting Tailscale or the router often fixes it. Some networks can't connect directly (CGNAT on both sides), and local-copy mode is the fallback for those.

## Development

```powershell
npm install
npm start        # run the app
npm test         # sync engine tests (real server + sessions, simulated player)
npm run test:mpv -- <video>   # same, with two real mpv players (opens windows)
npm run dist     # build dist/Watch2Gether-Setup-<version>.exe
```

**Bundled mpv:** `npm run dist` packs whatever is in `vendor/mpv/` (`mpv.exe`, `mpv.com`, `d3dcompiler_43.dll`, `mpv/fonts.conf`). It was copied from the `shinchiro.mpv` winget install in `C:\Program Files\MPV Player`. To update mpv, run `winget upgrade shinchiro.mpv` and copy those files again. mpv is GPL-licensed, so if you redistribute it, point people to https://mpv.io for the source.

**Build error "Cannot create symbolic link" (winCodeSign):** electron-builder's signing-tools archive contains macOS symlinks that Windows refuses to create without admin rights. Extract the archive yourself, skipping those files:
```powershell
$c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
.\node_modules\7zip-bin\win\x64\7za.exe x (Get-ChildItem $c -Filter *.7z)[0].FullName "-o$c\winCodeSign-2.6.0" -y -xr!darwin
```
You can also enable Windows Developer Mode, which allows symlinks.

If you change the version in `package.json`, friends who already have the app can just run the new installer over the old one.

### How it works

```
Host PC                                         Friend PC
┌───────────────────────────────┐               ┌──────────────────────┐
│ HostServer (Node, port 8787)  │  HTTP range   │ mpv  ◄── streams     │
│  /media/<id>?k=CODE  ─────────┼──────────────►│                      │
│  /ws?k=CODE   room clock  ◄───┼── WebSocket ─►│ Session (sync loop)  │
│ Session + mpv (local file)    │               │                      │
└───────────────────────────────┘               └──────────────────────┘
```

- `src/main/server.js` holds the authoritative room clock `{paused, position, updatedAt}`. It also serves the file with range requests and tracks who is buffering. It only accepts loopback and Tailscale addresses, and requires the room code.
- `src/main/session.js` estimates the clock offset to the host from NTP-style pings, keeps mpv on the room clock, and turns the user's own actions in mpv (pause, seek) into room commands.
- `src/main/mpv.js` controls mpv through its JSON IPC named pipe.
- `src/renderer/` is the lobby UI.
