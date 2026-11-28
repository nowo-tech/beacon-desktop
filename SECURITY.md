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
  - **One server** (owner decision 2026-11-27): release builds bind https://beacon.nowo.tech only
    (`net::validate_server_url` in `beacon_bind` and `sign_in_begin`; any other origin is refused with
    `beacon_server_fixed`), and the UI has no address field. Its TLS keys are always pinned. A sign-in to it starts
    without the native question below: the host is fixed, so the question added nothing. Debug builds may bind
    another server (the mock, a staging host); only there is the question asked, and only for a host other than
    beacon.nowo.tech.
  - Rust keeps a token only from the `device/token` answer of a sign-in Rust started: for a debug build's override
    host, `sign_in_begin` (signed out only) shows a native dialog, "Sign in to <host>?" with the full host (IDN hosts
    as `xn--…`), that the webview cannot answer. **Cancel** is the first, default button (Enter declines; Esc and closing decline too), any host
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
      allow, `export` included; with a chat token approved for sending, chat writes: messages, thread replies and reactions, never edits or deletes), and send the **data** it reads elsewhere, for example in an https URL given to
      `open_external`;
    - sign you out (`secret_delete`) and start a sign-in (`sign_in_begin`): in a release build only to
      https://beacon.nowo.tech, and a sign-in still needs your approval of the code in Beacon in your browser; any
      stored sign-in is announced by an OS notification naming the server. (In a debug build, another server also
      needs **Sign in** in the native "Sign in to <host>?" dialog.) If you see a dialog or a notification you did not expect,
      press **Cancel**, or sign out and revoke the device in Beacon.

    It cannot read the token or get it sent to another server.
- **Network.** HTTPS required; plain `http://` to `localhost` / `127.0.0.1` / `[::1]` only in debug builds. The
  webview cannot reach the network (CSP `connect-src ipc:`, no HTTP plugin): every request goes through the Rust
  command `beacon_fetch` (main window only; GET / POST, plus PUT / DELETE on the chat reaction route only,
  allow-listed headers, no redirects, no cookies). No remote
  code. Rust binds `beacon_fetch`, the update check and the updater to the origin (scheme, host, port) of the server
  being signed in to (`beacon_bind`, before the sign-in requests and at start-up): any other origin is refused, so the
  `Authorization` header never leaves that origin, and switching to another server needs a sign-out first
  (`secret_delete` clears the binding). This is defence in depth: script injection into the main webview is already
  prevented by `script-src 'self'` and a text-only DOM.
