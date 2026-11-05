# Changelog

All notable changes to this project are documented here ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[Semantic Versioning](https://semver.org/)).

## [Unreleased]

Likely 0.5.1.

### Fixed

- **Two TimeTrack icons in the Windows tray** (two copies running in the background). Causes and fixes:
  - No single-instance guard: opening TimeTrack from the Start menu or a shortcut while it was hidden in the tray
    started a second copy. `tauri-plugin-single-instance` (2.5) is now the first plugin: a second launch exits at
    once and shows, unminimises and focuses the running window; a second start at login (`--hidden`) just exits
    (`on_second_launch`, `src-tauri/src/lib.rs`). Windows: per-session named mutex; macOS: local socket; Linux: D-Bus
    name on the session bus (no session bus: the app starts unguarded, as before; AppImage and .deb alike).
  - Duplicate start-at-login entries: the autostart plugin writes one `Run` value named `TimeTrack` with the
    executable path at the time; older installs can leave others (the 0.1.0 `.msi` copy in Program Files, which the
    0.5.0 installer left in place when that copy was kept; a per-machine `HKLM` value written by an elevated copy; a
    value under another name). At start, an installed copy (release build, direct-download channel, running from
    `%LOCALAPPDATA%\TimeTrack` or `Program Files\TimeTrack`) keeps *Start at login* as one `HKCU` value for itself,
    with the path quoted, and removes the app's other entries (`HKLM` only when allowed; new
    `src-tauri/src/autostart.rs`, unit-tested). Only the app's own entries are touched (value name `TimeTrack` /
    `time-track-desktop`, executable `TimeTrack.exe` / `time-track-desktop.exe`, in an install folder); an HKCU
    `TimeTrack` value of another product is never overwritten. Task Manager's *Disabled* (`StartupApproved\Run`) is
    kept, also when the disabled entry was the one removed; start-at-login is never switched on when none of the
    app's entries existed. The installer (`windows/installer-hooks.nsh`) now moves the app's value pointing at the
    0.1.0 copy to this install also when that copy is kept, and removes the app's per-machine `TimeTrack` value when
    it runs with administrator rights; both only for a command starting the app's executable in a `TimeTrack` folder.
  - macOS: the plugin's socket lives in the shared `/tmp` (not configurable upstream): another local account could
    keep TimeTrack from starting. Documented in SECURITY.md → *Known limitations* and reported upstream.
  - Tray created twice in one process: it never was (one `TrayIconBuilder`, from `setup`), now guarded by id, and the
    main window no longer gets `core:tray:default` through `core:default` (the core defaults are listed one by one
    without the tray), so the webview cannot create another tray icon. Rust tests check all three.
- `installer-upgrade-test.yml` / `scripts/windows/upgrade-test.ps1`: from 0.5.1 on, each scenario seeds the
  start-at-login entries older versions could leave and checks that exactly one `HKCU` `TimeTrack` value (quoted) for
  the new executable remains once the app has started, and that a second launch exits at once with one process left.
  Two new scenarios: an entry disabled in Task Manager (stays disabled) and another vendor's "TimeTrack" entries
  (left untouched).
- README → *Two TimeTrack icons in the tray*: how to check and remove duplicates by hand on Windows.

## [0.5.0] - 2026-11-05

**Upgrading on Windows from 0.1.0 (`.msi`):** the in-app update installs in passive mode, so it removes a leftover
0.1.0 `.msi` install **without asking first**; Windows then shows an **administrator (UAC) prompt** in the middle of
the update (that copy was installed for all users in Program Files). Approve it to remove the old copy, or decline and
remove *TimeTrack* 0.1.0 later from Settings → Apps. Installing 0.5.0 by hand asks before removing it.

**"Continue last" shortcut:** the default is now **Ctrl+Alt+T** on Windows, **⌘⌥T** on macOS (⌘⌥Space of the
previews is Finder search) and **Ctrl+Alt+Shift+R** on Linux (Ctrl+Alt+T opens a terminal on Ubuntu / GNOME; the
window shortcut stays Ctrl+Alt+Shift+T). A stored shortcut still at the old default moves to the new default of its
system, any other is kept.

### Added

- **Compact and full window views** (`src/lib/layout.ts`). Below 900 px the window keeps the quick tracker: one
  column, at most 33rem wide and centred, so a window a bit wider never shows a stretched, empty UI. From 900 px (and
  signed in) the full desktop view takes over: a sections sidebar (*Tasks*, *Pinned & recent*, *My time*, *Settings*),
  the task list with the running timer pinned to the top of its pane, and a detail pane with the selected (or running)
  task — Start / Switch / Stop, Pin, Open in Beacon, its time today and this week, today's entries on it — and the week
  by day. *My time* lists today's entries of every task and the week by day; *Settings* opens as a page in the main
  pane. Everything comes from the entries the app already reads (`src/lib/week.ts`), computed locally.
- **"Compact view" / "Full view" toggle** in the header, in the tray menu (`layout-full` / `layout-compact`) and with
  Ctrl/⌘+Shift+L: the window is resized to the size remembered for that view (else 400 × 640 or 1200 × 780), kept on
  a screen it fits on or centred on the current one, never larger than the work area. The view, size and position of
  each view are remembered per device (`time-track-desktop.window` in local storage; removed by *Clear local data*;
  listed in *What we collect*); maximised or minimised windows are not remembered. Capabilities
  `core:window:allow-set-size`, `allow-set-position` and `allow-unmaximize` (main window only).
