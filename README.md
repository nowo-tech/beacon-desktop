# TimeTrack desktop

Tray app (Tauri 2) to start, stop and switch your [symfony-beacon](https://github.com/nowo-tech/symfony-beacon) time
tracking. Talks to the TimeTrackBundle **1.9.0** client API only. Windows, macOS and Linux. English and Spanish.

<img src="docs/images/desktop-device-code.png" alt="Device sign-in code" width="300"> <img src="docs/images/desktop-timer.png" alt="Running timer and task list" width="300">

It records only the time you choose to track — see [PRIVACY.md](PRIVACY.md).

## Install

Download the installer from Beacon → **Tasks → Time → Apps** (`/dashboard/tasks/time/apps`); the page shows the
version and SHA-256 of each file. Version 0.1 is **not code-signed** yet, so the operating system warns once:

| OS | File | First start |
|---|---|---|
| Windows 10/11 | `*-setup.exe` (or `.msi`) | SmartScreen "Windows protected your PC" → **More info** → **Run anyway**. |
| macOS 12+ (Intel and Apple silicon) | `.dmg` | Drag TimeTrack to Applications. First start: right-click (Control-click) the app → **Open** → **Open**. If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine /Applications/TimeTrack.app` once. On macOS 15+: System Settings → Privacy & Security → **Open Anyway**. |
| Linux (x86_64) | `.deb` or `.AppImage` | `sudo apt install ./TimeTrack_*.deb`, or `chmod +x TimeTrack_*.AppImage` and run it. The token is kept in the Secret Service (GNOME Keyring / KWallet). |

Check the SHA-256 shown on the Apps page before installing (`certutil -hashfile <file> SHA256`, `shasum -a 256 <file>`,
`sha256sum <file>`).

### Sign in

1. Enter your Beacon URL and click **Connect**.
2. The app shows a code like `BCDF-GHJK` and opens Beacon's *Connect a device* page in your browser.
3. Check the code, approve. The app is now listed in Beacon under Account → Security → Time tracking apps, where you
   can revoke it. The session token is stored in the OS keychain only.

## Features

- Tray timer (elapsed time and task; "Stop timer" in the tray menu) and global shortcut **Ctrl/Cmd + Alt + T**.
- Device-flow sign-in (no password typed in the app); `401` asks you to sign in again.
- Task search, start / stop / switch. Offline queue: actions taken offline are sent when the connection returns (a stop
  keeps its original time; a start begins when it reaches the server).
- Optional, off by default, with dated consent: idle detection (local only; you choose keep / discard / split, only the
  decision is sent), notifications (never outside `me.workingHours`), start at login.
- Auto-update through Beacon (`/api/time-track/updates/desktop/{target}/{arch}/{version}`, your token as Bearer);
  an "update required" screen when the server's `min_supported_version` (body or `X-Min-Supported-Version` header) is
  newer than the app and an update satisfying it is offered; it always keeps *Remind me later*, *Download from Beacon*
  and *Sign out*. The Bearer token is never sent to the artifact host (pre-signed URL on another origin); the device
  verification page is opened only when it is https on the server's host.
- Links back to Beacon: **Open Beacon** and **My time** in the header (and *Open Beacon* in the tray menu), plus an
  "Open in Beacon" icon on each task and on the running timer when the server sends the task's `url`. Only `https:`
  links on the connected server's origin are shown or opened.
- "What we collect" screen.

## Development

Requirements: Node 24, pnpm (`corepack enable`), Rust stable and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Linux also `libxss-dev libx11-dev libdbus-1-dev`).

```bash
pnpm install
pnpm mock                 # mock TimeTrack 1.9.0 API + Beacon updater route on http://127.0.0.1:8787
pnpm dev                  # UI in a browser (fake platform) on http://127.0.0.1:1420 — handy for UI work
pnpm tauri dev            # the real app
pnpm lint && pnpm typecheck && pnpm test:coverage   # unit tests, ≥ 90% coverage
pnpm exec playwright install chromium && pnpm test:e2e
(cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
```

The mock's device page is `http://127.0.0.1:8787/device` (approve the code shown by the app). `src/api/` is shared
verbatim with [time-track-extension](https://github.com/nowo-tech/time-track-extension).

## Release

Bump `package.json` and `CHANGELOG.md`, merge, push a `vX.Y.Z` tag. `.github/workflows/release.yml` (tags only) builds
Linux and Windows first, macOS (universal) last, then uploads every file to `time-track-clients/desktop/<version>/` and
writes `time-track-clients/desktop/channel/stable.json` last. Missing secrets skip their step with a notice.

| Name | Kind | Used for |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secrets | updater signatures (`pnpm tauri signer generate -w ~/.tauri/timetrack.key`) |
| `TAURI_UPDATER_PUBKEY` | variable | the matching public key, built into the app |
| `TIME_TRACK_S3_ENDPOINT`, `TIME_TRACK_S3_BUCKET`, `TIME_TRACK_S3_ACCESS_KEY_ID`, `TIME_TRACK_S3_SECRET_ACCESS_KEY` (+ optional `TIME_TRACK_S3_REGION`) | secrets | upload (`s3:PutObject` on `time-track-clients/*` only) |
| `BEACON_URL` | variable | prefilled server URL |
| `TIME_TRACK_MIN_SUPPORTED_VERSION` | variable (optional) | `min_supported_version` in `stable.json` |

Docs: [CHANGELOG](CHANGELOG.md) · [PRIVACY](PRIVACY.md) · [SECURITY](SECURITY.md) · [CONTRIBUTING](CONTRIBUTING.md)

License: [MIT](LICENSE).
