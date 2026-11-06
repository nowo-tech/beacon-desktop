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
- **Network.** HTTPS required; plain `http://` to `localhost` / `127.0.0.1` / `[::1]` only in debug builds. The
  webview cannot reach the network (CSP `connect-src ipc:`, no HTTP plugin): every request goes through the Rust
  command `beacon_fetch` (main window only; GET / POST, allow-listed headers, no redirects, no cookies). No remote
  code. Rust binds `beacon_fetch`, the update check and the updater to the origin (scheme, host, port) of the server
  being signed in to (`beacon_bind`, before the sign-in requests and at start-up): any other origin is refused, so the
  `Authorization` header never leaves that origin, and switching to another server needs a sign-out first
  (`secret_delete` clears the binding). This is defence in depth: script injection into the main webview is already
  prevented by `script-src 'self'` and a text-only DOM.
- **Trusted roots / self-hosted servers.** Only the Mozilla root store compiled into the app (`webpki-roots`,
  CDLA-Permissive-2.0, [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)) is trusted; the OS trust store is not. Self-hosted
  Beacon servers with a certificate from a **private or corporate CA are not supported**, for the API and for the
  updater (which used the OS store before 0.5.1). Certificates must chain to the Mozilla root store. Adding or
  removing a root takes an app release.
- **TLS public-key pinning.** For the official Beacon host (`src-tauri/pins.json`), the Rust client first validates
  the chain against the compiled-in Mozilla roots, then requires a pinned CA key (SPKI SHA-256) in a valid chain. A
  TLS-inspecting proxy or a rogue CA in the OS store cannot read or change that traffic: the handshake fails before
  the request (and its token) is sent, with no fallback. The update check and the updater use the same TLS
  configuration, because the check carries the Bearer token (minisign protects the artifact, not the token).
  Self-hosted servers use standard WebPKI ("Connection not pinned" in Settings). Pins, expiry, the rotation
  runbook and the server-side preconditions (CAA, ACME issuer, chain monitor): [docs/PINNING.md](docs/PINNING.md).
  When the pin set of a build expires, the app falls back to WebPKI with the compiled-in roots (OS-store and proxy CAs
  are still refused) and says so in the main view and once as a desktop notification, not only in Settings.
- **Updates.** Tauri updater with minisign signatures (public key built into the app; the signed version must match
  the announced one), artifacts served by Beacon to authenticated clients only (Bearer token at runtime, never sent to
  the artifact host). The private key is held by the owner and the build secrets only; a release build refuses the
  committed placeholder key. Direct-download installers are not OS-code-signed (verify the SHA-256 shown in Beacon);
  the Microsoft Store package is signed by Microsoft. The Store build has no in-app updater.
- **Updater errors.** Error details ("Copy details") never include a URL query string: the pre-signed object-storage
  URL of an artifact is reduced to its path (`net::redact_urls`).
- **Reviewed and accepted (security review 2026-11-05, appendix FY).**
  - The updater client follows redirects (reqwest default), unlike `beacon_fetch`; reqwest drops `Authorization` on
    cross-origin redirects and Beacon's updater route does not redirect (FY-I3).
  - The CSP leaves IPC as the only network path. Top-level navigation of the main webview and `opener` to `https://*`
    remain and need script execution in the main webview (FY-I4).
  - Pinning the ISRG and GTS roots accepts any Let's Encrypt or GTS certificate for the official host, by design: the
    protection is against every other CA and against OS-store and proxy CAs; CAA on the host completes it (FY-I5).
  - `system-proxy`: an `HTTP_PROXY` without `NO_PROXY=localhost` would route development loopback traffic through
    the proxy; release builds have no loopback http (FY-I8).
- **Privacy.** No screenshots, keystrokes, app / window / URL logging. The only OS signal read is "seconds since last
  input", locally and only when the user enabled idle detection; it is never sent.
- **Release secrets** live in GitHub Actions secrets only; the S3 key can only `PutObject` under `time-track-clients/`.

## Known limitations

- **The session token is reachable from the main window's script (Info, FN-L1 / FY-D-2).** The webview reads the
  token with `secret_get` to send it through `beacon_fetch`. The origin binding stops the app from sending it
  anywhere else, but a script running in the main window could call `secret_get`, then `secret_delete` (which also
  clears the binding), `beacon_bind` to another server and `beacon_fetch` there, or hand a URL with the token to the
  browser. That needs script injection first, which `script-src 'self'` and the text-only DOM prevent, so the binding is
  a guard against mistakes and confused deputies, not an XSS boundary. Planned: Rust keeps the token and adds
  `Authorization` itself, and `secret_get` goes away (docs/ROADMAP.md, *Security hardening*).

- **macOS single-instance socket in `/tmp` (upstream, Low).** The one-copy guard (`tauri-plugin-single-instance`
  2.5.x) uses the fixed path `/tmp/tech_nowo_timetrack_si.sock` on macOS, and the plugin does not let the app choose
  another. `/tmp` is shared by every account of the Mac: another local account that binds that path first makes
  TimeTrack exit at launch for the other users (it hands its arguments, and its working folder, to that process),
  or, with a plain file there, start without the guard. Only on Macs shared with an untrusted local account;
  availability only, no access to the session token or the data. Windows (mutex in the user's session) and Linux
  (the user's D-Bus session bus) are per user. An upstream issue asking for a per-user `$TMPDIR` socket is drafted,
  not yet filed (filing needs the owner's OK); the app will move to it once the plugin allows it.
