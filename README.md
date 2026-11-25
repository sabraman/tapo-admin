# Tapo Admin

Multi-camera live view, PTZ control, two-way audio talkback, SD-card recording playback, and local snapshot/clip capture for TP-Link Tapo cameras via Tapo Cloud relay. Runs as a self-hosted Bun web service, a Docker container, or a native macOS / Windows desktop app built with Electrobun.

> **Disclaimer:** `tapo-admin` is an independent, unofficial open-source project and is not affiliated with, endorsed by, or supported by TP-Link. It communicates with Tapo Cloud and camera relay endpoints using unofficial protocols that may change without notice. Use at your own risk.

---

## Features

- **Multi-camera grid & focus mode:** Watch multiple cameras grouped by Tapo Cloud homes/rooms, with automatic low-FPS grid throttling or full HD focus view.
- **Low-latency WebCodecs + MJPEG fallback:** Hardware-accelerated H.264/MPEG-TS decoding over WebSockets in secure contexts, with automatic MJPEG fallback.
- **Audio & two-way talkback:** Live camera audio monitoring and push-to-talk microphone streaming back to the camera.
- **PTZ, privacy & device telemetry:** Pan/tilt controls, privacy shutter toggle, SD-card status, and live relay bitrate/latency telemetry.
- **SD-card playback & media archive:** Browse recorded events by date and save snapshots or MP4 clips locally.
- **Bilingual interface (`auto` / `en` / `ru`):** Automatic browser-language detection with instant switching between English and Russian, covering both the UI and server relay event logs.

---

## Prerequisites

- **[Bun](https://bun.sh) 1.3+**
- **FFmpeg** on `PATH` (or configured via `FFMPEG_PATH`). FFmpeg is required for MJPEG fallback decoding, fMP4 muxing, MP3 audio transcoding, MP4 clip capture, and SD-card playback.

---

## Quick Start (Local Web Server)

```sh
bun install
cp .env.example .env
bun run dev
```

Open `http://127.0.0.1:3456` in your browser.

To run without physical cameras, set `TAPO_DEBUG_EMULATOR=true` in `.env` (or run `bun run dev:emulator`) to enable mock cameras.

---

## Desktop App (Electrobun: macOS & Windows)

Tapo Admin packages as a native desktop application using **Electrobun v2** (`WKWebView` on macOS, WebView2 on Windows) with a local loopback server bound to `127.0.0.1` on an ephemeral port and a system tray menu.

```sh
# Generate / refresh app and tray icon assets
bun run icons:generate

# Run desktop app in development
bun run desktop:dev

# Build stable desktop installer / bundle (macOS .app/.dmg or Windows installer)
bun run desktop:build
```

Platform notes:
- **macOS:** `electrobun.config.ts` requests the `com.apple.security.device.audio-input` entitlement, and `scripts/electrobun/post-wrap.ts` injects `NSMicrophoneUsageDescription` into `Info.plist` for two-way talkback. Set `ELECTROBUN_DEVELOPER_ID` (and optionally `ELECTROBUN_APPLEID` / `ELECTROBUN_APPLEAPIKEY`) to enable codesigning and notarization.
- **FFmpeg in desktop builds:** The desktop entrypoint checks `Resources/app/bin/ffmpeg` (or `ffmpeg.exe` on Windows) first and falls back to `ffmpeg` on your system `PATH`.
- **User data:** Desktop state (Tapo session, store metadata, snapshots, and clips) is stored in the OS user-data directory (`Utils.paths.userData`).

---

## Docker Deployment

The provided `Dockerfile` uses `oven/bun:1.3-alpine`, installs `ffmpeg`, builds the client bundle, and exposes port `3456` with a healthcheck against `/api/health`.

```sh
cp .env.example .env
# Edit .env and set TAPO_ACCESS_PASSWORD before exposing remotely
docker compose up -d --build
```

Persistent sessions, settings, snapshots, and clips are stored in `./data` (mounted to `/data`).

### Why Vercel / Serverless Is Not Supported

Tapo Admin maintains **long-lived outbound TLS relay sockets** to Tapo Cloud stream servers and **persistent WebSockets / SSE streams** to connected browsers, alongside stateful `ffmpeg` child processes. Stateless serverless platforms (such as Vercel Functions) enforce short execution timeouts and do not support persistent stateful relay sessions or native `ffmpeg` streaming pipelines. Deploy with Docker on a VPS, homelab, or NAS, or run the Electrobun desktop app.

---

## Remote Access & HTTPS Requirement

By default, `docker-compose.yml` binds only to `127.0.0.1:3456`. When accessing Tapo Admin from another device over a LAN or the internet, **terminate TLS in front of the container** using a reverse proxy:

- **Tailscale Serve** (zero-config private HTTPS on your tailnet):
  ```sh
  tailscale serve https / http://127.0.0.1:3456
  ```
- **Caddy** (automatic Let's Encrypt HTTPS for a domain):
  ```caddyfile
  cameras.example.com {
    reverse_proxy 127.0.0.1:3456
  }
  ```

**Why HTTPS matters:** Modern browsers restrict `WebCodecs` (`VideoDecoder`) and `navigator.mediaDevices.getUserMedia` (microphone talkback) to **Secure Contexts** (`https://` or `http://localhost` / `http://127.0.0.1`). Over plain `http://` on a LAN IP, WebCodecs and microphone talkback are disabled by the browser.

---

## Remote Access Password (`TAPO_ACCESS_PASSWORD`)

When `TAPO_ACCESS_PASSWORD` is set in the environment, Tapo Admin gates the dashboard, REST API, SSE stream, and WebSocket endpoints behind a password lock screen using an `HttpOnly`, `SameSite=Lax` signed session cookie (with `Secure` set automatically when accessed over HTTPS).

Leave `TAPO_ACCESS_PASSWORD` empty for local-only use or the desktop app.

---

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address for the HTTP server. |
| `PORT` | `3456` | HTTP port. |
| `TAPO_DATA_DIR` | `.data` (`/data` in Docker) | Directory for persisted sessions, settings, and media. |
| `TAPO_ACCESS_PASSWORD` | _(empty)_ | Optional shared password for remote deployments. |
| `TAPO_DEBUG_EMULATOR` | `false` | Enables built-in mock cameras for testing without hardware. |
| `FFMPEG_PATH` | `ffmpeg` | Path or command name for the FFmpeg binary. |
| `TAPO_CERT_PATH` | `certs/tapo-cloud-roots.pem` | Path to Tapo Cloud root CA certificates. |

---

## License

[MIT](LICENSE)