- **Trusted roots / other servers.** Release builds use https://beacon.nowo.tech only (pinned); what follows about
  other servers applies to debug builds. Only the Mozilla root store compiled into the app (`webpki-roots`,
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
  `X-Beacon-Context` and (0.12.0, chat writes) `Idempotency-Key` are the only extra request headers the window may
  set; `PUT` and `DELETE` reach only `…/messages/{uuid}/reactions/{emoji}` (deny by default on every other route, no
  `PATCH`; audit ZDG-L1).
- **Tasks token** (0.13.0). A third keychain entry (`tasks-token`), stored only from a 2xx `device/token` answer with
  `scopeFamily: "tasks"` after `tasks_connect_begin` (same rules as chat), pinned to the base path it was stored
  under, attached only to `<server base path>/api/task-board/v1/…` (anchored; look-alikes get no token). Writes:
  `PATCH` only on `…/tasks/{id}` and `…/tasks/{id}/checklist-items/{id}`, `PUT` / `DELETE` only on
  `…/tasks/{id}/members/{user}`, `POST` as any route; `If-Match` is an allowed request header and `ETag` a returned
  one. Sign-out deletes the tasks entry first; "Disconnect tasks" deletes it alone. Both first call TaskBoard's
  `POST /api/task-board/v1/logout` (3.7.0) best effort, 3 s. When that call fails with a network error, `5xx`, `409`
  or `429`, the UI asks Rust to park the token (`tasks_revoke_park`, a fourth entry, user `tasks-revoke`, up to 4
  tokens) before the delete. A parked token is never attached to any request of the UI. At the next start (once the
  webview is online) `tasks_revoke_retry` deletes the entry first and then sends one `POST …/logout` per token itself,
  to the token's own origin and base path (release builds: the official server only). Any answer ends a token's
  retry; no answer at all parks it again, for at most 3 starts. One run at a time. *Clear local data* revokes the chat
  and tasks tokens first, runs the parked retry at once and deletes the entry (`tasks_revoke_clear`). Answers to requests sent before an organization switch or a reconnect are dropped, and
  their `401` / `403` act on nothing (audit BDA13-M1).
- **Links** (`beacon-desktop://`, src-tauri/src/deeplink.rs). Untrusted input that only navigates: parsed in Rust
  into `{kind: chat|task, id, context}` (UUID / TaskBoard id, `personal` or `org:<uuid>`; anything else, extra
  parameters, dot segments, credentials, ports or over 512 bytes is dropped) and kept (the latest wins); the UI gets a
  ping without payload and takes the link once with `deep_link_take`, at start-up and on each ping, so a link opens
  exactly once; sign-out forgets a link not taken yet (audit BDA13-L1). Links raise and focus the main window at most
  once a second (BDA13-I1). The UI never writes or sends anything for a link, and never switches the organization for
  one without asking (with a running timer, the "Stop the timer and switch?" question is the one asked).
- **Notifications** carry no message data (level None); a click target is `chat-open:[<context>:]<uuid>` only (the
  context `personal` or `org:<uuid>`), checked in Rust; a click switches back to that context through the usual flow.
- **Links in task text** (descriptions, comments) open through `open_chat_link`, like chat messages (`http(s)`,
  `mailto` with the listed fields only); a refused link says so.
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

### Window chrome (UX batch 7)

- **Own title bar, four extra window permissions, main window only.** On Windows and Linux the main window has no
  system frame (`decorations: false`, set in Rust, `chrome_for` in `src-tauri/src/lib.rs`) and the app draws its own
  title bar; macOS keeps the system's traffic lights over it (`TitleBarStyle::Overlay`). `capabilities/default.json`
  gains exactly what that bar needs: `core:window:allow-start-dragging` (the `data-tauri-drag-region` bar),
  `allow-minimize`, `allow-toggle-maximize` (the buttons; the double click uses `allow-internal-toggle-maximize`,
  already in `core:window:default`) and `allow-close`. Closing still only hides the window to the tray: Rust prevents
  the close (`WindowEvent::CloseRequested`), and no destroy permission is granted. The prompt and mini windows get no
  window permission at all (a Rust test checks all of this). The window cannot move or resize itself beyond what it
  could before (`set_size` / `set_position` for Compact / Full view).
- **Fallback.** `BEACON_DESKTOP_SYSTEM_TITLEBAR=1` keeps the system title bar on Windows and Linux (an environment
  variable read once at start-up by Rust; the webview cannot change it).

## Known limitations

- **Tasks token revocation needs TaskBoard 3.7.0 (BDA13-L2, Low).** Since 0.14.1 sign-out and "Disconnect tasks" call
  `POST /api/task-board/v1/logout` first. On a Beacon with TaskBoard before 3.7.0 the route is missing (`404`): the
  token is deleted from the keychain only, and a copy taken before (local malware reading the keychain, a backup) keeps
  working until it expires. A server reporting `me.features.serverLogout: false` answers the route without revoking.
  Revoke the device in Beacon (Account → Security) to end it at once.

- **macOS single-instance socket in `/tmp` (upstream, Low).** The one-copy guard (`tauri-plugin-single-instance`
  2.5.x) uses the fixed path `/tmp/tech_nowo_timetrack_si.sock` on macOS, and the plugin does not let the app choose
  another. `/tmp` is shared by every account of the Mac: another local account that binds that path first makes
  TimeTrack exit at launch for the other users (it hands its arguments, and its working folder, to that process),
  or, with a plain file there, start without the guard. Only on Macs shared with an untrusted local account;
  availability only, no access to the session token or the data. Windows (mutex in the user's session) and Linux
  (the user's D-Bus session bus) are per user. An upstream issue asking for a per-user `$TMPDIR` socket is drafted,
  not yet filed (filing needs the owner's OK); the app will move to it once the plugin allows it.