- Keyboard and screen readers in the full view: F6 / Shift+F6 move between the sidebar, the main pane and the detail
  pane; arrow keys or a click on a row show that task in the detail pane (the row is marked `aria-current`); landmarks
  `nav` (Sections), `main` and `aside` (Task details); the week is a list with the time as text (the bars are
  decorative) and today marked `aria-current="date"`. Panes are inert behind the "Still there?" modal. English and
  Spanish.
- Tests: `tests/unit/layout.test.ts`, `tests/unit/layout-app.test.ts`, and `tests/e2e/layout.spec.ts` (400 × 640 and
  1280 × 800 in light and dark: no horizontal scroll, panes never overlap, axe; view toggle, Ctrl+Shift+L, F6).
  `pnpm screenshots:layout` writes Spanish review screenshots of both views and the width in between. The mock
  server gets `POST /__mock/entries/seed`.
- **Continue last** (desktop quick win Q1–Q3): the stopped timer card's button now reads *Continue last* and shows the
  global shortcut; a second global shortcut (`set_global_shortcut` slot `resume`, default `CommandOrControl+Alt+T`, `CommandOrControl+Alt+Shift+R` on Linux,
  Settings → *Continue, reminders and lock*) starts the last task again as a new entry with the window hidden. The
  tray's elapsed time is refreshed every minute by the Rust heartbeat (`tray_clock.rs`; `set_tray_status` takes an
  optional `clock` with the start and the translated templates): menu-bar title on macOS, tooltip everywhere.
- **Three answers on return from idle** (Q4): *Keep* · *Discard* (stop at the idle start) · *Reassign* with a task picker
  (pinned, recent, search run by the main window, quick *Meeting* choice) in the prompt window and the in-app modal;
  the idle span becomes its own entry through the queue and the API client (`discard-idle` `reassign` `then:
  continue`, or four backdated stops / starts without `features.idle_reassign`). The gap question uses the same
  picker. New prompt actions `reassign-open` / `-cancel` / `-search` / `-save` and the `query` answer field
  (`prompt.rs`). The prompt is not redrawn for an identical view (a typed note, search or choice survives a tick).
- **Pause on screen lock or sleep** (Q6, on by default): OS events in `session.rs` behind `SessionSource` /
  `SessionSink` (Windows WTS session notifications and power broadcasts on a hidden window, macOS
  `com.apple.screenIsLocked` / `screenIsUnlocked` and workspace sleep / wake, Linux logind `Lock` / `Unlock` /
  `LockedHint` / `PrepareForSleep`), sent to the UI as `session-event`; the lock time counts as idle and the three
  answers follow on return (`lockReturn`, `src/lib/idleChoices.ts`).
- **"Working without a timer?"** (Q5, on by default): input for N minutes (5–30, default 10) during working hours with
  no timer → a notification with *Start <last task>* / *Choose task* (two buttons, `notify.rs` `actions`), at most
  once every 45 minutes, not on days off, at lunch, while paused or right after another message; no *Start* when the
  last task was a meeting. Lines and poses in the seven languages (`src/lib/nudge.ts`, `nudge` in `messages/*.ts`).
- `docs/ROADMAP.md`: the recommended next steps with status, owner component, value, effort and privacy risk, the
  items considered but not scheduled, and what TimeTrack deliberately will not do (worker trust, GDPR, Estatuto de
  los Trabajadores, LOPDGDD).

- **Light and dark theme switch**: Settings → Theme, *System* (default) / *Light* / *Dark*, stored locally
  (`settings.theme`), applied before the first screen and to the native window (title bar) through Tauri's
  `Window.setTheme` (capability `core:window:allow-set-theme`). Every colour comes from the CSS tokens; text pairs keep
  WCAG AA in both themes and the new `--control-border` token gives inputs and buttons a ≥ 3:1 outline.
- **Mascot moments**, the way symfony-beacon uses its robot: "You're in!" after signing in, a friendly saved notice
  after Stop (three wordings), a calm "Still going strong?" nudge on a timer running for 8 hours or more (*Stop now* /
  *Keep going*, never stops by itself), "Working offline" card, new poses for an expired code, no search results, the
  idle check (paused / resume), server errors, unreachable server and updates (downloading, required). Six new poses
  cropped from Beacon's illustrations (`pose-card`, `pose-hourglass`, `pose-reading`, `pose-wrench`, `pose-reconnect`,
  `pose-pause`, 1x / @2x WebP, `scripts/mascot/build.py`); catalogue in `src/ui/mascot.ts`, provenance and rules in
  `public/mascot/README.md`. Decorative art is `aria-hidden`; only the device-code arcs move, and not with reduced
  motion. English and Spanish.
