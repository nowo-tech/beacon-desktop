# Security policy

## Reporting

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/nowo-tech/beacon-desktop/security/advisories/new). Do not open
public issues. We answer within 5 working days.

## Supported versions

Only the latest release receives fixes. The server can force an update with `min_supported_version`.

## Design

- **Credentials.** Device flow only: no password is typed in the app. The session token lives in the OS keychain
  (macOS Keychain, Windows Credential Manager, Secret Service on Linux), never in files or web storage, and it never
  reaches the webview (`src-tauri/src/secret.rs`, security review appendix GM):
  - No command returns it (`secret_get` / `secret_set` are gone since the version after 0.5.1). The webview can ask
    whether one is stored (`secret_status`), start a sign-in (`sign_in_begin`) and delete it (`secret_delete`).
  - The keychain entry holds the token **and the origin that issued it**. While a token is stored, only that origin
    can be bound, also at start-up (a server changed in the app's local storage is refused and the user signs in
    again), and Rust sets `Authorization` only on requests to that origin (`beacon_fetch`, the update check, the
    updater). A keychain that cannot be read refuses the binding. A 0.5.1 entry, which has no origin, adopts the server
    of the first start-up after the upgrade (trust on first use, the trust 0.5.1 already gave it).
  - Rust keeps a token only from the `device/token` answer of a sign-in the person confirmed: `sign_in_begin` (signed
    out only) shows a native dialog, "Sign in to <host>?" with the full host (IDN hosts as `xn--…`), that the webview
    cannot answer. **Cancel** is the first, default button (Enter declines; Esc and closing decline too), any host
    other than the official one gets the line "This is not beacon.nowo.tech", the dialog is only shown while the main
    window is focused and there was keyboard or mouse input in the last 30 seconds (otherwise it is refused unseen,
    `sign_in_not_present`, without starting a pause; where the OS cannot report idle time, as on some Wayland
    sessions, this reduces to "the main window is focused"), and after a decline it is not shown again for 10 seconds,
    doubling up to 5 minutes; neither sign-out nor a restart resets that (the pause is kept by Rust in
    `sign-in-pause.json` in the app data folder). Only after **Sign in** is the
    answer stored, for that server, within 30 minutes, and every stored
    sign-in is announced by an OS notification from Rust. A stored token is never replaced. The app signs in with the
    device flow only, so the password route (`…/login`) is never stored. The UI gets a fixed handle in place of the
    token. The sign-in route is matched on the decoded path, and paths that escape unreserved characters are refused.
  - Token fields (`token`, `access_token` / `accessToken`, `refresh_token`, `session_token`, `id_token`, `bearer`,
    any case) are removed from every JSON answer (a UTF-8 BOM included), at any depth and on any status, before the
    webview sees it, and only the response headers the UI reads (`Content-Type`,
    `Content-Disposition`, `Retry-After`, `X-Min-Supported-Version`) reach it. An `Authorization` header from the
    webview is dropped. Error texts never quote the token. Keychain calls and the dialog run off the UI thread and the
    async workers.
  - Sign-out revokes it on the server, then deletes the keychain entry before Rust forgets it and unbinds the server,
    all under one lock; if the keychain refuses, the token and the binding stay and the error is shown. `401` deletes it
    and asks to sign in again.
  - When the app signs you out because the saved server no longer matches the stored session, it cannot revoke that
    session on the server: it says so, and you can revoke the device in Beacon (Account → Security → Time tracking
    apps). The same applies after *Clear local data* while offline.
  - **Residual risk.** A script running in the main webview (script injection is prevented by `script-src 'self'`
    and a text-only DOM) could still:
    - make authenticated requests to the signed-in server while the app runs (any GET / POST the token's scopes
      allow, `export` included), and send the **data** it reads elsewhere, for example in an https URL given to
      `open_external`;
    - sign you out (`secret_delete`) and start a sign-in to a server of its choice (`sign_in_begin`). That needs you
      to press **Sign in** in the native "Sign in to <host>?" dialog showing that host, and any stored sign-in is
      announced by an OS notification naming the server. If you see a dialog or a notification you did not expect,
      press **Cancel**, or sign out and revoke the device in Beacon.

    It cannot read the token or get it sent to another server.
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

### Chat (0.10.0)

- **Second token, same rules.** Keychain user `chat-token` (service `tech.nowo.time-track-desktop`), `{"v":1,
  "origin","token"}`, read and used by Rust only (`src-tauri/src/secret.rs`). Captured only from a 2xx
  `device/token` answer with `scopeFamily: "chat"` after `chat_connect_begin` (main window, a person at the app, the
  time token stored for the bound origin, no chat token yet, within 30 minutes). A `chat` answer is never stored as the
  time token, a `time` answer never as the chat token, any other family is scrubbed.
- **Routing.** A chat route (`<server base path>/api/chat/v1/…`, decoded path, anchored) gets the chat token or
  nothing; a path that only looks like one gets no token; every other route the time token or nothing.
  `X-Beacon-Context` is the only extra request header the window may set.
- **Revocation.** "Disconnect chat" and sign-out call `POST …/api/chat/v1/logout` with the chat token first (best
  effort, 3 s), then delete it from the keychain.
- **Realtime** (`src-tauri/src/realtime.rs`): the ticket (`GET …/api/chat/v1/realtime`) and the SSE stream are made in
  Rust through the pinned client, no redirects; the hub must be on the signed-in origin; the subscriber JWT goes in
  `Authorization`, never in the URL, and never reaches the window; hub events are reduced to ids before the window
  sees them (kind, conversation / message uuids, message id, thread root, deleted); one event's data and one line are
  capped at 64 KiB.
- **Rendering.** Message bodies are structured tokens rendered as text nodes; links open outside the app through
  `open_chat_link` (`http(s)` / `mailto`, checked again in Rust; `mailto` keeps only `to`, `cc`, `bcc`, `subject`,
  `body`); a reference type becomes a CSS class only when it is a
  known one.

## Known limitations

- **macOS single-instance socket in `/tmp` (upstream, Low).** The one-copy guard (`tauri-plugin-single-instance`
  2.5.x) uses the fixed path `/tmp/tech_nowo_timetrack_si.sock` on macOS, and the plugin does not let the app choose
  another. `/tmp` is shared by every account of the Mac: another local account that binds that path first makes
  TimeTrack exit at launch for the other users (it hands its arguments, and its working folder, to that process),
  or, with a plain file there, start without the guard. Only on Macs shared with an untrusted local account;
  availability only, no access to the session token or the data. Windows (mutex in the user's session) and Linux
  (the user's D-Bus session bus) are per user. An upstream issue asking for a per-user `$TMPDIR` socket is drafted,
  not yet filed (filing needs the owner's OK); the app will move to it once the plugin allows it.
