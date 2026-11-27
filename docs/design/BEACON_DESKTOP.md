# Beacon Desktop: design (BD-0)

Status: **draft for owner review** (2026-11-25). Docs only: nothing in this document is built yet, and no app id,
repository name, secret or release changes with it.

**Implementation status:** BD-1 shipped in 0.9.0. BD-2 (chat read-only) shipped in 0.10.0
(CHANGELOG `[0.10.0]`). BD-3a (time context, mini timer, required fields, §7.1) shipped in 0.11.0
(CHANGELOG `[0.11.0]`). BD-3b part 1 (chat send, thread replies, reactions, §7.2) shipped in 0.12.0
(CHANGELOG `[0.12.0]`); notifications, mute and the tasks module follow. Where the build differs from this text: the
modules follow the approved prototype (Chat `Ctrl/Cmd+1`, Time `Ctrl/Cmd+2`, Tasks off); `GET me` is asked with the last context or
`personal` (ChatKit needs a context on every request under a context policy) and falls back to `personal` on
`403 context_forbidden`; the realtime hub must be on the signed-in origin (Beacon's default; another host is refused and
the app polls); "Disconnect chat" and sign-out call ChatKit 2.4.1 `POST /api/chat/v1/logout` best effort before the
local delete (review ZBZ-L4).

Owner decisions of 2026-11-25 this design starts from:

- `time-track-desktop` becomes **Beacon Desktop**: time tracking plus Beacon chat (ChatKitBundle).
- The browser extension (`time-track-extension`) is **parked**.
- The app is **Beacon-only**: no generic-host requirement for the app. The server-side protocols stay in the bundles as
  versioned, generic client APIs.
- Priority: accelerate, after Beacon's own requests.

Since the owner's decision of 2026-11-25 (later the same day) the app has **three modules**: time tracking, chat and
**tasks** (TaskBoardBundle). The tasks module and the TaskBoard client API are designed in
[BEACON_DESKTOP_TASKS.md](BEACON_DESKTOP_TASKS.md) (Q-BD-20 onwards).