- Screenshots of the key screens and moments in light and dark (`tests/screenshots/moments.spec.ts`).
- **Friendly messages** (`src/lib/friendly.ts`, pools in `src/lib/messages/`), native in English, Spanish, German,
  French, Italian, Dutch and Portuguese. The language is the Beacon user's (`GET me.locale` when the server sends it),
  else the UI language, else English; times are read in the Beacon user's time zone (`me.workingHours.timezone`, else
  `me.timezone`, else the system's).
  - **"Still there?"** gets a random phrasing under its heading (16 per language); facts, buttons and labels unchanged.
  - **Toasts** (bottom right, 72 px pose, one or two lines, × to dismiss, `aria-live="polite"`, never focused):
    cheers on long stretches (2 h, then every 2 h; milestones with a medal / pom-poms at 2 h and 4 h,
    `MILESTONE_HOURS`; "take a real break" from 6 h, `OVERTIME_FROM_HOURS`, without any figure), a few
    stretch / water / eye-break / breathing nudges, and time-of-day moments: early start, mid-morning and mid-afternoon
    coffee, lunch, late work, Friday afternoon (and holiday eve art), weekend start and "enjoy the rest of your
    weekend". Windows are per-language constants (Spanish lunch 14:00–15:30, German coffee at 15:00, …).
  - **Meetings and dailies**: the task kind (daily, meeting, technical session such as planning / retro / demo /
    sprint review, training) comes from Beacon's `type` / `kind` / `labels` / `tags` when present, else from words in
    the task name (per-language tables plus English, whole words, accents ignored; a plain "review" is work, not a
    meeting). While such a task runs the prompt is the softer "Still in the meeting?" with the teamwork pose and a
    longer countdown; a meeting of 60 min or more makes the next toast a coffee / stretch line; stopping a daily shows
    a short "daily done, let's go!" toast.
  - Rules: at most one toast every 50 minutes (`MIN_GAP_MINUTES`; the idle prompt and the daily toast are not counted),
    each moment once per window per day, no line repeated among the last six of its pool (history in local storage),
    toasts expire after 30 minutes and never show over the idle prompt or the 8-hour nudge.
  - Settings → **Friendly messages**: *Fun messages* and *Wellbeing reminders*, both on by default.
- **"Still there?" is a modal with a countdown**: the prompt now needs an answer (focus moves to it, the rest of the
  window is inert) and shows the time left as text and a bar (announced once, no motion with reduced motion). The
  countdown is `IDLE_COUNTDOWN_MINUTES` (2, never longer than the organisation's answer timeout) or
  `MEETING_COUNTDOWN_MINUTES` (10, never shorter) during meetings, on the wall clock: when it ran out while the window
  was hidden or the computer slept, the timer still stops at the start of the idle time. After the stop the modal says
  "I stopped your timer at …" with **Resume … now** (a new entry on the same task from now) next to the existing
  keep / reassign / discard options. Checks are serialised, so a stop in flight is never mistaken for a new timer.
- **Mascot art for the friendly messages**: 40 poses (`POSE_IDS`) from the owner's art in `public/mascot/pose-<id>.webp`
  (+ `@2x`), listed in `src/ui/pose-art.json`; beach, sofa and park keep a fallback until their art exists
  (`POSE_FALLBACK`). `scripts/mascot/import-poses.sh <dir>` imports `pose-<id>.png`: an opaque white background becomes
  transparent (flood fill from the corners), disconnected fragments far from the character are dropped (connected
  components; props near it such as steam, sparkles or a leaf stay) with their glow, then trim and WebP 96 / 192 px
  (cwebp + ImageMagick, in Docker when not installed).
- `pnpm screenshots:friendly` (`FRIENDLY_SCREENS=<dir>`): every friendly situation in Spanish, light and dark, with an
  overview sheet, for review (not documentation).

- **Runs in the background, from the tray**: closing or minimising the window keeps TimeTrack running; the tray icon
  sits in the Windows notification area (bottom right, like Docker Desktop), the macOS menu bar and the Linux
  StatusNotifier / AppIndicator, shows running / stopped in its icon and tooltip, and a left click shows or hides the
  window. The tray menu adds *Pause friendly messages for 1 h* (then *Friendly messages paused until … · Resume*).
  Optional start at login stays off by default (tauri-plugin-autostart, starts hidden in the tray).
- **Wall-clock heartbeat in Rust** (`src-tauri/src/heartbeat.rs`): the 30 s check, the end of the "Still there?"
  countdown and the idle threshold wake the UI on time while its window is hidden (a hidden webview may throttle its
  timers), and a sleep is noticed at once. The webview's own 30 s `setInterval` is gone in the Tauri app (kept in a
  plain browser). Rust unit tests with a fake clock.
- **Friendly messages as native desktop notifications** (`src-tauri/src/notify.rs`): short localized title (7
  languages), the line as body, the mascot pose as the picture (Windows toast app logo under the app's AUMID, for the
  NSIS install and the MSIX / Store package; macOS content image; Linux `image-path` hint); a click brings the window
  forward. Permission asked on first need with a one-time explanation in the window; denied or failing → the in-app
  toast, and Settings → Friendly messages says so (*Try again*). New switch *Show them as desktop notifications* (on),
  *Pause for 1 h* in Settings and the tray. Pictures: `scripts/mascot/notification-art.sh` (96 × 96 PNG, compiled in).
