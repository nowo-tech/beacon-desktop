# TimeTrack desktop

Tray app (Tauri 2) to start, stop and switch your [symfony-beacon](https://github.com/nowo-tech/symfony-beacon) time
tracking. Talks to the TimeTrackBundle **1.9.0** client API only. Windows, macOS and Linux. English and Spanish.

<img src="docs/images/desktop-device-code-light.png" alt="Device sign-in code" width="300"> <img src="docs/images/desktop-timer-light.png" alt="Running timer and task list" width="300">

It records only the time you choose to track — see [PRIVACY.md](PRIVACY.md).

## Install

Download the installer from Beacon → **Tasks → Time → Apps** (`/dashboard/tasks/time/apps`); the page shows the
version and SHA-256 of each file. Version 0.1 is **not code-signed** yet, so the operating system warns once:

| OS | File | First start |
|---|---|---|
| Windows 10/11 | `*-setup.exe` (per user, no administrator rights; 0.1.0 also had an `.msi`) | SmartScreen "Windows protected your PC" → **More info** → **Run anyway**. |
| macOS 12+ (Intel and Apple silicon) | `.dmg` | Drag TimeTrack to Applications. First start: right-click (Control-click) the app → **Open** → **Open**. If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine /Applications/TimeTrack.app` once. On macOS 15+: System Settings → Privacy & Security → **Open Anyway**. |
| Linux (x86_64) | `.deb` or `.AppImage` | `sudo apt install ./TimeTrack_*.deb`, or `chmod +x TimeTrack_*.AppImage` and run it. The token is kept in the Secret Service (GNOME Keyring / KWallet). |

Check the SHA-256 shown on the Apps page before installing (`certutil -hashfile <file> SHA256`, `shasum -a 256 <file>`,
`sha256sum <file>`).

### Upgrading on Windows

From 0.4.0 on, the app updates itself (signed, in place, no questions: *Update now* closes the app, installs and
starts it again). Running a newer `*-setup.exe` by hand also upgrades in place: it closes TimeTrack, tray included
(it asks first), keeps your sign-in and settings, and leaves a single *TimeTrack* entry in Settings → Apps. If the
installer offers *Uninstall before installing*, either choice works; the second one is quicker.

Coming from **0.1.0**:

- **Installed with `*-setup.exe`**: run the 0.5.0+ `*-setup.exe` (or let 0.4.0+ update itself). The 0.4.0 installer's
  *Uninstall before installing* fails on this install with "Unable to uninstall!": click OK, choose **Do not
  uninstall**, then **Next**; the upgrade is complete and correct.
- **Installed with the `.msi`** (for all users, in `C:\Program Files\TimeTrack`): the 0.5.0+ installer finds it and
  offers to remove it (Windows asks for administrator approval). If you decline, or that fails, or you installed
  0.4.0: open **Settings → Apps → Installed apps**, find the **TimeTrack** whose publisher is **nowo** (version
  0.1.0) and choose **Uninstall** (needs an administrator account), then start the remaining TimeTrack. Keep the
  one from publisher **nowo.tech**. Your sign-in is shared, so nothing else to do; if *Start at login* was on, switch
  it off and on again in Settings.

### Two TimeTrack icons in the tray

Up to 0.5.0 a second launch (Start menu or desktop shortcut while the app was hidden in the tray, or a second
start-at-login entry left by an older install) started a second copy with its own tray icon. From 0.5.1:

- **One copy per user session.** A second launch exits at once and brings the running window forward (a second start
  at login, `--hidden`, just exits). Windows: a per-session named mutex; macOS: a local socket (in the shared `/tmp`,
  an upstream limitation: SECURITY.md → *Known limitations*); Linux: a D-Bus name on the session bus (without a
  session bus the app starts unguarded, as before).
- **One start-at-login entry.** At start, an installed Windows copy (`%LOCALAPPDATA%\TimeTrack` or
  `Program Files\TimeTrack`; a copy run from Downloads or elsewhere changes nothing) keeps *Start at login* as a
  single `HKCU\…\Run` value `TimeTrack` for itself, path quoted, and removes its other entries (`time-track-desktop`,
  the 0.1.0 `.msi` copy in Program Files, a per-machine `HKLM` value when it may; `src-tauri/src/autostart.rs`). Only
  the app's own entries count (value name `TimeTrack` / `time-track-desktop`, its executable, an install folder);
  another product's are never touched. Disabled in Task Manager stays disabled, and an app without any entry is
  never switched on. The installer moves the app's value pointing at the 0.1.0 copy to this install even when that
  copy is kept, and removes the app's per-machine value when it runs with administrator rights.
- **Start at login written by the app itself** (Windows): Settings switches one quoted HKCU value, never an
  unquoted or per-machine (`HKLM`) one as the autostart plugin did when the app ran elevated. Switching it on is
  refused from a TimeTrack run as administrator or from a copy that is not the installed one (Settings says why).
- **One tray icon per process**: built once in Rust; the webview has no tray permission.

To check by hand (Windows, PowerShell), list what starts at login and what runs:

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
Get-Process | Where-Object { $_.Path -match '(?i)\\(TimeTrack|time-track-desktop)\.exe$' } | Select-Object Id, Path
```

Quit every copy (tray → *Quit*, or `Stop-Process -Name TimeTrack, time-track-desktop`), remove extra entries with
`Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name <name>` (an `HKLM` one from an
administrator PowerShell), or Task Manager → *Startup apps* → disable the duplicate; also delete any TimeTrack
shortcut in `shell:startup` / `shell:common startup` (Win+R). Uninstall a leftover 0.1.0 copy
(publisher **nowo**) and start TimeTrack again. A tray icon that stays after its process is gone (killed, crashed) is
a ghost Windows removes when the mouse passes over it.

### Sign in

1. Enter your Beacon URL and click **Connect**. The app asks *Sign in to <host>?* in a system dialog: check the host
   and click **Sign in** (if you did not just ask to sign in, click **Cancel**).
2. The app shows a code like `BCDF-GHJK` and opens Beacon's *Connect a device* page in your browser.
3. Check the code, approve. The app is now listed in Beacon under Account → Security → Time tracking apps, where you
   can revoke it. The session token is stored in the OS keychain only, and only Rust reads it: the app's web view
   never sees it. A system notification confirms every sign-in. If the app ever signs you out because the saved
   server no longer matches the session, revoke the old device there too.

## Features

- Tray timer (`H:MM` and task, tooltip with today's total, running / stopped icon) in the Windows notification area
  (bottom right, like Docker Desktop), the macOS menu bar and the Linux StatusNotifier / AppIndicator, with a translated
  menu: the running task and its time (refreshed every 30 s), Stop / Resume, Switch to (pinned and recent tasks),
  Search task…, Open TimeTrack, Full view / Compact view, Open Beacon, My time, *Pause friendly messages for 1 h*, Settings, Quit. A left click
  shows or hides the window (Windows, macOS; Linux AppIndicators only open the menu). Closing or minimising the
  window keeps the app running in the tray: the timer, the "Still there?" check and the friendly messages carry on,
  woken on time by a wall-clock heartbeat in Rust (`src-tauri/src/heartbeat.rs`), not by the webview's timers, which
  a hidden window may throttle. Global shortcut **Ctrl/Cmd + Alt + Shift + T**, configurable in
  Settings.
- Pinned and recent tasks (`Alt+1…9`), Resume the last task, Today / This week totals, search with `Ctrl/Cmd + K`, arrow
  keys and Enter.
- Two views: the **compact view** (the quick tracker, one centred column up to 900 px wide) and the **full view** (from
  900 px: sections sidebar, task list with the running timer on top, detail pane with the selected task's time today
  and this week and the week by day; Settings as a page). Switch with the header button, the tray menu or
  `Ctrl/Cmd + Shift + L`; each view reopens at its own remembered size and position, on screen. `F6` moves between
  the panes. The window cannot be made smaller than the compact view (380 × 560).
- Device-flow sign-in (no password typed in the app); `401` asks you to sign in again.
- Task search, start / stop / switch. Offline queue: actions taken offline (and "Still there?" answers) are kept on this
  computer, survive a restart and are replayed in order with their real times (`startedAt` / `endedAt`, TimeTrackBundle
  1.10). When the server moves a time (overlap with the previous entry, backdating limit, clock in the future), the app
  says so in plain words. A 1.9 server records an offline start when the connection returns, and the app says that too.
- **"Still there?"** (Beacon spec 199 block 0): while a timer runs, after N minutes without keyboard or mouse input the
  app asks, calmly and without blocking: *Keep* · *Discard* (stop the timer at the idle start) · *Reassign to another
  task…*, then *I was in a meeting or call* (optional note, or count the time on another task on 1.10 servers) and
  *Drop those minutes and keep going*. With no answer within M minutes the timer
  stops at the last input; on return the app asks what to do with the gap, then offers *Resume*. Screen lock and sleep
  count as idle. N and M come from the organisation (`GET me` → `features.idle_check`, `limits.idle_check`; on by
  default there, and the person may only make N longer). On a 1.9 server it is the person's opt-in (default 10 / 5 min).
  The OS idle counter is read locally (`user-idle`) and never stored, logged or sent: only the decision reaches the
  server.
- Privacy screen ("What we collect"): exactly what is sent and what stays on this computer, and **Clear local data**
  (signs out, deletes the token, settings, consents, pinned tasks, queued actions and the idle-check state).
- Optional, off by default, with dated consent: notifications (never outside `me.workingHours`), start at login.
- Auto-update through Beacon (`/api/time-track/updates/desktop/{target}/{arch}/{version}?bundle_type=…`, your token
  as Bearer), signed with the owner's minisign key: checked at start, every 6 h and from *Check for updates* (tray,
  Settings → About). A calm card ("Version X is available — What's new · Update now · Later") downloads with progress,
  verifies, installs and relaunches; with a timer running it asks first and offers *After I stop*. An "update
  required" screen when `min_supported_version` (updater body / `X-Min-Supported-Version` / `GET me`) is newer than the
  app and an update satisfying it is offered; it always keeps *Remind me later*, *Download from Beacon* and *Sign out*.
  The Bearer token is never sent to the artifact host (pre-signed URL on another origin); the device verification page
  is opened only when it is https on the server's host.
- Windows: Microsoft Store (MSIX, updated by the Store) or the per-user NSIS installer from Beacon (no UAC). macOS:
  unsigned, see [first open on macOS](docs/guides/macos-first-open.en.md) ([español](docs/guides/macos-first-open.es.md)).
  Plan and owner steps: [docs/RELEASE-PLAN-0.4.0.md](docs/RELEASE-PLAN-0.4.0.md).
- Links back to Beacon: **Open Beacon** and **My time** in the header (and *Open Beacon* in the tray menu), plus an
  "Open in Beacon" icon on each task and on the running timer when the server sends the task's `url`. Only `https:`
  links on the connected server's origin are shown or opened.
- "What we collect" screen.

### Light and dark theme, mascot moments

Settings → **Theme**: *System* (default, follows the computer's light / dark setting), *Light* or *Dark*; stored on this
computer and applied to the title bar too. The robot from Beacon shows up in a few friendly moments (sign-in, "You're
in!", saved, a timer left running for 8 hours, no results, offline, updates) and stays out of the running timer and the
task list; which pose goes where, and where the art comes from: [public/mascot/README.md](public/mascot/README.md).

<img src="docs/images/desktop-welcome-light.png" alt="You're in! card after signing in, light theme" width="200"> <img src="docs/images/desktop-long-running-dark.png" alt="Still going strong? nudge on a timer running for 9 hours, dark theme" width="200"> <img src="docs/images/desktop-settings-theme-dark.png" alt="Settings with the System, Light and Dark theme switch, dark theme" width="200">

<img src="docs/images/desktop-saved-light.png" alt="Saved notice with the mascot after stopping a timer, light theme" width="200"> <img src="docs/images/desktop-no-results-dark.png" alt="No search results with the reading robot, dark theme" width="200"> <img src="docs/images/desktop-offline-light.png" alt="Working offline card, light theme" width="200">

### Friendly messages

A smile now and then, never in the way. While a timer runs, small desktop notifications (outside the app, even with
the window in the tray; a toast inside the window when the OS does not show them) cheer you on after 2, 4, 6… hours (a medal at 2 h and 4 h, a gentle "take a real break" from 6 h, with no figure in
it), greet an early
start, suggest a coffee, lunch, a stretch or some water, say it is getting late, and have something to say on Friday
afternoon and at the weekend. They know about meetings: during a daily, a call or a planning (from Beacon's labels or
the task name) "Still there?" becomes "Still in the meeting?" with a longer countdown, a long meeting is followed by a
coffee / stretch toast, and a finished daily gets a "let's go!". At most one toast every 50 minutes, each moment at
most once a day, never a repeated line among the last six. Written natively in English, Spanish, German, French,
Italian, Dutch and Portuguese (the Beacon user's language when the server sends `me.locale`, else the app's), with
local times per language. Settings → **Friendly messages**: *Fun messages* and *Wellbeing reminders*, both on by
default. Pools: `src/lib/messages/`; rules: `src/lib/friendly.ts`.

### Working-hours reminders

Settings → **My schedule** holds your week: start, end and lunch break per weekday, or a day off. It is filled in from
the working hours your organisation publishes in Beacon (`GET me.workingHours`; the gap between two slots of a day is
the lunch break) and you can change any value on this computer only; local values are marked *This computer*, and
*Reset to Beacon's schedule* goes back. Holidays and vacations come from Beacon (`GET me.daysOff`, once
TimeTrackBundle publishes them) and from days off you add there.

With *Working-hours reminders* on (default), a desktop notification with a button arrives at your start time ("Shall we
start? Last task: …" → *Start* resumes it), at lunch ("Lunch time. Shall I stop the timer?" → *Stop*; then "Back to
…?" → *Resume*) and at the end of the day ("Shall we call it a day?" with today's total → *Stop*). None on days off,
none that make no sense (no "start" with a timer running, no "stop" without one), each once a day, in the schedule's
time zone, and after a sleep only within 15 minutes of its time. They follow the 1 h pause but not the 50-minute
gap of the friendly messages. Rules: `src/lib/schedule.ts`; texts: `reminders` in `src/lib/messages/`.

"Still there?" itself opens in **its own small window, always on top and centred on the monitor you are using**, also
while the main window is in the tray (`src-tauri/src/prompt.rs`, `src/ui/prompt.ts`), with a countdown (2 minutes, 10
during meetings): with no answer the timer stops at the start of the idle time, and the window offers **Resume …
now** on the same task. There is only ever one; it closes once answered, Esc does not dismiss it, and on Windows it
flashes in the taskbar when focus-stealing prevention keeps it from taking the focus. A small *Open TimeTrack* link in
it brings the main window forward. It shows the running task's title above every other window, so it is also visible
to anyone watching a shared screen. Where it cannot open (a plain browser), it is a modal inside the main window.

#### Desktop notifications

| | Where | Picture | Click |
|---|---|---|---|
| Windows 10 / 11 | Bottom right, then the Action Center, under the app's AppUserModelID (`tech.nowo.timetrack` for the NSIS install, `<package family>!TimeTrack` for the Microsoft Store / MSIX package) | The pose as the square app logo of the toast | Brings TimeTrack forward (while the toast is on screen) |
| macOS | Notification Center (top right) | The pose as the content image, the app icon as the sender | Brings TimeTrack forward |
| Linux | The desktop's notification service (GNOME, KDE, …) | The pose through the `image-path` hint | Brings TimeTrack forward (servers that support the `default` action) |

The first time one is due, the app asks the OS for permission (macOS asks you; the others allow it) and explains once,
inside the window, where the messages went (*Keep them inside the app* is one click away). A refusal or a missing
notification service is remembered: the messages stay in the window and Settings → Friendly messages says why, with
*Try again*. The pictures are 96 × 96 PNGs built from the poses (`scripts/mascot/notification-art.sh` →
`src-tauri/notification-art/`, listed in `src-tauri/src/pose_art.rs`), compiled into the binary and written to the app
cache on first use. `pnpm screenshots:native` (`NATIVE_SCREENS=<dir>`) renders mock-ups of the three notifications,
the prompt window and the Windows tray menu for review.

Each line has its own mascot pose (`POSE_IDS`). New art goes in as transparent PNGs (or on white) named
`pose-<id>.png`:

```bash
scripts/mascot/import-poses.sh <dir>   # → public/mascot/pose-<id>.webp + @2x (96 / 192 px high), src/ui/pose-art.json
pnpm screenshots:friendly              # every situation in Spanish, light and dark (FRIENDLY_SCREENS=<dir>)
```

The script makes a white background transparent, drops stray fragments at the edges, trims and converts with cwebp and
ImageMagick (in a throwaway Docker container when they are not installed). A pose without art shows its fallback
(`POSE_FALLBACK` in `src/ui/mascot.ts`); no code change is needed.

### Open Beacon in, Copy link

Settings → **Open Beacon in**: *System default browser* (default), a browser found on this computer (Windows registry,
macOS LaunchServices, Linux `.desktop` files incl. Flatpak / Snap) or *Custom…*. Every link the app opens uses it, also
links a page would open by itself. If the chosen browser is uninstalled, links open in the system default and the app
says so. Next to My time, a running task's link and *Open the page again* there is a **Copy link** button, and a right
click (long press) on any Beacon link offers *Open in the browser* / *Copy link*; if no browser can be opened the link
is copied instead. When the list is empty the mascot says what to do next: *Pin a task*, *Start a timer* or *Open the
tasks in Beacon*.

### Continue, three answers on return, lock pause and "working without a timer?"

- **Continue last**: one click on the stopped timer card, or the global shortcut **Ctrl/Cmd + Alt + T**
  (**Ctrl + Alt + Shift + R** on Linux, where Ctrl+Alt+T opens a terminal; configurable in Settings, works with the
  window hidden in the tray), starts the last task again as a new entry. The
  tray shows the running time on its own (macOS menu-bar title, tooltip on every system), refreshed every minute by the
  Rust heartbeat (`src-tauri/src/tray_clock.rs`).
- **Three answers on return from idle** (the "Still there?" prompt, its own window or the in-app modal): **Keep** ·
  **Discard** (the timer stops at the start of the idle time) · **Reassign**, which opens a task picker (pinned,
  recent, search, and a quick *Meeting* choice when a meeting-type task exists) and splits the idle span into its own
  entry on that task while the timer goes on (`discard-idle` `reassign` on 1.10 servers, backdated stop / start
  otherwise; not offered on 1.9). The countdown, the automatic stop and *Resume* are unchanged.
- **Pause on screen lock or sleep** (on by default): the OS lock / sleep events (`src-tauri/src/session.rs`: Windows
  WTS session notifications and power broadcasts, macOS distributed notifications, Linux logind) make that time idle;
  on unlock / wake the same three answers.
- **"Working without a timer?"** (on by default): during your working hours, after N minutes of input (10 by default)
  with no timer, a friendly notification with *Start <last task>* and *Choose task*, at most once every 45 minutes,
  in the seven message languages.

### Meeting detection (opt-in)

Settings → **Meetings** → *Notice when I'm in a call and ask what to record it as* (off by default, dated consent).
When Teams, Zoom, Webex, Slack, Discord, Skype, GoTo, Jitsi Meet or a browser (Google Meet, Jitsi or any web call) has
held the microphone for 2 minutes (1, 2, 5 or 10, configurable), the app asks, as a desktop notification with the
teamwork pose and in the window: "Looks like you're in a meeting (Teams). Which meeting is it?" — *Choose task*
(meeting-like tasks first, then pinned and recent, or a search), *Generic meeting* (your generic meeting task, chosen
once and changeable in Settings), *Not a meeting* or *Don't ask for this app*. With a non-meeting timer running it
offers *Switch to the meeting* instead; with a meeting-like task already running (`taskKind`) it does not ask. When
the microphone has been free for a minute: "Meeting over (32 min). Back to <previous task>?" with *Back* and *Stop*.
During the call the "Still there?" prompt uses its softer meeting wording and longer countdown. Questions follow the
1 h pause ("do not disturb"), wait while "Still there?" is open, come at most every 10 minutes, and, with no timer
running, only within your working day (Settings → My schedule, days off).

What is read, per OS (`src-tauri/src/meeting/`, every 20 s from the heartbeat, only while the switch is on):

| OS | Microphone in use | Which app |
|---|---|---|
| Windows 10 / 11 | `HKCU\…\CapabilityAccessManager\ConsentStore\microphone`: an app with `LastUsedTimeStop = 0` | Its package family name (`MSTeams_8wekyb3d8bbwe`) or executable path (`NonPackaged`) |
| macOS 14+ | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input | The audio process objects (`kAudioHardwarePropertyProcessObjectList`) with *running input*, by bundle id |
| macOS 13 and older | The same | Known meeting apps among the running processes (a guess, `source: fallback`) |
| Linux | `pactl list source-outputs` (PulseAudio, PipeWire-Pulse), not corked; `pw-dump` without `pactl` | `application.process.binary` |

The identity is reduced at once to a fixed app id (`teams`, `zoom`, …, `browser`) or dropped: paths and unknown apps
never reach the UI. No window titles, URLs, chats or audio are read; nothing about it is stored beyond the call's
state (app id, start, end, the answer) in local storage, and nothing is sent (only the timer you choose). Settings
shows what the last check found. `pnpm screenshots:meetings` (`MEETING_SCREENS=<dir>`) renders the questions and the
settings in Spanish, light and dark.

Everything stays on this computer except the entries you confirm — see [PRIVACY.md](PRIVACY.md). What comes next, and
what TimeTrack deliberately will not do: [docs/ROADMAP.md](docs/ROADMAP.md).

### Updates

<img src="docs/images/desktop-update-card-light.png" alt="Update card with What's new, light theme" width="200"> <img src="docs/images/desktop-update-card-dark.png" alt="Update card with What's new, dark theme" width="200"> <img src="docs/images/desktop-update-progress-light.png" alt="Update download progress" width="200">

<img src="docs/images/desktop-update-running.png" alt="Update offered while a timer runs: After I stop" width="200"> <img src="docs/images/desktop-update-required.png" alt="Update required screen with Remind me later" width="200"> <img src="docs/images/desktop-update-progress-dark.png" alt="Update download progress, dark theme" width="200">

Microsoft Store build (`TIMETRACK_CHANNEL=store`): the Store updates the app, so Settings → About and the "update
required" screen send you to the Store listing instead.

<img src="docs/images/desktop-store-about.png" alt="Settings, About: Updates come from the Microsoft Store" width="200"> <img src="docs/images/desktop-store-update-required.png" alt="Update required in the Store build: Open Microsoft Store" width="200">

## Security

- **TLS public-key pinning.** Traffic to the official Beacon host (`beacon.nowo.tech`) cannot be read or modified
  even on a network with a TLS-inspecting proxy or a rogue CA trusted by the OS: the Rust HTTP client
  (`src-tauri/src/net.rs`, `src-tauri/src/pinning.rs`) validates the chain against the compiled-in Mozilla roots and
  then requires one of the pinned CA keys (`src-tauri/pins.json`: Let's Encrypt / ISRG roots plus Google Trust
  Services as the backup CA; never the leaf, so certificate renewals every 60–90 days need nothing). On a mismatch the
  app sends nothing and shows *La conexión con Beacon no es de confianza (certificado inesperado)* / *The connection
  to Beacon is not trusted (unexpected certificate)*, with no way to continue. Self-hosted servers keep standard TLS
  validation, shown as *Connection not pinned* in Settings; `localhost` is never pinned. The update check and the
  updater use the same pinned client. Rotation runbook: [docs/PINNING.md](docs/PINNING.md).
- **Self-hosted servers need a publicly trusted certificate.** The app trusts only the Mozilla root store compiled
  into it (`webpki-roots`), never the OS trust store. A self-hosted Beacon behind a private or corporate CA (or a
  self-signed certificate) is **not supported**: sign-in, API calls, the update check and in-app updates all fail
  with a certificate error. Use a certificate that chains to the Mozilla root store (for example Let's Encrypt).
- **Bound to your server.** Every request the app makes and the updater go to the origin (scheme, host, port) of the
  server you signed in to, and nowhere else; switching servers means signing out first. The session token stays
  in Rust with the server that issued it, so even script running in the window cannot read it or send it elsewhere;
  script itself is prevented by the CSP and the text-only DOM (SECURITY.md, *Credentials*). Plain `http://` to `localhost`,
  `127.0.0.1` or `[::1]` works in development (debug) builds only; release builds require `https://`.
- Reporting and design notes: [SECURITY.md](SECURITY.md).

## Tauri capabilities

- **Every app command is ACL-scoped.** `src-tauri/build.rs` declares them in the app manifest
  (`tauri_build::AppManifest::commands`, list in `src-tauri/app-commands.rs`), so Tauri only lets a window call the
  commands its capability grants (`allow-<command>`); without a manifest any local window could call any command.
  A Rust test checks the list against `generate_handler!` and that each command is granted to exactly one window.
- `src-tauri/capabilities/default.json`, window `main`: core defaults, `beacon_fetch` (every request to your server,
  through the pinned Rust client, only to the origin bound with `beacon_bind` at sign-in; there is no HTTP plugin
  permission), `beacon_bind` and `connection_security`,
  `clipboard-manager:allow-write-text` (*Copy link*), `notification:default`, no autostart permission (*Start at
  login* goes through the app commands `set_autostart` / `get_autostart`), process restart, set theme, and the app
  commands
  `secret_status` / `sign_in_begin` / `secret_delete` (whether a session token is stored, start a sign-in, sign-out;
  no command returns the token, which Rust keeps with the origin that issued it and adds only to requests to that
  origin, `src-tauri/src/secret.rs`), `idle_seconds`, `set_tray_status`, `set_tray_menu`,
  `set_global_shortcut`, `check_update`, `install_update`, `set_wake_plan`, `notify_friendly`, `prompt_open`,
  `prompt_focus`, `prompt_close`, `open_external`, `list_browsers`, `get_browser`, `set_browser`, `pick_browser` (every
  link, in the system default or the chosen browser, launched with an argv array from Rust; no opener permission for
  the webview). The browser choice is kept by Rust (`browser.json`): `open_external` takes only the URL, `set_browser`
  only the default or a detected browser's id, and a custom browser comes only from the native file dialog Rust opens
  itself (`pick_browser`, so no `dialog:allow-open` for the webview); shells, interpreters and launchers are refused. The desktop notifications of the friendly messages go through the app's own
  `notify_friendly` command (Rust, `notify-rust` / `tauri-winrt-notification`), not a new plugin permission.
  The working-hours reminders add no command: their *Start* / *Stop* / *Resume* button travels in `notify_friendly`
  (ids allow-listed in Rust, `notify::ACTION_IDS`) and a press comes back as a `notification-action` event emitted
  to the `main` window only; the next reminder instant rides on `set_wake_plan` (`reminderAt`).
  Meeting detection adds no command and no permission either: the UI turns it on with `set_wake_plan`
  (`micEverySeconds`), the heartbeat sends `mic` events (known app ids only) to the `main` window, and its
  notification buttons (`meeting-generic`, `meeting-switch`, `meeting-back`, `meeting-stop`) join `notify::ACTION_IDS`.
- No tray permission for any window: `default.json` lists the core defaults one by one (`core:app`, `event`, `image`,
  `menu`, `path`, `resources`, `webview`, `window`) instead of `core:default`, which includes `core:tray:default` and
  would let the webview create a second tray icon. The tray is built once, in Rust (a Rust test checks both).
- `src-tauri/capabilities/prompt.json`, window `prompt` (the "Still there?" window): `core:event:allow-listen` /
  `allow-unlisten` (its content) and `prompt_view`, `prompt_answer`, `prompt_show_main` ("Open TimeTrack"). No
  keychain, updater, tray, network, opener, notification, window or autostart permission.
- Defence in depth: every command also checks the calling window's label (`main` for the keychain, updater, tray,
  shortcut, heartbeat, notifications and opening / focusing / closing the prompt; `prompt` for reading its view,
  answering and "Open TimeTrack"). Answers are allow-listed (`{ action, note?, taskId? }`), pose ids are looked up in
  the compiled-in list (never a path from the webview) and notification texts are capped. On Linux, notification
  bodies are escaped to plain text (`<`, `>`, `&`), since servers with `body-markup` would render markup from a task
  title.
- `tauri.conf.json`: the main window has `backgroundThrottling: "disabled"` (macOS 14+, where WebKit supports it); the
  heartbeat keeps the checks on time on every OS anyway.

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
pnpm screenshots          # regenerates docs/images/*.png (real UI, fake platform, mock Beacon, placeholder data)
(cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
```

The mock's device page is `http://127.0.0.1:8787/device` (approve the code shown by the app). `src/api/` is shared
verbatim with [time-track-extension](https://github.com/nowo-tech/time-track-extension).

## Release

Bump `package.json` and `CHANGELOG.md`, merge, push a `vX.Y.Z` tag. `.github/workflows/release.yml` (tags only) builds
Linux and Windows first, macOS (universal) last, then uploads every file to `time-track-clients/desktop/<version>/` and
writes `time-track-clients/desktop/channel/stable.json` last. Updater signing is required: the build fails without
`TAURI_SIGNING_PRIVATE_KEY` or while `src-tauri/tauri.conf.json` still has the updater public key placeholder
(`pnpm release:check`). A missing S3 secret skips the upload with a notice. Microsoft Store: `pwsh
scripts/store/build-msix.ps1` on Windows (`TIMETRACK_CHANNEL=store`, no in-app updater), upload in Partner Center. Full
steps: [docs/RELEASE-PLAN-0.4.0.md](docs/RELEASE-PLAN-0.4.0.md).

| Name | Kind | Used for |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secrets | updater signatures (`pnpm tauri signer generate -w ~/.tauri/timetrack.key`) |
| `TAURI_UPDATER_PUBKEY` | variable (optional) | overrides the public key committed in `tauri.conf.json` (`plugins.updater.pubkey`) |
| `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER`, `MSIX_PUBLISHER_DISPLAY_NAME`, `TIMETRACK_STORE_URL` | variables (optional) | Microsoft Store package (Partner Center → Product identity) |
| `TIME_TRACK_S3_ENDPOINT`, `TIME_TRACK_S3_BUCKET`, `TIME_TRACK_S3_ACCESS_KEY_ID`, `TIME_TRACK_S3_SECRET_ACCESS_KEY` (+ optional `TIME_TRACK_S3_REGION`) | secrets | upload (`s3:PutObject` on `time-track-clients/*` only) |
| `BEACON_URL` | variable | prefilled server URL |
| `TIME_TRACK_MIN_SUPPORTED_VERSION` | variable (optional) | `min_supported_version` in `stable.json` |
| `LINUX_RUNNER`, `WINDOWS_RUNNER`, `MACOS_RUNNER` | variables (optional) | JSON `runs-on` value per platform, e.g. `["self-hosted","linux","x64","tauri-build"]`; default `"ubuntu-22.04"`, `"windows-latest"`, `"macos-latest"` |
| `WINDOWS_BUILD`, `MACOS_BUILD` | variables (optional) | `false` skips that platform (no entries for it in that version's `stable.json`) |

Self-hosted runners (build runner spec in `nowo-tech/devops`, spec 024): ephemeral, scoped to this repository, never
the production deploy runner (`prod-vps`). Linux images must carry the Tauri system libraries (webkit2gtk-4.1,
ayatana-appindicator, librsvg, xdo, patchelf), rustup and the AWS CLI; Windows hosts need VS Build Tools (C++),
WebView2, rustup, Git for Windows (`bash`) and PowerShell 7. The workflow only runs on `v*.*.*` tags, never on pull
requests.

Docs: [CHANGELOG](CHANGELOG.md) · [PRIVACY](PRIVACY.md) · [ROADMAP](docs/ROADMAP.md) · [SECURITY](SECURITY.md) · [CONTRIBUTING](CONTRIBUTING.md)

License: [MIT](LICENSE). Third-party notices (`webpki-roots`, CDLA-Permissive-2.0):
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