Beacon's existing constraints (sent 2026-11-25) are **fixed requirements** here and are listed in
[§0](#0-fixed-requirements-from-beacon). Everything they do not settle is an open question in [§8](#8-open-questions).
Questions marked **[Beacon]** need an answer from Beacon (forwarded by the coordinator).

Internal hosts are placeholders: `https://beacon.example` is the Beacon instance, `<s3-endpoint>` / `<bucket>` the
release bucket.

## Table of contents

- [0. Fixed requirements from Beacon](#0-fixed-requirements-from-beacon)
- [1. Current state (TimeTrack Desktop 0.8.0)](#1-current-state-timetrack-desktop-080)
- [2. Rename and migration of existing installs](#2-rename-and-migration-of-existing-installs)
- [3. Chat](#3-chat)
- [4. Auth](#4-auth)
- [5. UI shell](#5-ui-shell)
- [6. Monitoring screenshots and the update feed: two different S3 paths](#6-monitoring-screenshots-and-the-update-feed-two-different-s3-paths)
- [7. Phases and versions](#7-phases-and-versions)
- [8. Open questions](#8-open-questions)
- [9. Out of scope](#9-out-of-scope)
- Addendum: [Tasks module and the TaskBoard client API](BEACON_DESKTOP_TASKS.md)

## 0. Fixed requirements from Beacon

| # | Requirement | Where this design applies it |
|---|---|---|
| R1 | **Chat transport** is Beacon's Mercure hub (`BeaconChatRealtime` over `ConfiguredMercure`). Updates are always private. The subscriber JWT is short-lived, scoped to the caller's own topic, requested from Beacon's API, never signed by the client. The hub can be off (`isEnabled()`): the client works with bounded polling and backoff. The client never sees another person's topic. The web client uses SSE against the same hub; no WebSocket, no other broker. | §3.3 |
| R2 | **Permission filtering.** Chat references (issues, tasks, wiki, monitors) are filtered per reader; what the reader cannot open is a neutral "not visible" placeholder. The client never receives data about inaccessible items, neither in a payload nor in a notification preview. | §3.2, §3.3, §3.4 |
| R3 | **Tokens.** Device code with separate `time` and `chat` scopes, deny by default. Revocable from the account and audited like today's TimeTrack clients (`ClientApiAuditSubscriber`). A `chat` token cannot open the time API, and the other way round. Routes under `/api/<bundle>/v<N>` (D-20261110-04). | §4 |
| R4 | **Tenant.** The Personal / organization context (`User::organizationContext`) is per person and stored on the server. The desktop passes the tenant explicitly (per request or in the token) and never changes the user's web context as a side effect. | §4.4 |
| R5 | **Notifications.** Today Web Push with `push_url` → `/dashboard?chat={uuid}`. Previews respect the person's chat preferences (muted channel or conversation) and R2. Hiding message text for strict organizations is an owner question. | §3.4, Q-BD-9 |
| R6 | **S3.** Monitoring screenshots go through the organization's (or personal) storage profile, keys `Y/m/<uuid>`, upload = intent + signed PUT, Beacon processes (blur, webp) before anything is visible. The desktop never writes to S3 directly and never knows profile credentials. The update feed is a different thing. | §6 |
| R7 | **Worker.** FrankenPHP with no kernel reset. New Beacon-side APIs keep no state between requests. | §3.5 |

## 1. Current state (TimeTrack Desktop 0.8.0)

### 1.1 Architecture

- **Tauri 2** app: Rust core (`src-tauri/src`) and a TypeScript web view (`src/`, Vite, no framework, text-only DOM,
  strict CSP: `default-src 'self'`, `connect-src ipc:` only).
- **All network traffic goes through Rust** (`net.rs`, `beacon_fetch`) with **TLS public-key pinning** for the official
  Beacon host (`pinning.rs`, `pins.json`: CA keys, never the leaf; Mozilla roots compiled in, never the OS store).
  Self-hosted servers kept standard validation ("Connection not pinned"). **Since 2026-11-27 (owner decision) release
  builds use https://beacon.nowo.tech only**: no address field at sign-in or in the first run, Settings → Account
  shows the server read-only, Rust refuses to bind any other origin (`net::validate_server_url`), pinning always
  applies, and the native "Sign in to <host>?" question is no longer asked for it (the host is fixed). The question
  and its "This is not beacon.nowo.tech" line stay **debug-only**, for an override host (the mock, staging:
  `BEACON_SERVER_FIELD=1` or Vite's dev server, with a debug Rust build). An install bound to another host is signed
  out at the next start with a message.
- **Bound origin**: every request, including the updater, goes only to the origin the user signed in to
  (`beacon_bind`); switching servers means signing out first.
- **ACL-scoped commands**: every app command is declared in `build.rs`, allowed per window label
  (`capabilities/default.json`, `prompt.json`) and re-checked in Rust (`main` for keychain, updater, tray…).
- Tray app with a single instance per user session (`tauri-plugin-single-instance`), global shortcut, start at login
  (`autostart.rs` cleans legacy `Run` entries), idle check (`user-idle`), screen lock / sleep pause (`session.rs`),
  opt-in meeting detection (`meeting/*`), native notifications (`notify.rs`: WinRT toasts with the app AUMID,
  `notify-rust` on Linux / macOS), English and Spanish.
- Client API: TimeTrackBundle, **unversioned paths** `/api/time-track/...` (permanent aliases for installed clients;
  TimeTrackBundle 2.1.0 also serves `/api/time-track/v1/...`, contract v0.4). Scopes asked today: `timer:read`,
  `timer:write`, `tasks:read`, `entries:read`, plus `meetings:read` since 0.6.
- Local state: settings, consents, pinned tasks, queued actions in the web view's `localStorage` (`src/lib/settings.ts`);
  the session handle in Rust state under the app data dir. Both live under directories **named after the bundle
  identifier**.

### 1.2 Auth

- RFC 8628 **device flow** against TimeTrackBundle (`POST /api/time-track/device/code`, poll `device/token`),
  `clientType: desktop`. The verification page is Beacon's (Account → Security → Time tracking apps, with 2FA
  re-auth). A notification confirms every sign-in.
- The session token is stored **only in the OS keychain** (`keyring` crate: Windows Credential Manager, macOS
  Keychain, Secret Service on Linux), service `tech.nowo.time-track-desktop`, user `session-token`; only Rust reads
  it, the web view never sees it (`secret.rs`).
- TimeTrackBundle credential model: a host credential (Beacon: app password / device approval) issues a bundle
  `ClientToken` (scopes, TTL `clients.token_ttl`); revoking the credential revokes its tokens; every token use runs the
  user checker. Beacon audits client API use (`ClientApiAuditSubscriber`).

### 1.3 Updater

- `tauri-plugin-updater` with **minisign** signatures (`plugins.updater.pubkey` in `tauri.conf.json`,
  `requireSignedVersion: true`, Windows `installMode: passive`).
- Endpoint built at runtime from the bound server:
  `<server>/api/time-track/updates/desktop/{target}/{arch}/{current_version}?bundle_type={bundle_type}`, Bearer =
  the session token, through the pinned client. The route is **Beacon's own** (`TimeTrackClientUpdaterController`,
  `time_track_client_updater`), not TimeTrackBundle's. It reads `time-track-clients/desktop/channel/stable.json` and
  answers with a pre-signed artifact URL on another origin (the Bearer token is never sent there).
- `min_supported_version` (updater body / `X-Min-Supported-Version` / `GET me`) drives the "update required" screen.
- Checked at start, every 6 h and on demand; with a running timer it asks first ("After I stop").
- The Microsoft Store build (`TIMETRACK_CHANNEL=store`, `tauri.store.conf.json`) has **no in-app updater**; the Store
  updates it.

### 1.4 Packaging ids per OS

| OS | Package | Ids that matter for upgrades |
|---|---|---|
| All | Tauri `identifier` | `tech.nowo.timetrack` (bundle id, app data / web view data dirs, Windows AUMID) |
| All | `productName` | `TimeTrack` (window title, install dir, `.app` name, Start menu, uninstall entry) |
| All | Cargo package / binary | `time-track-desktop` (`time_track_desktop_lib`); executables `TimeTrack.exe` or `time-track-desktop.exe` seen in the wild (`autostart.rs`) |
| All | Keychain | service `tech.nowo.time-track-desktop`, user `session-token` |
| Windows (NSIS, per user, no UAC) | `*-setup.exe` | Install dir `%LOCALAPPDATA%\TimeTrack`; `HKCU\Software\nowo.tech\TimeTrack`; uninstall entry keyed on the product name, publisher `nowo.tech`; `HKCU\…\Run` value `TimeTrack`; AUMID `tech.nowo.timetrack` on the Start-menu shortcut. Tauri's NSIS installer has no product GUID; the 0.1.0 MSI (WiX, per machine) had an upgrade code and is migrated away by `installer-hooks.nsh`. |
| Windows (Store) | MSIX | `Identity Name` / `Publisher` from Partner Center (`MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER`), `Application Id="TimeTrack"`, AUMID `<package family>!TimeTrack` |
| macOS 12+ (universal) | `.dmg`, `.app.tar.gz` (updater) | Bundle id `tech.nowo.timetrack`, `TimeTrack.app`; **ad-hoc signed** (`signingIdentity: "-"`), **not notarized** (first-open guide in `docs/guides/`) |
| Linux x86_64 | `.deb`, `.AppImage` | Debian package name derived from `productName` (to be confirmed on a built `.deb`); desktop file and icon names from the binary name |

### 1.5 Release feed (S3) and CI

- Tag `vX.Y.Z` → `release.yml`: Linux and Windows first, macOS (universal) last, then upload to
  `time-track-clients/desktop/<version>/<file>` and **`time-track-clients/desktop/channel/stable.json` last**
  (`scripts/release/collect-desktop.sh`, `channel.mjs`, `s3-put.sh`). Beacon's `ClientApp` enum (`desktop`,
  `extension`) maps each app to its prefix `time-track-clients/<app>/`. The download page is Beacon → Tasks → Time →
  Apps.
- Secrets: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`, `TIME_TRACK_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`
  (+ `REGION`; `s3:PutObject` on `time-track-clients/*` only). Variables: `TAURI_UPDATER_PUBKEY`, `BEACON_URL`,
  `TIME_TRACK_MIN_SUPPORTED_VERSION`, `MSIX_*`, `TIMETRACK_STORE_URL`, `WINDOWS_BUILD`, `MACOS_BUILD`,
  `MACOS_CI_ENABLED` (true since 2026-11-17).
- Runners: `LINUX_RUNNER` / `RELEASE_LINUX_RUNNER` select the DEVOPS self-hosted `tauri-build` runner (ephemeral,
  repo-scoped, never `prod-vps`); Windows and macOS default to hosted runners (`WINDOWS_RUNNER`, `MACOS_RUNNER`
  override). Workflows: `ci.yml`, `platforms.yml`, `installer-upgrade-test.yml`, `pins.yml`, `release.yml`.
- The repository is **private**; it goes public only for the duration of a release build and back to private right
  after (owner 2026-11-24). While public, the self-hosted runner variables are removed.
- Signing today: updater artifacts minisign-signed; Windows installers not Authenticode-signed (SmartScreen once);
  macOS ad-hoc; MSIX re-signed by the Store.

## 2. Rename and migration of existing installs

Goal: every installed TimeTrack 0.x keeps updating itself into Beacon Desktop, keeps its sign-in and settings, and ends
with **one** app, **one** tray icon, **one** start-at-login entry.

### 2.1 What breaks if an id changes

| Id changed | Effect on an installed copy |
|---|---|
| Tauri `identifier` | New app data and web view data dirs: **settings, consents, pinned tasks, queued actions and the session handle are not found** (they are not lost, just orphaned). macOS: a different bundle id is a different app for Keychain ACLs, notifications permission, login items and Gatekeeper. Windows: new AUMID, so toasts land under a new Action Center entry and the old one's notification setting does not carry. |
| Keychain service name | The stored token is not found: the user must sign in again. |
| `productName` | Windows NSIS: new install dir, new uninstall entry and `HKCU\Software\nowo.tech\<name>` key, so the passive updater installs **side by side** unless hooks adopt the old install; new `Run` value name. macOS: the updater replaces the bundle at its current path, so the `.app` keeps its old file name until a reinstall. Linux: a new `.deb` package name installs next to the old one (two packages); AppImage file names change. |
| Updater endpoint path | Old copies keep calling the old path (compiled in), so the old path must stay forever (permanent alias, D-20261110-04). |
| Updater public key | Old copies refuse every update signed with a new key: **never rotate the key in the same release as the rename**. |
| MSIX identity | A new Store product: Store users would need a manual install; existing Store installs do not move. |

### 2.2 Options

**Option A: keep every technical id, change the visible name (recommended for BD-1).**
Keep `identifier` `tech.nowo.timetrack`, keychain service, AUMID, `productName` on disk, Cargo package, updater key and
endpoint, MSIX identity. Change what people see: window and tray titles, Start-menu shortcut display name, `.desktop`
`Name=`, `CFBundleDisplayName` (not `CFBundleName`/file name), MSIX `DisplayName` (allowed by Partner Center without a new
product), installer branding, notifications title, About. Session, token and settings carry over untouched, the
updater path is unchanged, nothing side by side. Cost: on-disk names (`%LOCALAPPDATA%\TimeTrack`, `TimeTrack.app`,
the Debian package) stay "TimeTrack" until a later reinstall-type migration, which only support staff see.

**Option B: keep `identifier` and keychain, change `productName` (and binary) with a migration release.**
One migration release (BD-1) ships NSIS hooks that adopt the old install (copy the dir key, remove the old uninstall
entry and `Run` value after the new ones exist, as `installer-hooks.nsh` already does for 0.1.0), a Debian package with
`Replaces:`/`Conflicts:`/`Provides:` the old name, and a macOS first-run step that offers to rename `TimeTrack.app`.
Session and settings survive (same identifier). Risk: three per-OS migrations to test (`installer-upgrade-test.yml`
covers Windows), and the Windows passive updater cannot ask questions.

**Option C: new identifier `tech.nowo.beacon.desktop` plus a migration release.**
A last TimeTrack release (0.9.x) exports settings (not the token) to a hand-off file; Beacon Desktop 1.0 imports it and
asks the user to sign in again; the updater feed serves Beacon Desktop's installer to old copies (a different product,
so the passive install lands side by side and the old app must uninstall itself). Clean names everywhere, but: one
forced re-sign-in for every user, a new Store product, two apps during the hand-off, the hardest Windows path, and
macOS permissions (notifications, login item) asked again.

**Recommendation:** Option A for BD-1 (fast, zero user friction, fully reversible). Revisit B (never C) only if on-disk
names cause real support cost (Q-BD-1).

### 2.3 Session, token and settings

- Option A / B: the token stays in the keychain entry (`tech.nowo.time-track-desktop` / `session-token`) and the
  settings in the same `localStorage`; nothing to do. New settings (chat, notification preview level) get defaults with
  `loadLocal()`'s usual "unknown → default" parsing.
- The existing time token keeps working for time only. Chat needs its own token (R3): after BD-2 installs, the user is
  offered "Connect chat" which runs the device flow for the chat scopes only (§4.2). No forced sign-out.
- A second keychain entry, user `chat-token` under the same service, holds the chat token (Q-BD-6 for the shape).
- Sign out = revoke and delete **both** tokens; "Disconnect chat" deletes only the chat one.

### 2.4 Updater feed, repository rename, CI secrets

- **Feed path:** keep `time-track-clients/desktop/...` and the Beacon route `/api/time-track/updates/desktop/...` for the
  installed base (permanent). Optionally Beacon adds a canonical twin under its own versioned segment (for example
  `/api/desktop/v1/updates/{target}/{arch}/{version}`), the same handler and the same `stable.json`; new builds call the
  canonical path with a fallback. The S3 prefix can stay (it is not user-visible); renaming it means double-writing
  both prefixes for at least one release. Q-BD-2 **[Beacon]**.
- **Repository rename** (`time-track-desktop` → `beacon-desktop`): not part of this design's work. GitHub redirects
  web, git and API URLs after a rename, so clones and `gh` keep working; Actions secrets and variables move with the
  repository; self-hosted runners scoped to the repository stay attached. What must be updated by hand: the DEVOPS
  runner spec that names the repository, any `repository:` filter in other repos' workflows, badge URLs and links in docs, and the `ClientApp` description in Beacon. A redirect breaks if a new repository
  is ever created with the old name. Q-BD-3.
- **CI secrets** (`TIME_TRACK_S3_*`, `TAURI_SIGNING_*`) keep their names in BD-1; renaming them is cosmetic and can be
  done with the repository rename. The updater private key is **never** rotated as part of the rename.
- **Release flow** unchanged: public window only during the build, `MACOS_CI_ENABLED=true`, runners per variables.

### 2.5 Signing and notarization

Signing does not depend on the rename, but the rename is the natural moment to ask:

- **macOS**: ad-hoc today. Chat adds notifications that users will want to allow; Developer ID signing plus
  notarization removes the first-open friction and makes Keychain ACLs stable across updates (ad-hoc builds change
  their code identity each release, so macOS may ask again for Keychain access). Needs an Apple Developer account and
  secrets (`APPLE_CERTIFICATE`, `APPLE_ID`/API key) on the macOS job only. Q-BD-4.
- **Windows**: Authenticode (or Azure Trusted Signing) removes SmartScreen and gives a stable publisher name for the
  AUMID toasts. Q-BD-4.
- The bundle id must not change before notarization starts (Option A keeps it).

## 3. Chat

### 3.1 What ChatKitBundle offers today (2.3.1)

- A rich **JSON API for its own front end** (dock and full page): conversations list with `unreadTotal`, messages page
  (`before` / `after` id cursors, fixed page size), send (rate limited, optional idempotency key), edit, delete,
  reactions, read cursor (`POST …/read {messageId}`), mark unread, threads, pins, saved, forward, mute, archive,
  contacts, direct / channel / support openers, presence, status, typing, buzz, links, references, `GET /api/realtime`
  (subscriber token), `GET /api/csrf`, message search (`/api/search`, 1.37+).
- It is **session + CSRF** (`X-CSRF-TOKEN`, token id `nowo_chat`), same-origin, **unversioned**, mounted by Beacon under
  `/dashboard/chat` (`/dashboard/chat/api/...`). Under D-20261110-04 it is **internal UI JSON**: out of the versioning
  rule, and not a client API. A native client must not reuse it (no cookies, no CSRF, no browser session in a Tauri app).
- **Realtime**: `ChatRealtimeTransportInterface` (`isEnabled`, `publish`, `browserHubUrl`, `subscriberToken`);
  `MercureChatRealtime` or `NullChatRealtime` (polling). One private topic per user `/nowo-chat/users/<publicId>`;
  subscriber JWT limited to that topic, subscribe-only, 15 minutes. Events: `message`, `read`, `unread`, `typing`,
  `thread`, `saved`, `conversation`, `status`, …; `message` events carry the **presented message** (viewer-neutral).
- **Push**: `ChatPushSenderInterface` (Web Push in Beacon), `push_preview` (Beacon: `true`, 140 characters), mute
  respected, Messenger messages carry ids only and re-check reachability at delivery.
- **Rate limits** per user public id: send 30/min, actions 240/min, reads 600/min (includes the realtime token),
  typing 30/min, search 30/min, references 120/min.
- **Attachments**: not built (roadmap: StorageKit, size / type / count limits, mandatory host scan before visible).
- **Concurrency / worker**: side effects after commit, documented in `CONCURRENCY.md` and the worker audit;
  limiters and presence need a shared cache in multi-worker setups.

### 3.2 Client API needed (ChatKit, new, versioned)

A new **public client API** in ChatKitBundle, canonical path `<prefix>/chat/v1/...` (Beacon: `/api/chat/v1/...`),
OpenAPI per version, prefix exposed as a container parameter (`%nowo_chat_kit.client_api.v1_path_prefix%`) for
`security.yaml`. **Stateless** (no session read, no cookies, no CSRF; Bearer only), `Cache-Control: no-store,
private`, stable error codes, the same voters and access checks as the UI API (it calls the same application
services; no second copy of the rules). Generic: ChatKit does not issue tokens; it asks a host port who the caller is
and which chat scopes they hold (§4.3).

Minimum surface (BD-2 / BD-3):

| Method and path | Scope | Notes |
|---|---|---|
| `GET me` | `chat:read` | `{userUuid, displayName, features: {realtime, search, attachments}, limits, contextKey}`; the client discovers what the server offers |
| `GET conversations?archived=&cursor=` | `chat:read` | Rows as today plus `unread`, `mutedUntil`, `lastMessage` (filtered per reader, R2); `unreadTotal` excludes muted; cursor paging instead of a fixed cap |
| `GET conversations/{uuid}` | `chat:read` | Header data, members count, permissions of the caller (`canSend`, …) |
| `GET conversations/{uuid}/messages?before=&after=&limit=` | `chat:read` | Same cursors as today, `limit` 1–100; references rendered **for the reader** (inaccessible → neutral placeholder, R2) |
| `GET conversations/{uuid}/messages/{messageUuid}` | `chat:read` | Single message (used after a realtime hint) |
| `GET conversations/{uuid}/messages/{messageUuid}/thread?before=&after=&limit=` | `chat:read` | **BD-2** (owner 2026-11-25): a thread's replies, same cursors and per-reader rendering as messages; every message carries `thread {replyCount, lastReplyAt}` and `reactions [{emoji, count, mine}]` |
| `POST conversations/{uuid}/read {messageId}` | `chat:read` | Read cursor; never beyond the newest message (as today). Q-BD-8 on whether read marks need `chat:write` |
| `POST conversations/{uuid}/messages {body}` + `Idempotency-Key` (required) | `chat:write` | 4000 characters, send limiter; replay answers `200 {replayed: true}` |
| `POST conversations/{uuid}/messages {body, threadOf?}` + `Idempotency-Key` | `chat:write` | **BD-3**: `threadOf` (a message uuid) replies in that thread |
| `PATCH` / `DELETE conversations/{uuid}/messages/{messageUuid}` | `chat:write` | BD-4; edit / delete window as today |
| `PUT` / `DELETE conversations/{uuid}/messages/{messageUuid}/reactions/{emoji}` | `chat:write` | **BD-3** (owner 2026-11-25): react / remove own reaction, action limiter |
| `PUT` / `DELETE conversations/{uuid}/mute` | `chat:write` | Mute from the desktop |
| `GET realtime` | `chat:read` | `{enabled, hubUrl, token, topic, expiresAt}` exactly as today, issued by Beacon's `BeaconChatRealtime` (R1) |
| `GET search?q=&conversation=&cursor=` | `chat:read` | Optional (`features.search`); same limiter and per-row filter as `/api/search` (Q-BD-10) |
| `GET notifications/preview/{messageUuid}` | `chat:read` | What a desktop notification may show for this reader (§3.4); answers `{title, body\|null}` after mute, preferences and policy checks |

**Threads and reactions are in the first chat version** (owner 2026-11-25): BD-2 shows them read-only (thread panel,
reply counts, reaction chips); BD-3 adds replying in threads and reacting, alongside send.

Out of the first version: pins (later), saved, forward, support inbox, presence / status writes, typing, buzz, link
management, quick replies (they stay in the web UI; "Open in Beacon" deep link to `/dashboard?chat={uuid}`).

**Attachments policy (until ChatKit ships attachments):** the desktop shows an attachment as a neutral card "File —
open in Beacon" (no file name if the reader cannot open it) and never downloads. When attachments land, downloads go
through a ChatKit endpoint that redirects to a short-lived signed URL after the access check and the mandatory scan;
uploads (if ever) use intent + signed PUT like monitoring (§6), never direct S3 credentials. Q-BD-11.

### 3.3 Realtime transport

Decision (R1): **Mercure over SSE** against Beacon's hub, private updates, topic = the caller's own, JWT from
`GET /api/chat/v1/realtime`. No WebSocket, no other broker.

Client behaviour (in Rust, not the web view, so the hub URL and JWT never touch script):

1. `GET realtime`. If `enabled: false` or the call fails → **polling mode**.
2. SSE to `hubUrl?topic=<topic>` with `Authorization: Bearer <subscriber JWT>` (header, not query string, so it does not
   reach access logs; Q-BD-12 **[Beacon]** to confirm the hub accepts the header from a non-browser client). The hub
   origin must be the bound Beacon origin or a host Beacon names; it goes through the same pinned TLS client.
3. Refresh the JWT ~2 minutes before `expiresAt` and reconnect with `Last-Event-ID` (Mercure history) to avoid gaps.
4. **Events are hints, never data**: on `message` / `read` / `unread` / `conversation` the client refetches through the
   client API (`messages?after=`, `conversations`) and renders only what the API returns. This keeps R2 even if a
   hub payload carried more than the reader may see, and it means the desktop does not depend on the payload shape.
   Q-BD-13 **[Beacon]**: should ChatKit offer an ids-only event shape (`{type, conversationUuid, messageUuid}`) for
   private topics, so viewer-neutral message bodies (and rendered references) never travel to any client?
5. **Polling mode** (hub off, SSE failing, or corporate proxy dropping streams): `GET conversations` every 30 s while
   the Chat view is open, 120 s in the background, exponential backoff with jitter on errors up to 10 min, honour
   `Retry-After` on `429`; try SSE again every 10 min. Budget: well inside the 600 reads/min limit.
6. **Offline / sleep**: on wake, network change or reconnect, one catch-up (`conversations`, then `messages?after=` for
   the open conversation); no duplicate notifications for messages older than the last seen id per conversation.
   **Offline send queue** (UX batch 5, owner approval 2026-11-27): a message that cannot reach the server (no network,
   a `5xx`) is *queued* ("Waiting for connection"), never "Not sent". It goes out when the sync sees the connection
   again, on its own backoff probe (2 s doubling to 30 s), or on *Try now*; *Cancel* takes it back into an empty
   message box. Messages of one conversation (timeline and threads) go out one at a time in the order they were
   written; each keeps its `Idempotency-Key`, and only one attempt per message is ever in flight, so a reconnect never
   sends it twice (and the server dedupes a replay whose answer was lost). The queue lives in the chat module: it
   survives switching to Time or Tasks, but **not** a context switch, *Disconnect chat*, sign-out or quitting the app;
   the text is never written to disk (Q-BD-15 stays A). Only refusals (`4xx`) and a `429` that outlasts the automatic
   retries end as *Not sent*.

### 3.4 Desktop notifications, privacy and badge

- **Opt-in**: chat notifications are off until the user turns them on (first Chat visit asks once, calm card, not an
  OS prompt at install). Separate switch from the existing time notifications.
- **Preview levels** (per device, default **none**):
  - *None*: "New message in Beacon" (no sender, no conversation, no text).
  - *Sender*: "New message from <name>" / "in #<channel>".
  - *Text*: sender plus the first 100 characters.
- The server decides the **maximum** level: the notification content comes from `GET notifications/preview/{uuid}`,
  which applies mute, the person's chat preferences, R2 (references reduced to "not visible") and the organization
  policy. **Owner decision 2026-11-25 (refines Q-BD-9):** an organization with a strict policy sets its maximum preview
  level to **Sender only** or **None** (organization setting, enforced server-side in Web Push and in the hub /
  preview endpoint); a user can choose a stricter level, never a looser one. The client can only lower it.
- **Lock screen**: no message text on the lock screen by default. Windows toasts: the app sets the toast as private
  when the level is *Text* (`ShowOnLockScreen` off where supported) and the Settings text explains that Windows' own
  "show notifications on the lock screen" applies. macOS: the system "Show previews: when unlocked" setting is
  respected; Linux: the urgency hint and `x-kde/gnome` privacy hints where supported. Where the OS gives no control the
  app falls back to *Sender*.
- Do Not Disturb / Focus is respected by the OS; the app adds "Pause chat notifications for 1 h / until tomorrow".
- Muted conversations never notify and leave the badge (same rule as `unreadTotal`).
- **Web Push and desktop at once**: a person with Beacon open in a browser and the desktop would get both. Q-BD-14
  **[Beacon]** (recommendation: when a desktop chat session is connected, the desktop owns notifications for that
  user; Beacon skips Web Push to that user's browsers while the desktop's realtime subscription was active in the last
  2 minutes; otherwise both, deduplicated by message uuid on the device).
- **Unread badge**: tray icon dot plus count in the tooltip; Windows taskbar overlay, macOS Dock badge, Linux
  `com.canonical.Unity` launcher count where present. Count = `unreadTotal` (muted excluded). Clicking a notification
  opens the app on that conversation.

### 3.5 Server-side constraints: rate limits, worker mode, concurrency

- **Rate limits**: the client API reuses ChatKit's limiters keyed by user public id (send, actions, reads, search), so
  web and desktop share one budget per person; plus a per-token limiter and a per-IP limiter on the client API
  (as TimeTrackBundle does: 300/min per IP, 60/min per token as a starting point) with `429 rate_limited` +
  `Retry-After`. The realtime token endpoint counts as a read.
- **Worker mode (R7)**: FrankenPHP, kernel kept alive and **not reset**. The client API keeps no request, user, tenant
  or token data in service properties, statics or memo caches across requests; the principal is resolved per request
  from the Bearer token; the tenant context is a request attribute, never written to a service. Worker test: one kernel,
  thousands of requests, two users in two tenants, token revoked mid-run, flat memory (REQ-RUNTIME-002).
- **Concurrency (REQ-RUNTIME-003)**: send idempotency already exists; read cursor updates must be monotonic
  (`max(current, requested)` in SQL, never a lost update from two devices); mute and archive are last-writer-wins on
  one row; realtime publishes stay after commit.
- **Shared storage**: limiters and presence in the shared cache pool (Redis) across workers, as ChatKit's security doc
  already requires.

## 4. Auth

### 4.1 Requirements

R3 fixes: device code, separate `time` and `chat` scope families, deny by default, revocable from the account,
audited like today's clients, a chat token cannot open the time API and the other way round, routes under
`/api/<bundle>/v<N>`.

ApiTokenBundle is **not** the vehicle: its contract excludes OAuth and device flow ("TimeTrack keeps its device flow
and its own client session tokens"), and its tokens are personal tokens created in the account UI.

### 4.2 Device flow shared by time and chat

Recommended design (Q-BD-5 **[Beacon]**):

- **TimeTrackBundle generalises its device flow** (additive, contract v0.5, on `/api/time-track/v1/device/*` with the
  unversioned twins kept): hosts register extra **scope families** through a port
  (`DeviceScopeFamilyProviderInterface`: family key, scopes, labels). Beacon registers `chat` with `chat:read`,
  `chat:write`. TimeTrackBundle keeps owning `time` (`timer:*`, `tasks:read`, `entries:*`, `meetings:read`, …).
- One `device/code` request may name scopes of **one family only**; mixing families is `400 invalid_scope`. The client
  runs the flow once per family. The approval page (Beacon, with 2FA re-auth) shows one family per approval, each
  scope unchecked by default except the minimum the client asked as required; "deny" is the default button focus.
- The issued token carries its family; TimeTrackBundle's authenticator refuses a `chat` token on time routes, and the
  chat client API refuses a `time` token (both `403 insufficient_scope`).
- **One approval, two tokens** (a single page that issues both) is the alternative: fewer steps for the user, but a
  token response shape change and a harder revocation story. Recommendation: two flows; the app chains them ("Connect
  chat too?") so the user sees two short approvals in a row at first sign-in.
- Longer term, if a third client family appears, extract the device flow and client tokens into a small generic bundle
  (Q-BD-5 option C).

### 4.3 How ChatKit authenticates a client token

ChatKit does not issue or store tokens. Its client API depends on a port:

```text
ChatClientPrincipalResolverInterface::resolve(string $bearer, ChatRequestContext $ctx): ?ChatClientPrincipal
ChatClientPrincipal { ChatUserInterface $user, list<string> $scopes, string $tokenId, ?string $contextKey }
```

Beacon implements it over TimeTrackBundle's token lookup for the `chat` family (user checker, credential state,
revocation, audit through `ClientApiAuditSubscriber` with `client_api: chat`). Any other host can implement it with its
own tokens: the protocol stays generic and versioned in the bundle, the app stays Beacon-only.

### 4.4 Tenant / organization context (R4)

- The server-stored `User::organizationContext` is the **web** context and is never written by the desktop.
- Every client API request names its context explicitly: header `X-Beacon-Context: personal` or
  `X-Beacon-Context: org:<uuid>` (Q-BD-7 **[Beacon]**; alternative: bind the context into the token at approval). The
  server checks membership on every request; an unknown or revoked membership is `403 context_forbidden`, the same
  answer as a context that does not exist.
- `GET me` (time and chat) lists the contexts the user may use; the app shows a context switcher in the shell header
  (§5) and stores the last choice per device. Switching refetches everything; the realtime topic stays the same (the
  user's own); events for other contexts are hints that only refetch the current context's lists.
- Time and chat may use different contexts at the same time only if Beacon allows it; recommendation: one context for
  the whole app at a time, simpler to explain.
- **Owner decisions 2026-11-25:** the switcher is a setting (rail tiles or a title-bar dropdown). A timer never keeps
  running in another organisation: switching while a timer runs asks "Stop the timer in <org> and switch?" (stop
  through the stop dialog when required fields are missing, then switch) or Cancel (details in
  [BEACON_DESKTOP_TASKS.md §9](BEACON_DESKTOP_TASKS.md#9-the-tasks-module-in-the-app)).

### 4.5 Token storage

- OS keychain only, as today: service `tech.nowo.time-track-desktop`, users `session-token` (time) and `chat-token`
  (chat). Only Rust reads them; the web view never sees either. Each token is bound to the origin that issued it.
- Sign out: revoke both (`logout` on each API), then delete both entries, settings, caches (chat message cache in
  memory only; no message bodies written to disk in BD-2/BD-3, Q-BD-15).
- Revocation from the account (Beacon → Account → Security → Connected apps) shows **two rows** per device (Time,
  Chat), each revocable; a `401 invalid_token` on chat disconnects chat only.

## 5. UI shell

- **Navigation**: the existing compact window gets a two-item top-level switch, **Time** and **Chat** (roving tab
  index, `role="tablist"`, `Ctrl/Cmd+1` / `Ctrl/Cmd+2`). Settings stays in its own view with a new *Chat* tab (connect /
  disconnect, notifications, preview level, pause). The tray menu gains *Open chat* and the unread count.
- **Landing module** (owner decision 2026-11-25, three modules: Time, Chat, Tasks): Chat on first launch, then the
  last-used module; Time when a timer is running at launch (details in
  [BEACON_DESKTOP_TASKS.md §9](BEACON_DESKTOP_TASKS.md#9-the-tasks-module-in-the-app)).
- **One shell for every module** (UX batch 6, owner approval 2026-11-27, UXA-1 / UXA-2 / UXA-4 / UXA-30):
  - The Time module is hosted in the shell's grammar: no header, *Compact view* toggle or Settings of its own; its
    sections (*Track*, *Pinned and recent*, *My time*) sit in a module sidebar like Chat's; the detail pane shows from
    1100 px. Task rows carry one quiet play icon (as Tasks' cards). The mini timer, the stop dialog with required
    fields, the switch confirmation and the timer placement setting stay as approved in BD-3a.
  - **One Settings** dialog (rail gear, `Ctrl/⌘+,` in every module, tray): General, Appearance, Timer, Shortcuts,
    Schedule, Notifications, Meetings, Chat, Tasks, Updates, **Account** (identity, the three connections with
    *Disconnect…* behind a confirmation, *What we collect*, *Sign out*). The "Settings stays in its own view" line
    above is superseded.
  - **Guided first run**: after the first sign-in a setup card chains the Chat and Tasks approvals (§4.2), each step
    skippable, resumable (Settings → Account, or the next launch if the app quit mid-way); it ends on Chat. A fresh
    sign-in no longer forces Time: the landing rule applies.
  - **First window** about 1200 × 780, centred and clamped to the work area; the remembered size wins afterwards.
- **Timer placement** (owner decision 2026-11-25): a setting, title bar only or title bar + sidebar; the mini timer
  stays a separate, always-available window.
- **Sidebar** (owner decision 2026-11-25): density is a setting, comfortable or compact. In Chat, **project channels
  get their own section**, separate from the organisation's channels (direct messages keep theirs).
- **Timer prompts** (owner decision 2026-11-25): when an activity type or client is required, a per-user setting asks
  for it **on start**, **on stop** or **both**; default **on stop**, because TimeTrack 2.1 enforces `require_*` at stop
  (`409 allocation_required` / `activity_type_required`). Inheriting the task's last activity type on start is a
  setting too.
- **Column markers** (owner decision 2026-11-25): a per-user setting, TaskBoard's column emojis as they are or colour
  dots.
- **Chat view** at the current window size (≥ 380 px): list ↔ conversation (one pane, back button); in the wider
  "full view" (0.8.0) list and conversation side by side. Composer: plain text, Enter to send, Shift+Enter new line,
  character counter near 4000; Markdown rendered by the server (text-only DOM in the client: the server's HTML is never
  injected; the API gives a safe structured form or plain text, Q-BD-16).
- **UiKit**: reuse UiKit **design tokens** (colours, spacing, radius, typography, focus ring) so the app matches
  Beacon in light and dark; no UiKit runtime JS in the app (strict CSP, `script-src 'self'`). The chat list and bubbles
  follow ChatKit's dock look through the same tokens. Mascot stays out of the chat view except empty states.
- **Chat home view** (UX batch 5, owner approval 2026-11-27; replaces "Pick a conversation"): shown while no
  conversation is open, and from a *Home* entry at the top of the sidebar. **Unread** conversations (not muted, newest
  first, up to 8, with their preview), **Mentions** (messages that mention the reader in the timelines loaded this
  session, newest first, up to 5; the newest page of up to 3 unread conversations is loaded once per context so their
  mentions show) and **Recent** conversations (opened this session, then the list order). One tab stop, `↑ ↓ Home End`
  between rows, `Enter` opens (a mention opens its conversation with that message focused); `Esc` in a conversation
  comes back here. "All caught up" and an empty organization show a small decorative mascot (UXA-47). Memory only, like
  the rest of the chat.
- **Accessibility** (WCAG 2.1 AA, as the app already does): new messages announced through a polite live region
  ("2 new messages from Ana"), never the full text by default; focus stays on the composer when a message arrives;
  every action reachable by keyboard; unread state not by colour alone; reduced motion respected; both locales (en, es)
  for every string.
- **Branding**: product name "Beacon Desktop" in titles and About; app icon from the Beacon mascot family (owner
  approved the mascot head for TTD on 0.8.x); Q-BD-17 on the exact display name.

### 5.1 Window chrome and the update pill (UX batch 7, owner approval 2026-11-27)

- **One title bar** (UXA-45). The app's 44 px title bar is the window's only one:
  - **Windows / Linux**: no system frame (`decorations: false`, decided in Rust, `chrome_for`). The bar is the drag
    region (`data-tauri-drag-region="deep"`: buttons, links and fields inside it stay clickable); a double click
    maximises / restores; dragging to a screen edge snaps as with any window, and `Win+←/→/↑/Z` work. The app draws
    minimise · maximise / restore · close at the right edge in that order (`src/shell/windowControls.ts`): Windows 11
    caption buttons (46 px, the bar's full height, close red `#c42b1c` with white text on hover), Linux round 24 px
    buttons (Adwaita / Breeze). They are real buttons in a group named "Window", the last Tab stops of the bar, named
    "Maximize" or "Restore" as the window is, with tooltips. Close hides the window to the tray, as the system button
    did; the system's own resize borders, `Alt+F4`, `Alt+Space` and the taskbar menu keep working.
  - **macOS**: the system title bar overlays the app's (`TitleBarStyle::Overlay`, hidden title), traffic lights
    inset at 16 × 16 pt so they sit centred in the 44 px bar; the bar keeps 76 px free on the left and drags the window.
  - **Signed out**, the bar stays (brand and the window buttons only) so the sign-in window can still be moved and
    closed. With the system's frame (fallback) the signed-out screen has no app bar, as before.
  - **Not possible with Tauri 2.12**: the Windows 11 Snap Layouts flyout when hovering maximise (it needs the system's
    `HTMAXBUTTON` hit test on a native caption button; tauri-apps/tauri#4531). Snapping by dragging and `Win+Z`
    still work.
  - **Linux fallback**: some desktops may handle an undecorated window badly (for example a Wayland compositor that
    gives it no resize border or shadow, or a tiling window manager that draws its own frame; not yet tried on a real
    GNOME / KDE Wayland session, only in the browser build). Start the app with
    `BEACON_DESKTOP_SYSTEM_TITLEBAR=1` (for example in the `.desktop` file's `Exec=env BEACON_DESKTOP_SYSTEM_TITLEBAR=1
    …`) to keep the system title bar; the app then draws no buttons of its own. The same variable works on Windows.
  - The **mini timer** and the "Still there?" windows keep their own chrome.
- **Update pill** (UXA-22). An installable update shows as a pill at the left of the title bar's tools ("Update",
  named "Update to version X"), never as a card above the task list. It opens the same update card in a popover
  panel under it (What's new, Update now, Later; light dismiss and `Esc` give the focus back to the pill). The pill
  follows the install: "Update after stop" while it waits for the timer, "Updating 45%", then "Restarting…". A manual
  "Check for updates…" that finds one opens the panel. "Later" hides pill and panel until a manual check or the next
  launch. The forced update keeps its full screen, with its way out (Remind me later), unchanged.
- **Title bar at 900 px** (UXA-9). Below 1100 px the search collapses to its icon (same name and `Ctrl+K`, the global
  switcher of §5.2) and the brand to its mark before anything else; the organization keeps at least 12 characters and
  the running task at least a few before an ellipsis.
- **Tray** (UXA-41). *Quick add task…* (while tasks are connected) opens the window on Tasks with quick add focused.
  Empty submenus (Switch to, Today's meetings) are not shown.

### 5.2 Keyboard: global shortcuts in every module (UX batches 2 + 3, owner approval 2026-11-27)

- **App-wide keys**, handled by the shell before the module in view, the same in Chat, Tasks and Time:

  | Key | Does |
  |---|---|
  | `Ctrl/⌘+K` | Quick switcher (also from a text field) |
  | `Ctrl/⌘+1` `2` `3` | Chat / Tasks / Time |
  | `F6` / `Shift+F6` | Next / previous area: title bar, rail, the module's panes |
  | `Ctrl/⌘+,` | Settings |
  | `Ctrl/⌘+Shift+L` | Light / dark theme (its only meaning) |
  | `Ctrl/⌘+Shift+S` | Stop the timer, or resume the last task |
  | `Ctrl/⌘+Shift+M` | Mini timer (where the platform has it) |
  | `?` | The shortcut sheet |

  `Ctrl/⌘+Shift+L` used to be the compact / full view in the standalone Time window; that view keeps its header button
  and tray item, and the hosted Time module never had it (§5, UX batch 6).
- **Quick switcher**: one list over the modules that are connected. Chat: conversations (recent first, unread in
  bold). Tasks: the boards, then the tasks loaded (My tasks first); a board opens the board view on it, a task opens
  its panel. Time: *Stop the timer* while one runs, *Start timer* / *Switch timer here* on pinned and recent tasks (and
  on any task of the list once you type), *My time* and *Pinned and recent* (full layout). With no query the module in
  view leads with up to 8 of its own, the others follow with 3 each; with a query every match is ranked together by
  the same fuzzy score, the module in view winning ties. In Time, `/` searches the task list.
- **The sheet** (`?`) shows *Anywhere* and the section of the module in view only (Chat, Tasks or Time).
- **Areas** (`F6`): title bar (the search), rail (the selected module), then Chat's sidebar (the conversation that
  takes Tab), conversation (the message box; the home view's first row) and thread; Tasks' page (the row or card that
  takes Tab, else quick add) and task panel; Time's sidebar (the current section), list (the search field) and details.
  From outside any area `F6` starts at the module's first pane, `Shift+F6` at its last.
- **`Alt+↑` / `Alt+↓`**: previous / next conversation (Chat), board (Tasks, board and list views), section (Time, full
  layout).
- **Long lists are one Tab stop** (roving tabindex, `src/ui/roving.ts`): the chat sidebar, My tasks and the list view
  (`↑ ↓ Home End`; in a task row `← →` reach its checkbox, status menu and play button, which are not Tab stops), the
  Time list (UX batch 6) and the chat home view (UX batch 5). Tab follows the visual order: title bar, rail, sidebar,
  content.
- **Landmarks**: one `header` (the title bar), the rail and the module sidebars are `nav`, each module's content is
  its `main` (only the shown module's is visible), detail panels are `aside`.

## 6. Monitoring screenshots and the update feed: two different S3 paths

They are unrelated and must not be confused:

| | Monitoring screenshots (R6) | App update feed |
|---|---|---|
| What | Opt-in activity monitoring evidence (phase 0 has no screenshots; D7 moved them to the last phase) | Installers, updater bundles, `stable.json` |
| Bucket | The organization's (or personal) **storage profile**, keys `Y/m/<uuid>` | The **release bucket**, prefix `time-track-clients/desktop/` |
| Who writes | Beacon, after the desktop's `POST monitoring/screenshots/intent` and a signed `PUT` to a Beacon-provided URL; Beacon blurs / converts to webp before it is visible | GitHub Actions `release.yml` with `s3:PutObject` on `time-track-clients/*` only |
| Desktop's credentials | None; it never writes to S3 directly and never knows profile credentials | None; it reads through Beacon's updater route, which hands out a pre-signed GET URL |

Beacon Desktop does not change either. Monitoring stays as TimeTrackBundle defines it (opt-in, never scored, owner
decisions D1–D15 of 2026-11-24). Whether the update feed should move to a product-neutral prefix (for example
`beacon-desktop/`) is Q-BD-2.

## 7. Phases and versions

Version numbers continue the app's line (0.8.0 today). Each phase lists the bundle and Beacon work it needs. Security
audits (REQ-SEC-004) are **immediate** for anything that touches authentication, tokens or permission filtering, batched
otherwise (owner rules 2026-11-07 / 2026-11-13).

| Phase | App version | App work | TimeTrackBundle | ChatKitBundle | Beacon | Audit |
|---|---|---|---|---|---|---|
| **BD-0** design | — | This document; owner answers Q-BD-n | — | — | Answers to [Beacon] questions | — |
| **BD-1** rename (Option A) | **0.9.0** | Visible name "Beacon Desktop" (titles, shortcuts, `.desktop` `Name=`, `CFBundleDisplayName`, MSIX `DisplayName`, installer branding, About, i18n); shell with Time / Chat switch (Chat shows "coming soon" or is hidden behind `features.chat`); `installer-upgrade-test.yml` run from 0.8.0 → 0.9.0 on Windows, manual check on macOS / Linux | — | — | Download page and Apps page text "Beacon Desktop"; optional canonical updater twin (Q-BD-2) | Batched (no auth change) |
| **BD-2** chat read-only | **0.10.0** | "Connect chat" device flow (chat family), second keychain entry, context header, conversations list, messages page, **threads (thread panel, reply counts) and reactions shown read-only**, read marks, realtime (SSE + polling fallback), unread badge; no notifications yet; no send | **2.2.0** (minor): scope families port, family-bound tokens, `invalid_scope` for mixed families, contract v0.5 | **2.4.0** (minor): client API `/chat/v1` read routes (`me`, `conversations`, `messages`, `thread`, `read`, `realtime`; messages carry `thread` and `reactions`), `ChatClientPrincipalResolverInterface`, OpenAPI v1, worker test, per-reader reference filtering in the client API | Register `chat` family; implement the principal resolver over client tokens; audit subscriber for chat; context header; approval page with family; firewall pattern for `^/api/chat/v1/`; account page shows two rows per device | **Immediate**: TimeTrackBundle 2.2.0 (auth), ChatKit 2.4.0 (new authenticated API, R2 filtering), Beacon resolver + approval page. App: immediate review of token storage and realtime client |
| **BD-3** chat send + notifications | **0.11.0** | Send with idempotency, **reply in threads, react**, mute, notifications with preview levels and pause, Web Push dedupe, tray *Open chat*, deep links | — (or patch) | **2.5.0**: send (with `threadOf`) / reaction / mute routes, `notifications/preview`, optional ids-only realtime events (Q-BD-13), search route if Q-BD-10 says yes | Notification policy per organization (Q-BD-9: max level *Sender only* or *None*, Web Push and hub), Web Push suppression while desktop is active (Q-BD-14) | **Immediate** for the preview endpoint (data exposure) and send path; batched for UI |
| **BD-4** polish / 1.0 | **1.0.0** | Edit / delete, search, offline send queue (optional), attachments as "open in Beacon" cards; signing and notarization if Q-BD-4 says yes; repository rename if Q-BD-3 says yes | — | Attachments when ChatKit ships them (StorageKit + scan) | Signing accounts / secrets | Batched + full audit before 1.0.0 |

Ordering with Beacon: Beacon's own requests first (owner priority), then BD-1 can ship at once (no server work); BD-2
waits for TimeTrackBundle 2.2.0 and ChatKit 2.4.0 plus their audits.

Every touched bundle closes all its REQ gaps (100 % REQs) before its tag (owner rule 2026-11-24).

The tasks module adds work to BD-2 (family registered, off), BD-3 (tasks core, TaskBoardBundle 3.4.0) and BD-4
(realtime, comments, questions, create from chat, TaskBoardBundle 3.5.0): see
[BEACON_DESKTOP_TASKS.md §11](BEACON_DESKTOP_TASKS.md#11-phases-and-versions).

### 7.1 BD-3a (built ahead of BD-3, app 0.11.0)

Time context, mini timer and required fields, without the tasks module (it needs TaskBoard's client API, 3.4.0).
Owner decisions: Q2 (timer placement + mini window), Q4 (switching with a running timer), Q5 (required fields on
start / stop / both, inherit the task's last activity type). File inventory:

| File | New / changed | Role |
|---|---|---|
| `src/lib/allocation.ts` | new | Required-field rules (`GET me.features` 2.1), ask on start / stop / both, last activity per `context\|taskId`, `GET me.contexts` |
| `src/shell/allocationDialog.ts` | new | Native modal dialog: activity type (loading / empty / offline / 429 states), optional subject combobox |
| `src/ui/miniWindow.ts` | new | Mini timer window (`index.html?window=mini`): view, buttons, keys; no session, no network |
| `src-tauri/src/mini.rs` | new | `mini_open` / `mini_update` / `mini_close` (main), `mini_view` / `mini_action` (mini), placement, closed event |
| `src-tauri/capabilities/mini.json` | new | Mini window ACL: listen + its two commands |
| `playwright.bd3a.config.ts`, `tests/screenshots/bd3a.spec.ts` | new | Owner screenshots, axe on every new dialog |
| `tests/unit/bd3a.test.ts` | new | Context header and fallback, required fields, switch, mini timer, ZBZ-v-I3 |
| `src/api/client.ts`, `src/api/types.ts` | changed | `X-Beacon-Context`, Personal retry for reads, `timer/allocate`, `activity-types`, `subjects/search`, allocation on start / stop / switch |
| `src/ui/app.ts`, `src/lib/settings.ts` | changed | Context of the time API, fields asked on start / stop / switch, 409 handling, settings |
| `src/shell/shell.ts`, `src/chat/module.ts`, `src/chat/i18n.ts`, `src/chat/icons.ts`, `src/chat/chat.css` | changed | Switch flow, time-only contexts, mini timer toggle, Settings → Time tracking, ZBZ-v-I3 |
| `src/platform.ts`, `src/platform-tauri.ts`, `src/main.ts` | changed | `MiniHost` / `MiniClient`, `bringForward` |
| `src-tauri/src/secret.rs`, `src-tauri/src/browser.rs`, `src-tauri/src/lib.rs`, `src-tauri/app-commands.rs`, `src-tauri/capabilities/default.json` | changed | ZBZ-v-I1 base path, ZBZ-v-I2 `%20`, mini commands and ACL |
| `mock-server/server.mjs` | changed | Context policy, activity types, subjects, `timer/allocate`, `409 activity_type_required`, tasks per context |
| `src/lib/replay.ts`, `src/lib/queue.ts` | changed (ZCD) | Queued actions carry their context and allocation; replay per context; a replay 409 is kept (`blocked`) |
| `tests/e2e/bd3a.spec.ts` | new (ZCD) | Two organizations + offline queue; mini timer keyboard focus |

### 7.2 BD-3b, part 1: chat writes (app 0.12.0 candidate)

Send, thread reply and reactions against **ChatKitBundle 2.5** (released; Beacon runs 2.8 with `client_api.writes:
true` and the `chat` family granting `chat:read chat:write`). Checked against the released sources (ChatKit v2.8.0
`docs/API.md` → Writes, `docs/openapi/chat-client-v1.yaml` 1.4.0), which differ from §3.2's sketch in two places:

- A thread reply is `POST conversations/{uuid}/messages/{messageUuid}/thread {text}`, not a `threadOf` field.
- A write body has **one field, `text`** (2.6 adds `cards`, 2.7 `attachments`, both behind `me.features`); any other
  field is `422 unsupported_field`. Every write needs an `Idempotency-Key` (1–80 of `[A-Za-z0-9_.:-]`), deduplicated
  per token and conversation for 24 h.

**Not in ChatKit's client API yet** (2.8.0): `PUT` / `DELETE conversations/{uuid}/mute`, `GET notifications/preview/
{messageUuid}`, the per-organization preview maximum (Q-BD-9) and the Web Push suppression (Q-BD-14). The
notifications and mute part of BD-3 waits for them (ChatKit + Beacon work); see the open questions of the PR.

Behaviour: feature detection (`me.scopes` has `chat:write`, `me.features.send / threadReply / reactions`, the row's
`canSend`), one key per write kept until the write is sent or discarded, automatic retries after `429` / `409` (same
key, at most three), the offline send queue after a network error or a `5xx` (§3.3, UX batch 5: *Try now* / *Cancel*,
same key, order kept), *Edit* / *Discard* after a refusal, the sent message shown from the write's answer until the catch-up brings it (the timeline is
never patched directly, so `after=` never skips a message). Drafts and unsent messages are memory only (Q-BD-15).

| File | New / changed | Role |
|---|---|---|
| `src/chat/composer.ts` | new | Message box: formatting toolbar (one tab stop), IME-safe Enter, submit button, counter, `field-sizing` with a fallback |
| `src/chat/markdown.ts` | new | The composer's Markdown subset as `tokens/1` (pending rows; the mock loads the same module) |
| `src/chat/outbox.ts` | new | Writes in memory: keys, states (sending / waiting / failed / sent), retries, settle after catch-up, optimistic reactions |
| `src/chat/api.ts`, `src/chat/types.ts` | changed | `send`, `reply`, `react` with `Idempotency-Key`; `me.features` 2.5, `limits.textMaxLength`, `reactions.quick / accepted`, `canSend`, `writeAccess()` |
| `src/chat/module.ts`, `src/chat/store.ts`, `src/chat/sync.ts` | changed | Composer and thread box, pending rows, reaction toggles, hover toolbar, picker (`E`), reply (`R`), `C`, `Shift+F10`, "Allow sending" |
| `src/api/client.ts` | changed | "Connect chat" asks for `chat:read chat:write`, falls back to `chat:read` on `invalid_scope` |
| `src-tauri/src/net.rs`, `src-tauri/src/secret.rs` | changed | `PUT` / `DELETE` only on the anchored reaction route (`is_reaction_path`, audit ZDG-L1); `idempotency-key` request header allowed |
| `mock-server/chat.mjs`, `mock-server/server.mjs` | changed | Write routes with key replay / mismatch, `read_only`, writes off, read-only chat family |
| `tests/unit/chat-writes.test.ts`, `tests/unit/shell-writes.test.ts`, `tests/e2e/chat-writes.spec.ts`, `tests/screenshots/bd3b.spec.ts` | new | API, outbox, composer, module, e2e with axe, owner screenshots |

### 7.3 BD-3b, part 2: the Tasks module (app 0.13.0 candidate)

Built against the released **TaskBoardBundle 3.4.1** client API (`docs/CLIENT-API.md`,
`docs/openapi/task-board-client-v1.yaml`), behaviour as [BEACON_DESKTOP_TASKS.md §9](BEACON_DESKTOP_TASKS.md#9-the-tasks-module-in-the-app).
Differences from the TASKS design, from the released contract: the description is answered as `tokens/1` only (no
Markdown source), so the panel shows it and offers "Edit in Beacon"; comments, questions and subtask writes are 3.5;
a single-assignee picker removes the other assignees (`DELETE members/{user}` drops every role of that person).
Beacon still has to register the `tasks` family and the TaskBoard `client_api` (B-T1..B-T4, B-T8, B-T9).

| File | New / changed | Role |
|---|---|---|
| `src/tasks/api.ts`, `src/tasks/types.ts` | new | Client and parsers of `/api/task-board/v1` (If-Match, Idempotency-Key, `module_forbidden`) |
| `src/tasks/module.ts`, `src/tasks/format.ts`, `src/tasks/i18n.ts`, `src/tasks/tasks.css` | new | The module: connect, My tasks, kanban, list, panel, quick add, polling through `changes` |
| `src/shell/shell.ts`, `src/platform*.ts`, `src/api/client.ts` | changed | Third tab (Chat, Tasks, Time), markers setting, `TasksHost`, `tasksDeviceCode` |
| `src-tauri/src/secret.rs`, `src-tauri/src/net.rs`, `src-tauri/src/lib.rs`, `src-tauri/app-commands.rs`, `src-tauri/capabilities/default.json` | changed | `tasks-token`, `Route::Tasks`, `tasks_status` / `tasks_connect_begin` / `tasks_disconnect`, task write routes, `if-match` / `etag` |
| `mock-server/tasks.mjs`, `mock-server/server.mjs` | new / changed | TaskBoard client API mock (revisions, conflicts, policy refusal, `module_forbidden`) |
| `tests/unit/tasks.test.ts`, `tests/unit/tasks-module.test.ts`, `tests/e2e/tasks.spec.ts`, `tests/screenshots/tasks.spec.ts` | new | API, parsers, module, e2e with axe, owner screenshots |

### 7.4 BD-3b, part 3: notifications (level None), tray, links (app 0.13.0 candidate)

Owner decision 2026-11-27: notifications ship opt-in at level **None** with pause; Sender / Text wait for a ChatKit
minor (mute, `notifications/preview`, members and reference search) and the organization's maximum (Q-BD-9). Web Push
dedupe (Q-BD-14) is Beacon work. Links: `beacon-desktop://chat/<uuid>` / `beacon-desktop://tasks/<id>`
(`?context=`), navigation only.

| File | New / changed | Role |
|---|---|---|
| `src/chat/notifications.ts` | new | Opt-in, level None, pause, prime / dedupe / gap rules |
| `src/shell/shell.ts`, `src/chat/module.ts`, `src/ui/app.ts`, `src/platform*.ts`, `src/main.ts` | changed | Opt-in card, Settings → Chat, tray items, `openTarget` for clicks and links |
| `src-tauri/src/deeplink.rs`, `src-tauri/src/notify.rs`, `src-tauri/src/lib.rs`, `Cargo.toml`, `tauri.conf.json` | new / changed | Link parsing and hand-over, notification click target, tray chat items, deep-link plugin |
| `tests/unit/chat-notify.test.ts`, `tests/screenshots/notify.spec.ts` | new | Rules, shell flows, owner screenshots |

## 8. Open questions

Each question has options and a recommendation. **[Beacon]** = needs Beacon's answer; the rest are the owner's.
Q-BD-20 onwards (tasks module) are in [BEACON_DESKTOP_TASKS.md §10](BEACON_DESKTOP_TASKS.md#10-open-questions).

| Id | Question | Options | Recommendation |
|---|---|---|---|
| **Q-BD-1** | How far does the rename go on disk? | A: visible name only, all ids kept · B: `productName` / binary renamed with a migration release, identifier kept · C: new identifier + migration release | **A** for BD-1; B only if support cost shows up; never C |
| **Q-BD-2** **[Beacon]** | Updater path and S3 prefix | A: keep `/api/time-track/updates/desktop/...` and `time-track-clients/desktop/` only · B: add a canonical twin `/api/desktop/v1/updates/...` (same handler, same `stable.json`), old path permanent · C: also move the S3 prefix to `beacon-desktop/` with double writes | **B** (versioned path per D-20261110-04, zero risk); keep the S3 prefix (A part) |
| **Q-BD-3** | Rename the GitHub repository to `beacon-desktop`? | A: now (BD-1) · B: at 1.0.0 · C: never | **B**: rename once the product is settled; redirects cover clones; update the DEVOPS runner spec the same day |
| **Q-BD-4** | Code signing | A: stay unsigned / ad-hoc · B: macOS Developer ID + notarization only · C: macOS + Windows (Authenticode or Trusted Signing) | **C** before 1.0.0, B first if budget is limited (chat notifications and Keychain prompts suffer most on macOS) |
| **Q-BD-5** **[Beacon]** | Who owns the device flow for chat tokens? | A: TimeTrackBundle device flow with host-registered scope families (one family per token) · B: a separate Beacon-only device flow for chat · C: extract device flow + client tokens into a new generic bundle | **A** now (fast, reuses the audited flow, keeps R3); C if a third family appears |
| **Q-BD-6** **[Beacon]** | One approval or two for time + chat? | A: two device flows, chained by the app · B: one approval page issuing two family-bound tokens | **A**: simpler contract, clean separate revocation |
| **Q-BD-7** **[Beacon]** | How does the desktop pass the tenant? | A: `X-Beacon-Context` header per request, checked every time · B: context bound into the token at approval (one token per context) | **A**: switching needs no new sign-in; never touches `User::organizationContext` |
| **Q-BD-8** **[Beacon]** | Do read marks need `chat:write`? | A: `chat:read` covers read marks (they only affect the reader) · B: `chat:write` | **A**: a read-only client must clear its own unread state; read receipts visibility follows existing preferences |
| **Q-BD-9** **[Beacon]** | Hide message text in notifications for strict organizations? | A: no policy, user choice only · B: organization setting "no message text in notifications" enforced server-side by the preview endpoint (also for Web Push) · C: always hide text | **B**, refined by the owner 2026-11-25: the organization setting is a maximum level, **Sender only** or **None**, enforced server-side in Web Push and the hub; users may only choose stricter |
| **Q-BD-10** | Chat search in the desktop? | A: BD-3 · B: BD-4 · C: never, "Search in Beacon" link | **B** |
| **Q-BD-11** | Attachments in the desktop before ChatKit has them? | A: neutral "Open in Beacon" card · B: wait and hide | **A** now; real download via signed URL after ChatKit's StorageKit + scan release |
| **Q-BD-12** **[Beacon]** | Does the hub accept the subscriber JWT in the `Authorization` header from a native client (no cookie, no query string)? | A: header · B: `authorization` query parameter (Mercure supports it, leaks into logs) | **A**; B only if the hub cannot, and then with log redaction |
| **Q-BD-13** **[Beacon]** | Realtime payloads on private topics | A: keep viewer-neutral presented messages; the desktop treats them as hints · B: ChatKit option for ids-only events (no bodies, no rendered references) | **B** (opt-in per profile, desktop requires nothing from the payload either way); confirms R2 by construction |
| **Q-BD-14** **[Beacon]** | Web Push and desktop notifications for the same person | A: both · B: desktop owns notifications while its realtime subscription is active; Web Push skipped · C: user chooses per device | **B** with C as a setting later |
| **Q-BD-15** | Store chat messages on disk for offline reading? | A: memory only · B: encrypted cache (key in keychain), cleared on sign-out | **A** for BD-2/BD-3; kept **A** with the offline queue (UX batch 5: queued text is memory only, gone on quit) |
| **Q-BD-16** **[Beacon]** | Message rendering format for the client API | A: server Markdown → sanitized HTML (client injects HTML) · B: structured tokens (text, mention, reference, link, code) rendered by the client as text nodes | **B**: keeps the app's text-only DOM and makes the "not visible" reference placeholder explicit |
| **Q-BD-17** | Display name | A: "Beacon Desktop" · B: "Beacon" | **A** (avoids confusion with the web app and the PWA) |
| **Q-BD-18** | The parked extension's shared code (`src/api/` is shared with it) | A: freeze the shared module, fork freely · B: keep compatibility | **A** while parked |
| **Q-BD-19** **[Beacon]** | Account page for connected apps | A: one row per device with Time and Chat badges, each revocable · B: two independent rows | **A** |

## 9. Out of scope

- Renaming the repository, changing app ids or touching releases as part of this document.
- The browser extension (parked).
- Voice / video, typing indicators, presence writes, pins (later), support inbox in the desktop.
- Any change to activity monitoring beyond what TimeTrackBundle already defines.
- Generic-host support for the app itself (the bundles' APIs stay generic).