- **"Still there?" in its own window**, always on top and centred on the monitor under the pointer, shown with the
  main window in the tray (`src-tauri/src/prompt.rs`, `src/ui/prompt.ts`, `src/ui/promptWindow.ts`): same content,
  countdown, auto-stop and *Resume … now*; exactly one, closed once answered, its close button refused, Esc never
  dismisses it (it says an answer is needed); on Windows it re-asserts always-on-top and requests attention (taskbar
  flash) against focus-stealing prevention. The main window shows "the question is open in its own window" with
  *Show the question*. Where no window can be opened, the in-app modal is used as before. New capability
  `prompt.json` (event listen only); see README → Tauri capabilities.
- `pnpm screenshots:native` (`NATIVE_SCREENS=<dir>`): mock-ups of the Windows 11, macOS and GNOME notifications, the
  prompt window over a desktop (fresh, mid-countdown, paused) and the Windows tray menu, light and dark.

- **Working-hours reminders** (`src/lib/schedule.ts`, texts in `src/lib/messages/` → `reminders`, `src/lib/reminders.ts`):
  - **Start time** ("¿Empezamos? Última tarea: X", *Start* resumes the last task; skipped when a timer already runs;
    optional lead of 5 / 10 / 15 min), **lunch** ("Hora de comer, ¿paro el temporizador?" with *Stop* while a timer
    runs; "¿Retomamos X?" with *Resume* when it ends) and **end of the day** ("¿Cerramos por hoy?" with *Stop* and the
    total tracked today; it replaces that evening's "it's getting late" card). Native in the 7 languages, four
    phrasings per moment, no repeats, poses early / sunrise, lunch, finished, shades / holiday.
  - **Schedule**: Beacon's `GET me.workingHours` by default (the gap between two slots of a day is the lunch break;
    both the `slots` shape and TimeTrackBundle's documented `days` shape are read), adjustable per weekday in
    Settings → **My schedule** (start, end, lunch from / until, day off). Local values are stored on this computer
    only, marked *This computer* next to Beacon's, and *Reset to Beacon's schedule* drops them. The last Beacon schedule
    is kept for an offline start; signing out forgets it and the local changes.
  - **Holidays and vacations**: no schedule reminders on them. Read from the forward-compatible `GET me.daysOff`
    (`[{date, kind: 'holiday' | 'vacation', label?}]`, not sent by TimeTrackBundle 1.11 yet) plus days off marked in
    Settings. A timer started on one gets a single "¿Trabajando en vacaciones?" line that day.
  - **Delivery**: a desktop notification with the mascot pose and **one button** (Windows toast button, Linux
    notification action, macOS action; ids `schedule-start` / `schedule-stop` / `schedule-resume` only, anything else
    is dropped in Rust) that starts or stops the timer without opening the window; the in-app toast with the same
    button when notifications are off, refused or failing.
  - **Timing**: in the schedule's time zone (`me.workingHours.timezone`, else `me.timezone`, else the system's), DST
    aware (a time that does not exist moves forward, a repeated one counts once). The Rust heartbeat wakes the UI at the
    next reminder (`WakePlan.reminderAt`, `WakeReason::Reminder`); after a sleep a reminder fires only within 15 min of
    its time (`REMINDER_GRACE_MINUTES`), never hours later, and each fires once per day. A reminder whose condition does
    not hold when it comes due is skipped for the day.
  - Rules: own switch *Working-hours reminders* (on by default) and the 1 h pause; they bypass the 50-minute gap of the
    friendly messages (they are functional) and start it for the cards after them; never over the "Still there?"
    question.
  - Tests: schedule merge, lunch from slot gaps, each reminder's conditions, days off, DST, time zones, sleep grace, no
    duplicates, the buttons (Rust and TypeScript). `pnpm screenshots:schedule` (`SCHEDULE_SCREENS=<dir>`) renders
    Settings → My schedule, the four reminders as Windows toasts and the in-app toast, light and dark, in Spanish.
  - Mock server: `daysOff` and `locale` on `GET me` (config).

