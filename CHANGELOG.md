# Changelog

What changed in each version, for people using the app. The release workflow copies the
section for the version being released into the GitHub release notes, so write each entry
for a user, not a developer.

## 0.8.0

**New**
- **Drag & drop a video** onto the window: on the home screen it becomes the video to host; in a lobby you're hosting, it switches to it.
- **Chat in fullscreen:** chat messages and people joining / leaving appear on the video for a few seconds, since the sidebar is hidden.
- **Taskbar flash** when a chat message arrives while the app is in the background.
- The app **remembers its window size and position**, and the file picker opens in the **last folder** you used.

**Fixed**
- Friends whose PC went to sleep or lost Wi-Fi no longer stay in the lobby (and in voice) forever: they're dropped after 15 seconds of silence and simply rejoin when they're back.
- If the host's connection dies without closing (sleep, Wi-Fi or Tailscale drop), guests notice within about 10 seconds and start reconnecting, instead of looking connected while nothing happens.
- Switching between the in-app player and the popped-out window keeps your mute, and keeps the movie lowered if friends are talking.
- Dropping a file on the window no longer replaces the whole app with that file.
- Dropping a file on the video no longer plays it only for you, out of sync with everyone.
- Hover tooltips in the member list no longer flicker away.
- The host's app can no longer be crashed by a malformed network request.

## 0.7.0

- The **mouse pointer hides** over the video after 2 seconds without moving.
- In fullscreen, the sidebar **hides when the mouse is on another monitor** (it stayed open if that monitor was to the left).
- **Tab** pins the sidebar open in fullscreen, and Tab again closes it; a hint shows when entering fullscreen.

## 0.6.2

- **Restart to update brings you straight back:** the app rejoins (or, for the host, reopens) the lobby you were in, with the same invite, video and spot, and rejoins voice with the same mute / deafen. If the host updates, everyone else's app waits and reconnects by itself.
- Fixed: the Tailscale / player status at the top was missing in 0.6.1.

## 0.6.1

- **Volume controls** in the play bar: mute button and slider (also mouse wheel, ↑ / ↓, **M**). Remembered between sessions.
- The play / pause icon is centered again.

## 0.6.0

- **Everything in one window**, Discord-style: lobby, members, voice and chat on the left, the movie on the right.
- **Fullscreen** (button, **F**, or double-click the video) with a sidebar that slides in from the left edge.
- **Pop out** the movie into its own window, and bring it back.
- **Start a lobby without a video:** talk first, choose later; everyone's player opens when the host picks one.
- **Check for updates** by clicking the version number; the app also checks every 30 minutes and after leaving a lobby.
- Speaking rings no longer light up from keyboard clicks and bumps.

## 0.5.1

- Fixed push-to-talk not reacting and keys not being assignable.
- The microphone no longer opens on faint echo from friends' speakers.

## 0.5.0

- **Push to talk** on any key or mouse side button, working even while the player is fullscreen.
- **AI noise cancellation** (on by default), a **mic test**, and the movie **lowers while friends talk**.
- The host can **mute someone for everyone** or **disconnect them from voice**.
- Global keys for mute and deafen.

## 0.4.0

- **Voice chat** (optional "Join voice"): voice activity, mute / deafen, per-person volume, speaking rings, device and quality settings.

## 0.3.1

- Update downloads show a **progress bar** with speed and time left, and recover from failed downloads.

## 0.3.0

- New look with smooth transitions.

## 0.2.0

- **Automatic updates.**
- Fixes for the end of a video, reconnecting, and keyboard shortcuts.

## 0.1.0

- First release: watch a video file from one PC together, in sync, over Tailscale.
