# Changelog

All notable changes to this project are documented here ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[Semantic Versioning](https://semver.org/)).

## [Unreleased]

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