- **Open Beacon in** (Settings): *System default browser* (default), one of the browsers installed on this computer, or
  *Custom…* (native file dialog opened by the app: an `.exe` on Windows, an `.app` on macOS, an executable on Linux). Every link the app opens goes through one helper
  (`App.openExternal` → Rust `open_external`): Beacon, My time, task links, *Open the page again* and the sign-in page,
  the Apps / Store pages, the tray items, and any `target=_blank` / `window.open` / navigation the webview tries on its
  own (refused by the window and handed to the helper). Detection (`src-tauri/src/browser.rs`): Windows
  `StartMenuInternet` (HKCU / HKLM, incl. `WOW6432Node`) plus `App Paths`; macOS LaunchServices https handlers
  (`LSCopyAllHandlersForURLScheme`); Linux `.desktop` entries with `x-scheme-handler/https` in the XDG data dirs plus
  the Flatpak and Snap export dirs (Brave, Firefox, Chrome, Chromium, Edge, Vivaldi, Opera, Safari …). Kept per
  computer by the Rust side (`browser.json` in the app's config folder). A chosen browser that is gone falls back to the system default with a notice, and
  Settings marks it *(not found)*.
- **Copy link** next to My time, the running task's link and *Open the page again*, plus a right-click / long-press
  menu (*Open in the browser* / *Copy link*) on every Beacon link. Copied with the clipboard-manager plugin
  (write-text only); short confirmation in the status region (`aria-live`, never focused). When no browser opens,
  the link is copied instead ("The browser could not be opened — link copied"). Copied links keep the same checks as
  opening and drop user info, secret-looking query parameters (`token`, `key`, `signature`, `code` …) and
  `#access_token=…` fragments.
- **Empty states with the mascot** for the list: nothing pinned (tracked before) → *Pin a task* (scrolls to the list
  and points at the pin), never tracked → *Start a timer* (focuses search), no task at all → *Open the tasks in
  Beacon*. One fixed-height slot, the same 72 px picture (1x / 2x WebP) in the three; one line and one action in the
  friendly-message language (7 languages). New owner art, imported with `scripts/mascot/import-poses.sh`: a
  thumbtack (`pose-empty-pinned`), a stopwatch (`pose-empty-recent`) and a blank clipboard (`pose-empty-tasks`), each
  with a `-dark` variant with a light outer stroke shown in the dark theme (CSS follows Settings → Theme and the system).
  The mapping is data (`EMPTY_POSES`), with `peek-3` / `focus` / `teamwork` as fallbacks. `pnpm screenshots:links`
  (`LINKS_SCREENS=<dir>`) renders them and the new
  settings, light and dark, in Spanish.
- **Meeting detection** (opt-in, off by default, dated consent; Settings → Meetings): when a known meeting app (Teams,
  Zoom, Webex, Slack, Discord, Skype, GoTo, Jitsi Meet) or a browser call holds the microphone for 2 minutes
  (configurable 1 / 2 / 5 / 10), a desktop notification (falling back to an in-app toast) with the teamwork pose asks
  "Looks like you're in a meeting (Teams). Which meeting is it?": *Choose task* (meeting-like tasks first, pinned,
  recent, search), *Generic meeting* (asked once, then remembered), *Not a meeting*, *Don't ask for this app*; with a
  non-meeting timer running, *Switch to the meeting*. Nothing is asked while a meeting-like task already runs. When the
  microphone stays free for a minute: "Meeting over (32 min). Back to <previous task>?" with *Back* / *Stop*. During
  the call the "Still there?" prompt is the softer meeting one. Questions respect the 1 h pause, the "Still there?"
  question, working hours / days off (with no timer running) and a 10-minute gap. Texts in the seven message languages,
  UI in English and Spanish.
  - Rust: `src-tauri/src/meeting/` with a `MicDetector` per OS (Windows microphone consent store via `winreg`, macOS
    CoreAudio default input + process objects on 14+ with a running-apps fallback, Linux `pactl` / `pw-dump`), pure
    parsers tested on recorded fixtures (`src-tauri/tests/fixtures/meeting/`). Polled by the heartbeat every 20 s
    (`WakePlan.micEverySeconds`, clamped to 15–30 s) only while the switch is on; `mic` events carry app ids only. No
    new command or capability.
  - UI: `src/lib/meetings.ts` (state machine: debounce, end grace, rate limit, notes), `src/ui/meetings.ts` (toast,
    picker, Settings), `pnpm screenshots:meetings`.

### Security

- Links no longer go through the opener plugin's JavaScript API: the `opener:allow-open-url` permission is gone from
  the main window. `open_external` (main window only) re-checks the URL (https, or http to this computer; no
  credentials, no quote / `$` / backtick / backslash / control characters), launches a chosen browser with an argv
  array (never a shell; `open -a <app> <url>` on macOS) and resolves a detected browser from the OS again by id, so the
  webview never supplies a command line. New permissions, main window only: `clipboard-manager:allow-write-text` and
  the commands `open_external`, `list_browsers`, `get_browser`, `set_browser`, `pick_browser`; the prompt window gets
  nothing new and refuses navigation and new windows.
- The browser choice is kept on the Rust side, not taken from the webview (security review 2026-11-05, GC-L1):
  `open_external` takes only the URL and reads the choice from `BrowserState` (`browser.json` in the app's config
  folder). `set_browser` accepts only the system default or the id of a browser detected again on this computer;
  a custom browser is chosen only in the native file dialog that Rust opens itself (`pick_browser`), so the webview has
  no `dialog:allow-open` permission and never passes a path. A custom browser must be an absolute path to an existing
  regular file: an `.exe` outside `C:\Windows` on Windows, an `.app` bundle with `Contents/Info.plist` on macOS, a
  file with an execute bit on Linux; shells, interpreters and launchers (`sh`, `bash`, `env`, `python3`, `perl`,
  `xdg-open`, `cmd`, `powershell`, `mshta`, `rundll32` …) are refused, also behind a symbolic link. It is checked again
  before every launch, and the resolved path that was checked is the one launched (GC-I7). *Clear local data* resets it to the system default.
- `platforms.yml` runs Rust clippy and tests on hosted Windows and macOS for pull requests that touch `src-tauri`
  and by hand; ci.yml keeps Linux (GC-I4).
- Linux `.desktop` entries whose `Exec` hands the URL to a shell (`sh -c "browser %u"`, `bash -lc …`, or the URL inside
  a quoted command string, which the Desktop Entry spec forbids) are not offered as browsers (GC-I1).
- Signing out also deletes the last task, the pinned tasks, the "Working without a timer?" state and the generic
  meeting task (GC-L2), so a previous account's task titles never reach the next person's notifications, buttons or
  "Continue last".
- App commands are ACL-scoped (security review 2026-11-05, FN-L1): `build.rs` declares them in the app manifest
  (`src-tauri/app-commands.rs`) and each capability grants its window only its own (`main`: keychain, tray,
  shortcut, updater, heartbeat, notifications, opening the prompt; `prompt`: `prompt_view`, `prompt_answer`,
  `prompt_show_main`). The commands also check the caller's window label.
- Signing out deletes the friendly-message history, whose slots name entries by task id and start (FN-L2); PRIVACY.md
  says exactly what it holds.
- Linux notification bodies are escaped to plain text, so a task title cannot become markup on servers with
  `body-markup` (FN-I4).
- The prompt window has an *Open TimeTrack* link; README and PRIVACY say it shows the task title, visible on a shared
  screen (FN-I5).

### Changed

- The main window opens at 400 × 640 and can no longer be made smaller than the compact layout (`minWidth` 380,
  `minHeight` 560, was 360 × 480). The "Still there?" window keeps a fixed size (no longer resizable).
- Overtime lines ("take a real break", from 6 h) carry no figure at all in any language: no hour count, no "ten
  minutes" (owner decision); a test enforces it.
- The in-app toast (fallback) reserves room below the page while it is visible, so it never covers the last task rows.
- Lighter microcopy for an expired code, an empty task list and no search results; "Nothing on the clock yet" in the
  idle timer card on first run; the empty "Pinned and recent" line no longer repeats the mascot.

- Documentation screenshots regenerated from the 0.4.0 UI with `pnpm screenshots` (`playwright.screenshots.config.ts`,
  `tests/screenshots/`): placeholder Beacon `https://beacon.example.test` and neutral demo data; new images of the
  Microsoft Store build (Settings → About, update required). The e2e tests no longer write screenshots.

### Fixed

- **Windows: upgrading from 0.1.0.** 0.1.0 was built without `bundle.publisher`, so Tauri registered it under the
  manufacturer "nowo"; 0.4.0 sets "nowo.tech". The 0.4.0 installer therefore (a) offered *Uninstall before installing*
  for a 0.1.0 per-user install, read the install folder from the new `HKCU\Software\nowo.tech\TimeTrack` key, found
  nothing, ran `uninstall.exe _?=` and stopped with "Unable to uninstall!", and (b) never noticed a 0.1.0 `.msi`
  install (per machine, Program Files), which stayed next to the new per-user one (two *TimeTrack* entries in
  Settings → Apps). Reproduced on GitHub-hosted Windows runners with the 0.1.0 and 0.4.0 release installers.
  NSIS installer hooks (`src-tauri/windows/installer-hooks.nsh`, `bundle.windows.nsis.installerHooks`) now, before
  Tauri's pages: point the new key at a 0.1.0 per-user install, so the upgrade lands in the same folder and the
  uninstall choice works; and, for a 0.1.0 `.msi`, ask to remove it (`msiexec /x {ProductCode} /passive`, Windows asks
  for administrator approval; the old copy, tray included, is closed first), with a message saying how to remove it by
  hand when that fails or is declined. After installing, the stale 0.1.0 key is deleted (unless that `.msi` is still
  installed) and a *start at login* entry pointing at the removed Program Files copy follows the app. Identifier,
  publisher and per-user install mode are unchanged (a unit test pins them); the in-app updater route (`/P /UPDATE`)
  is unchanged. A running app (tray included) is closed by the installer before files are replaced.
- Manual Windows upgrade test (`.github/workflows/installer-upgrade-test.yml`, `scripts/windows/upgrade-test.ps1`):
  installs 0.1.0 (MSI, NSIS or both) or the previous release on a clean runner, optionally with the app running,
  upgrades silently (`/S`), the updater's way (`/P /UPDATE`) or through the installer UI, and checks the exit code, a
  single Uninstall entry with the new version, no MSI left and that the app starts.

## [0.4.0] - 2026-11-04

Zero-cost signing and auto-update (owner decision 2026-11-04). Plan, Beacon changes and owner steps:
[docs/RELEASE-PLAN-0.4.0.md](docs/RELEASE-PLAN-0.4.0.md).

### Added

- **Signed auto-update** from Beacon's updater route (`time_track_client_updater`): `createUpdaterArtifacts` on, so
  every AppImage / NSIS `-setup.exe` / macOS `.app.tar.gz` ships with a minisign `.sig`; the app verifies it (and the
  signed version) with the public key built in. Checks at start, every 6 hours and on demand (**Check for updates…** in
  the tray, **Check for updates** in Settings → About).
- **Update card**: calm, non-blocking, with the mascot — "Version X is available", **What's new** (release notes),
  **Update now**, **Later**; download progress, then "Installing… TimeTrack will restart". English and Spanish; polite
  announcements; axe-checked in light and dark.
- **Never interrupts a running timer without asking**: *Update now* while tracking offers **After I stop** (installs as
  soon as the timer stops, from anywhere) or *Update now* (the timer keeps running in Beacon).
- **Forced update from `GET me`**: `minSupportedVersion` counts like the updater's minimum (the strictest wins); the
  "Update required" screen gains the mascot and, with a timer running, **Stop the timer, then update**.
- **Microsoft Store channel** (`TIMETRACK_CHANNEL=store`): no in-app updater, no autostart switch, About → *Open
  Microsoft Store*; a forced update opens the Store listing. `scripts/store/build-msix.ps1` +
  `scripts/store/msix-manifest.mjs` build the MSIX (the Store re-signs it: no certificate needed).
- `pnpm release:check` (`scripts/release/check-updater-key.mjs`, also the first step of every `tauri build`): a release
  build fails while `tauri.conf.json` still has the updater public key placeholder or the key is not a minisign key.
- macOS first-open guide for unsigned builds (Sequoia / Sonoma), English and Spanish: `docs/guides/`.

### Changed

- Windows direct download: **NSIS only, per-user (`installMode: currentUser`)** — no UAC prompt for install or
  updates. MSI is no longer built; MSI and deb installs are told to download from Beacon instead of getting a package
  they cannot use (the updater request carries `bundle_type`).
- macOS bundles are ad-hoc signed (`signingIdentity: "-"`), so Apple Silicon shows the normal "cannot verify" prompt
  instead of "damaged".
- The updater public key is committed in `tauri.conf.json` (the owner's minisign key, B39E7F906C923893); the
  `TAURI_UPDATER_PUBKEY` variable is now an optional override (also compiled in). The release workflow requires the
  signing key instead of skipping updater artifacts.
- Release workflow runners come from repository variables (`LINUX_RUNNER`, `WINDOWS_RUNNER`, `MACOS_RUNNER`, JSON
  `runs-on` values; GitHub-hosted defaults), so the same workflow runs on self-hosted runners. `WINDOWS_BUILD=false` /
  `MACOS_BUILD=false` skip that platform: `stable.json` then has no entries for it in that version. The Linux apt step
  runs on hosted runners only, and self-hosted jobs delete `src-tauri/target`, `out` and `node_modules` at the end.
  Secret names are unchanged.

## [0.3.0] - 2026-11-04

Needs TimeTrackBundle 1.10 (client API contract v0.3) for the full feature set; works with 1.9 servers with the
fallbacks below.

### Added

- **"Still there?" check** (Beacon spec 199 block 0, trust-first tone): while a timer runs, after N minutes without
  keyboard or mouse input a non-blocking card with the small mascot asks "Still there? No activity for N min on
  <task>": *Yes, I'm here* (keep), *I was in a meeting or call* (keep with an optional note, saved on the entry when it
  stops, or count the time on another task with `timer/discard-idle` `reassign` on 1.10 servers), *Discard those
  minutes* (`split`), *Pause the timer* (stop at the last input). No sound, calm colours, polite screen-reader
  announcement, no focus stealing, keyboard reachable; English and Spanish.
- No answer within M minutes: the timer stops at the last input (`timer/stop` `endedAt`). On return the app asks what to
  do with the gap (add it to the task, add it to another task, or leave it out; adding needs backdating on the server),
  then offers *Resume*. Screen lock counts as idle (the OS input counter keeps running); a system sleep is detected
  from the clock jump between two checks and counts as idle from the last check before it.
- Settings: on 1.10 servers the organisation's switch and values (`features.idle_check`,
  `limits.idle_check.threshold_minutes` 5–60, `answer_timeout_minutes` 1–30); the person may only lengthen the wait. On
  1.9 servers: the person's opt-in with dated consent, local defaults 10 / 5 minutes.
