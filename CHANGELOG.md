# Changelog

All notable changes to this project are documented here ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[Semantic Versioning](https://semver.org/)).

## [Unreleased]

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
