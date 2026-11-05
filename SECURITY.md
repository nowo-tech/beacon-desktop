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
- **Network.** HTTPS required (loopback allowed for development). The webview cannot reach the network (CSP
  `connect-src ipc:`, no HTTP plugin): every request goes through the Rust command `beacon_fetch` (main window only;
  GET / POST, allow-listed headers, no redirects, no cookies). No remote code.
- **TLS public-key pinning.** For the official Beacon host (`src-tauri/pins.json`), the Rust client first validates
  the chain against the compiled-in Mozilla roots, then requires a pinned CA key (SPKI SHA-256) in a valid chain. A
  TLS-inspecting proxy or a rogue CA in the OS store cannot read or change that traffic: the handshake fails before
  the request (and its token) is sent, with no fallback. The update check and the updater use the same TLS
  configuration, because the check carries the Bearer token (minisign protects the artifact, not the token).
  Self-hosted servers use standard WebPKI ("Connection not pinned" in Settings). Pins, expiry and the rotation
  runbook: [docs/PINNING.md](docs/PINNING.md).
- **Updates.** Tauri updater with minisign signatures (public key built into the app; the signed version must match
  the announced one), artifacts served by Beacon to authenticated clients only (Bearer token at runtime, never sent to
  the artifact host). The private key is held by the owner and the build secrets only; a release build refuses the
  committed placeholder key. Direct-download installers are not OS-code-signed (verify the SHA-256 shown in Beacon);
  the Microsoft Store package is signed by Microsoft. The Store build has no in-app updater.
- **Privacy.** No screenshots, keystrokes, app / window / URL logging. The only OS signal read is "seconds since last
  input", locally and only when the user enabled idle detection; it is never sent.
- **Release secrets** live in GitHub Actions secrets only; the S3 key can only `PutObject` under `time-track-clients/`.