- Offline: every queued action (start, stop, switch, idle decisions) keeps the time it happened and is replayed in
  order with `startedAt` / `endedAt`. Clamped times (`startedAtResult` / `endedAtResult`: overlap, max_backdate,
  future, disabled, before_start) are shown in plain words until dismissed. On a 1.9 server, a start that the server
  could not backdate (no `startedAtResult`) is reported as "recorded from when the connection returned". Replays are
  serialised (a reconnect event and a refresh no longer send the same action twice).
- Privacy screen: what is sent, what stays on this computer, what is never collected, and **Clear local data** (with a
  warning when queued actions would be lost).
- Shared modules with the extension (kept identical): `api/` (contract v0.3: `features`, `limits`, `startAt`,
  `stopAt`, `reassign`), `lib/serverFeatures.ts`, `lib/idleCheck.ts`, `lib/replay.ts`, the mock server (1.10 by
  default, `{"apiVersion": "1.9"}` for the old behaviour).

- Beacon review:
  - With `features.idle_keep_note` (TimeTrackBundle 1.10.x) the meeting note is sent with `keep`. Otherwise it waits
    on this computer for the next stop.
  - With `limits.idle_check.user_can_disable: true` (personal accounts) Settings shows an on/off switch, on by default,
    with dated consent. When the value is false or the key is absent, the check stays mandatory.
  - The gap screen has a labelled full-width "Another task" row, and "Leave it out" is a ghost button.
  - Times follow the locale (24 h in Spanish).
  - The idle cards are named regions, announced once through a persistent polite live region.
  - axe checks (WCAG 2.1 A/AA) run in e2e, in light and dark.

