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
