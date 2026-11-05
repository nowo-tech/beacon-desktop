# Security policy

## Reporting

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/nowo-tech/time-track-desktop/security/advisories/new). Do not open
public issues. We answer within 5 working days.

## Supported versions

Only the latest release receives fixes. The server can force an update with `min_supported_version`.

## Design

- **Credentials.** Device flow only: no password is typed in the app. The session token lives in the OS keychain
  (macOS Keychain, Windows Credential Manager, Secret Service on Linux), never in files or web storage. Sign-out revokes
  it on the server and deletes it locally; `401` deletes it and asks to sign in again.
- **Network.** HTTPS required (loopback allowed for development). HTTP calls go through the Tauri HTTP plugin with a
  scope limited to `https://*` and loopback; the webview CSP allows only `'self'` and IPC; no remote code.
- **Updates.** Tauri updater with minisign signatures (public key built into the app; the signed version must match
  the announced one), artifacts served by Beacon to authenticated clients only (Bearer token at runtime, never sent to
  the artifact host). The private key is held by the owner and the build secrets only; a release build refuses the
  committed placeholder key. Direct-download installers are not OS-code-signed (verify the SHA-256 shown in Beacon);
  the Microsoft Store package is signed by Microsoft. The Store build has no in-app updater.
- **Privacy.** No screenshots, keystrokes, app / window / URL logging. The only OS signal read is "seconds since last
  input", locally and only when the user enabled idle detection; it is never sent.
- **Release secrets** live in GitHub Actions secrets only; the S3 key can only `PutObject` under `time-track-clients/`.

## Known limitations

- **macOS single-instance socket in `/tmp` (upstream, Low).** The one-copy guard (`tauri-plugin-single-instance`
  2.5.x) uses the fixed path `/tmp/tech_nowo_timetrack_si.sock` on macOS, and the plugin does not let the app choose
  another. `/tmp` is shared by every account of the Mac: another local account that binds that path first makes
  TimeTrack exit at launch for the other users (it hands its arguments, and its working folder, to that process),
  or, with a plain file there, start without the guard. Only on Macs shared with an untrusted local account;
  availability only, no access to the session token or the data. Windows (mutex in the user's session) and Linux
  (the user's D-Bus session bus) are per user. Reported upstream (a per-user `$TMPDIR` socket); the app will move
  to it once the plugin allows it.