### Changed

- The old opt-in "You were away" prompt (keep / discard / split on return) is replaced by the "Still there?" check.
- A stored `idleMinutes` of 10 (the 0.2 default) now means "the organisation's value".

### Privacy

- The OS "seconds since last input" value is read every 30 s while a timer runs, only to decide when to ask. It is not
  stored, logged or sent; a unit test checks that a recognisable counter value never appears in any request, log or
  local storage. Only the decision reaches the server.
- No Tauri capability or permission changed.

## [0.2.0] - 2026-11-04

### Added

- Links back to Beacon: **Open Beacon** (`<server>/dashboard`) and **My time** (`<server>/dashboard/tasks/time`) in the
  header, **Open Beacon** in the tray menu (only while connected), and an "Open in Beacon" icon on each task row and on
  the running timer. The task link uses the optional `url` field of `tasks` / `timer` (added by Beacon's TaskProvider
  bridge; not sent by TimeTrackBundle 1.9.x, so the icon stays hidden there). A running timer without `url` uses the
  `url` of the same task in the list.
- Every Beacon link is shown and opened only when it is an absolute `https:` URL without credentials on the connected
  server's origin (checked with `new URL()`); other hosts, schemes, ports and relative URLs are ignored. Links open in
  the browser through the existing opener plugin; no Tauri capability changed.
