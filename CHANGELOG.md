# Changelog

All notable changes to this project are documented here ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[Semantic Versioning](https://semver.org/)).

## [Unreleased]

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