- English and Spanish strings; icon-only links carry an accessible name ("Open “task” in Beacon").
- Mock server: `taskUrls` config adds `url` to tasks and timers for tests.

### Changed — UX 0.2.0 (errors, core loop, tray)

- Rendering by stable regions: the search field is never re-created and focus stays on the same control across
  refreshes (typing "fix" no longer ends as "fi"; Enter on a row keeps focus on the row or moves it to Stop).
- Error catalogue: every failure has a title, a next step and actions (Retry, Copy details, Connect again, Where do I
  find it?); the raw server message only goes to "Copy details" (code, HTTP status, server, app version). Connect
  preflight (`GET me` without a token): a 404 says "Not a Beacon server"; a 404 / 405 on `device/code` says "This server
  doesn't support device sign-in yet" with Retry.
- Server address field: plain text with `inputmode=url` and translated validation; `https://` is added when missing and
  pasted Beacon page URLs are trimmed to the server; the typed value is never cleared by an error.
- Device code: Copy code, Open the page again, countdown with a progress bar from `expiresIn` (announced once at one
  minute), expired / declined states in place with "Get a new code" / "Try again".
- Main screen: timer card with state chip, `project · board` (project only when the server sends `projectTitle`) and
  "since HH:MM"; Today / This week totals from `entries` (link to My time); pinned (local, max 9) and recent tasks with
  `Alt+1…9`; the running task is not repeated in the lists; Resume the last task; search with `Ctrl/⌘+K` or `/`, arrow
  keys, Enter and Esc; `Ctrl/⌘+Shift+S` stop / resume; `Ctrl/⌘+,` settings.
- Tray: menu translated by the UI (Stop / Resume "{last}", Switch to ▸ up to 7 tasks, Search task…, Open TimeTrack,
  Open Beacon, My time, Settings…, Quit); title `H:MM task` and tooltip with today's total, refreshed every 30 s; icon
  variants for running (moss dot) and stopped (grey).
- Global shortcut: default `CommandOrControl+Alt+Shift+T` (`Ctrl+Alt+T` opens a terminal on Ubuntu / GNOME),
  configurable in Settings; a refused shortcut is reported there and the previous one is kept.
- Beacon look: Beacon design tokens (light and dark), `rem` sizes, inline icons, focus outlines, reduced motion; the
  Beacon mascot on the connect screen, while waiting for the code (CSS pulse of its antenna arcs), in empty states,
  error states (404 / 503 / 429 / 401 illustrations) and About. Images are optimised 1x / 2x WebP in `public/mascot/`.
- App icon (window, installers, `.icns` / `.ico` / PNG sizes): the Beacon mascot's head on the moss rounded square
  (owner-approved). The tray keeps the simplified mark (`src-tauri/icons/tray-64.rgba`); sources and the generator are
  in `scripts/icons/`.
- Info notices are dismissed automatically; `<html lang>` follows the UI language; consent dates use the app locale.
- Mock server: `taskExtras`, `notFound` and `deviceExpiresIn` configs.

## [0.1.0] - 2026-11-02

### Added

- Tauri 2 desktop app for symfony-beacon (TimeTrackBundle 1.9.0 client API): tray timer, global shortcut
  (Ctrl/Cmd + Alt + T), task search, start / stop / switch.
- Device-flow sign-in (user code, verification page opened in the browser, polling with `slow_down`); token in the OS
  keychain; `401` = sign in again.
- Offline queue with sync (stops keep their time through `timer/discard-idle`).
- Opt-in features with dated consent, all off by default: local idle detection (asks keep / discard / split, sends only
  the decision), notifications (never outside `me.workingHours`), start at login.
- Tauri v2 updater against Beacon with the Bearer token set at runtime; blocking "update required" screen for
  `min_supported_version`.
- "What we collect" screen, PRIVACY.md, English and Spanish.
- Tag-triggered release workflow (Linux, Windows, then macOS last) publishing to Beacon's bucket, `stable.json` last.
  Installers are unsigned in this version.
