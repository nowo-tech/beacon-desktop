//! The app's HTTP client: every Beacon request (API calls from the UI through `beacon_fetch`, the update check and
//! the updater) uses the pinned TLS configuration of `pinning.rs`. The webview itself cannot reach the network (CSP
//! `connect-src ipc:`, no HTTP plugin), so there is no unpinned path to Beacon.
//!
//! Every request is bound to the origin (scheme, host, port) of the Beacon server the app is signed in to (or signing
//! in to): `beacon_fetch`, the update check and the updater refuse any other origin, so the Bearer token never goes
//! anywhere else (audit FY-L1). Plain `http://` is accepted for loopback development servers in debug builds only.
//!
//! The session token never crosses to the webview (secret.rs): the UI marks a request as authenticated (`auth`) and
//! Rust sets `Authorization` from the OS keychain, only for the token's own origin; an `Authorization` header from the
//! UI is dropped. A 2xx answer to a sign-in the app started has its token stored in the keychain and replaced by
//! `secret::SESSION_HANDLE`; every other JSON answer has its token fields scrubbed before the UI sees it.
//!
//! No redirects (the Bearer token stays bound to the configured server), no cookies, no request or response logging.

use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};

use crate::pinning::{self, PinSet, PinStatus, UNTRUSTED_MARKER};
use std::sync::Arc;

use crate::secret::{self, blocking, Authorization, Session};

/// Largest response body handed to the UI (exports included).
const MAX_BODY: usize = 32 * 1024 * 1024;

/// Request headers the UI may set; anything else is dropped. Never `authorization`: Rust sets it (`auth`).
/// `x-beacon-context` names the tenant of a chat request (`personal` / `org:<uuid>`, design §4.4, BD-2);
/// `idempotency-key` names one chat or task write (ChatKit 2.5, TaskBoard 3.4; BD-3b), so a retry is never written
/// twice; `if-match` carries a task's revision (TaskBoard 3.4: every change of an existing task).
const ALLOWED_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "content-type",
    "idempotency-key",
    "if-match",
    "x-beacon-context",
];

/// Which write methods a request's route takes (deny by default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Writes {
    put_delete: bool,
    patch: bool,
}

/// The method of a UI request. `GET` and `POST` go anywhere on the bound origin. The other methods only where this
/// version writes with them (deny by default, audit ZDG-L1), each with only its own family's token attached:
/// - `PUT` / `DELETE`: the chat reaction route (`…/chat/v1/conversations/{uuid}/messages/{uuid}/reactions/{emoji}`,
///   ChatKit 2.5) and a task's members (`…/task-board/v1/tasks/{id}/members/{user}`, TaskBoard 3.4);
/// - `PATCH`: a task's fields and a checklist item (`…/task-board/v1/tasks/{id}`, `…/checklist-items/{id}`).
///
/// Anything else is refused.
fn method_of(method: &str, writes: Writes) -> Result<reqwest::Method, String> {
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => return Ok(reqwest::Method::GET),
        "POST" => return Ok(reqwest::Method::POST),
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("method not allowed".into()),
    };
    let allowed = match method {
        reqwest::Method::PATCH => writes.patch,
        _ => writes.put_delete,
    };
    if allowed {
        Ok(method)
    } else {
        Err("method not allowed".into())
    }
}

/// A sign-in or "Connect chat" answer whose token was stored: its origin, the notification language and which token.
#[derive(Debug, PartialEq, Eq)]
pub struct StoredFor {
    pub origin: String,
    pub spanish: bool,
    pub family: secret::Family,
}

/// What an authenticated request gets, without touching the network, when no token is stored: the same answer as the
/// server's for a missing token, so the UI asks to sign in again.
const NOT_SIGNED_IN: &str = r#"{"error":"invalid_token","message":"Not connected."}"#;

/// A reqwest client with the given TLS configuration.
pub fn build_client(tls: rustls::ClientConfig) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("TimeTrack-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// The client of this build (Mozilla roots + shipped pins).
pub fn client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> =
        LazyLock::new(|| build_client(pinning::shipped_client_config()).expect("HTTP client"));
    &CLIENT
}

/// Plain `http://` is accepted for local development servers only, and only in debug builds (FY-L1).
pub const ALLOW_LOOPBACK_HTTP: bool = cfg!(debug_assertions);

/// The one Beacon server of release builds (owner decision 2026-11-27): Beacon Desktop always uses it, pinned.
pub const OFFICIAL_SERVER: &str = "https://beacon.nowo.tech";

/// Release builds bind no other server (defence in depth behind the UI, which has no address field there); debug
/// builds (`tauri dev`, `cargo test`, the mock server) may bind another one.
pub const FIXED_SERVER: bool = !cfg!(debug_assertions);

/// Refusal text when a release build is asked for another server than [`OFFICIAL_SERVER`].
pub const NOT_THE_OFFICIAL_SERVER: &str =
    "beacon_server_fixed: Beacon Desktop only connects to https://beacon.nowo.tech";

/// `url` has the official server's origin (scheme, host and port: `https://beacon.nowo.tech:8443` does not).
pub fn is_official(url: &url::Url) -> bool {
    url::Url::parse(OFFICIAL_SERVER).is_ok_and(|official| official.origin() == url.origin())
}

/// The server a sign-in or a binding may use: [`validate_url`], and in release builds only [`OFFICIAL_SERVER`].
pub fn validate_server_url(value: &str) -> Result<url::Url, String> {
    validate_server_url_with(value, ALLOW_LOOPBACK_HTTP, FIXED_SERVER)
}

/// [`validate_server_url`] with both build rules explicit (tests check the release rule in debug builds).
pub fn validate_server_url_with(
    value: &str,
    allow_loopback_http: bool,
    fixed: bool,
) -> Result<url::Url, String> {
    let url = validate_url_with(value, allow_loopback_http)?;
    if fixed && !is_official(&url) {
        return Err(NOT_THE_OFFICIAL_SERVER.into());
    }
    Ok(url)
}

/// The loopback names a development server may use over plain http: the same set as the UI's server field
/// (`localhost`, `127.0.0.1`, `[::1]`).
pub fn is_dev_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// The server URL rule of the app: https, or (debug builds only) http on loopback; no userinfo.
pub fn validate_url(value: &str) -> Result<url::Url, String> {
    validate_url_with(value, ALLOW_LOOPBACK_HTTP)
}

/// [`validate_url`] with the http-on-loopback switch explicit (tests check the release rule in debug builds).
pub fn validate_url_with(value: &str, allow_loopback_http: bool) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "invalid URL".to_string())?;
    let host = url.host_str().ok_or("invalid URL")?;
    let scheme_ok = url.scheme() == "https"
        || (allow_loopback_http && url.scheme() == "http" && is_dev_loopback(host));
    if !scheme_ok || !url.username().is_empty() || url.password().is_some() {
        return Err("invalid URL".into());
    }
    Ok(url)
}

/// Refusal text when a request targets another origin than the bound server.
pub const OTHER_ORIGIN: &str = "request outside the signed-in Beacon server";

/// `url` must have exactly the bound origin (scheme, host, port); nothing is sent before a server is bound.
pub fn require_origin(bound: Option<&url::Origin>, url: &url::Url) -> Result<(), String> {
    match bound {
        Some(origin) if *origin == url.origin() => Ok(()),
        Some(_) => Err(OTHER_ORIGIN.into()),
        None => Err("no Beacon server bound: sign in first".into()),
    }
}

/// A reqwest error as text for the UI: the pin mismatch keeps its marker, the URL is never included.
pub fn describe_error(error: reqwest::Error) -> String {
    error_text(&error.without_url())
}

/// Removes the query string (and fragment) of every URL in `text`: the updater's errors can carry the pre-signed
/// object-storage URL of the artifact, whose query holds the signature (FY-I2). "Copy details" never gets it.
pub fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| rest.find(scheme))
        .min()
    {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '>' | ','))
            .unwrap_or(tail.len());
        let url = &tail[..end];
        match url.find(['?', '#']) {
            Some(cut) => {
                out.push_str(&url[..cut]);
                out.push_str("?[redacted]");
            }
            None => out.push_str(url),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// An error and its causes as one line; a pin mismatch is reduced to its marker, host and pin set version.
pub fn error_text(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    let text = redact_urls(&text);
    // "…: invalid peer certificate: Other(OtherError(beacon_untrusted_certificate: … (pin set v1)))" → the
    // PinMismatch text only.
    let Some(start) = text.find(UNTRUSTED_MARKER) else {
        return text;
    };
    let rest = &text[start..];
    let end = rest
        .find("(pin set v")
        .and_then(|at| rest[at..].find(')').map(|close| at + close + 1))
        .unwrap_or(rest.len());
    rest[..end].to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    /// Send the stored session token (Rust reads it from the keychain; the UI never has it).
    #[serde(default)]
    pub auth: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// Base64 of the body (exports can be binary).
    pub body: String,
}

/// Sends one request with `client`, only to the origin bound in `session` (so the `Authorization` header never
/// reaches another origin). With `request.auth`, the token comes from `session`, and only for its own origin; a
/// sign-in answer is captured there (secret.rs) and every JSON answer is scrubbed of token fields. Errors are strings
/// for the UI (see [`describe_error`]) and never carry the token.
#[cfg(test)]
pub async fn send(
    client: &reqwest::Client,
    request: FetchRequest,
    session: &Arc<Session>,
) -> Result<FetchResponse, String> {
    Ok(send_and_capture(client, request, session).await?.0)
}

/// [`send`], plus the origin (and notification language) of a sign-in or chat connection it stored.
pub async fn send_and_capture(
    client: &reqwest::Client,
    request: FetchRequest,
    session: &Arc<Session>,
) -> Result<(FetchResponse, Option<StoredFor>), String> {
    let url = validate_url(&request.url)?;
    require_origin(session.bound_origin().as_ref(), &url)?;
    // `/api/time-track/%6Cogin` would reach the sign-in route unrecognised (GM-L1).
    if secret::obfuscated_path(&url) {
        return Err("invalid URL".into());
    }
    let writes = match session.route(&url)? {
        secret::Route::Chat => Writes {
            put_delete: session.is_reaction_route(&url)?,
            patch: false,
        },
        secret::Route::Tasks => {
            let (put_delete, patch) = session.task_write_route(&url)?;
            Writes { put_delete, patch }
        }
        _ => Writes::default(),
    };
    let method = method_of(&request.method, writes)?;
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let name = name.to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(value).map_err(|_| "invalid header value")?;
        headers.insert(name, value);
    }
    if request.auth {
        // Keychain work runs off the async workers (GM-D-4).
        let (owner, target) = (Arc::clone(session), url.clone());
        match blocking(move || owner.authorization_for(&target)).await? {
            Authorization::Bearer(value) => {
                headers.insert(AUTHORIZATION, value);
            }
            Authorization::None => return Ok((not_signed_in(), None)),
        }
    }
    let sign_in = secret::is_sign_in(&method, &url);
    let target = url.clone();
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(describe_error)?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        // Only the headers the UI reads: nothing else (a cookie, a token header) reaches the webview (GM-D-3).
        .filter(|(name, _)| secret::RESPONSE_HEADERS.contains(&name.as_str()))
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(describe_error)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let (body, stored_for) = if sign_in && status.is_success() {
        let owner = Arc::clone(session);
        let captured = blocking(move || owner.capture(&target, &body)).await?;
        let stored = captured
            .stored_for
            .map(|(origin, spanish)| StoredFor {
                origin,
                spanish,
                family: secret::Family::Time,
            })
            .or(captured.chat_stored_for.map(|(origin, spanish)| StoredFor {
                origin,
                spanish,
                family: secret::Family::Chat,
            }))
            .or(captured
                .tasks_stored_for
                .map(|(origin, spanish)| StoredFor {
                    origin,
                    spanish,
                    family: secret::Family::Tasks,
                }));
        (captured.body, stored)
    } else {
        (secret::scrub(body), None)
    };
    Ok((
        FetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or_default().to_string(),
            headers,
            body: base64::engine::general_purpose::STANDARD.encode(body),
        },
        stored_for,
    ))
}

fn not_signed_in() -> FetchResponse {
    FetchResponse {
        status: 401,
        status_text: "Unauthorized".into(),
        headers: vec![("content-type".into(), "application/json".into())],
        body: base64::engine::general_purpose::STANDARD.encode(NOT_SIGNED_IN),
    }
}

/// Every Beacon API call of the UI (src/lib/nativeFetch.ts): pinned TLS, no redirects, bound server origin only, main
/// window only.
#[tauri::command]
pub async fn beacon_fetch(
    window: tauri::Window,
    app: tauri::AppHandle,
    session: tauri::State<'_, Arc<Session>>,
    request: FetchRequest,
) -> Result<FetchResponse, String> {
    crate::only_from(&window, "main")?;
    let (response, stored_for) = send_and_capture(client(), request, &session).await?;
    // Every stored sign-in is announced by the OS, from Rust (GM-D-1).
    match stored_for {
        Some(StoredFor {
            origin,
            spanish,
            family: secret::Family::Chat,
        }) => secret::notify_chat_connected(&app, &origin, spanish),
        Some(StoredFor {
            origin,
            spanish,
            family: secret::Family::Tasks,
        }) => secret::notify_tasks_connected(&app, &origin, spanish),
        Some(StoredFor {
            origin, spanish, ..
        }) => secret::notify_signed_in(&app, &origin, spanish),
        None => {}
    }
    Ok(response)
}

/// Binds the Beacon server the UI is signed in to (at start-up). While a token is stored, only the origin that issued
/// it can be bound (secret.rs, GM-M1); a sign-in binds with `sign_in_begin`.
#[tauri::command]
pub async fn beacon_bind(
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
    server: String,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    let url = validate_server_url(&server)?;
    let session = Arc::clone(&session);
    blocking(move || session.bind(&url)).await
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSecurity {
    pub status: PinStatus,
    pub pin_set_version: u32,
}

pub fn connection_security_of(
    pins: &PinSet,
    server: &str,
    now: u64,
) -> Result<ConnectionSecurity, String> {
    let url = validate_url(server)?;
    let host = url.host_str().unwrap_or_default();
    Ok(ConnectionSecurity {
        status: pins.status(host, now),
        pin_set_version: pins.version,
    })
}

/// How the connection to `server` is protected (Settings: pinned / not pinned / pin set expired / local).
#[tauri::command]
pub fn connection_security(
    window: tauri::Window,
    server: String,
) -> Result<ConnectionSecurity, String> {
    crate::only_from(&window, "main")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    connection_security_of(&PinSet::shipped(), &server, now)
}

#[cfg(test)]
mod tests {
    //! End to end: a local TLS mock server with a CA made at test time, reached through the real client.
    use super::*;
    use crate::pinning::tests::{pin_set, TestCa};
    use crate::secret::tests::{begin, session, MemoryStore};
    use crate::secret::SESSION_HANDLE;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::RootCertStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    const HOST: &str = "beacon.pinning.test";

    /// Serves `connections` HTTPS requests on 127.0.0.1 with `chain`; answers 200 `{"ok":true}` and records the
    /// request head (to check what reached the server).
    fn mock_server(
        chain: Vec<rustls::pki_types::CertificateDer<'static>>,
        key: &rcgen::KeyPair,
        connections: usize,
    ) -> (u16, std::sync::mpsc::Receiver<String>) {
        mock_server_with(chain, key, connections, r#"{"ok":true}"#)
    }

    /// [`mock_server`] answering 200 with `body`.
    fn mock_server_with(
        chain: Vec<rustls::pki_types::CertificateDer<'static>>,
        key: &rcgen::KeyPair,
        connections: usize,
        body: &'static str,
    ) -> (u16, std::sync::mpsc::Receiver<String>) {
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
        let config = Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let Ok(mut tcp) = stream else { continue };
                let mut conn = rustls::ServerConnection::new(config.clone()).unwrap();
                let mut tls = rustls::Stream::new(&mut conn, &mut tcp);
                let mut buffer = [0u8; 4096];
                let Ok(read) = tls.read(&mut buffer) else {
                    continue;
                };
                let _ = seen.send(String::from_utf8_lossy(&buffer[..read]).to_string());
                let _ = write!(
                    tls,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Min-Supported-Version: 0.1.0\r\nSet-Cookie: s=fresh-token\r\nX-Auth-Token: fresh-token\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.flush();
            }
        });
        (port, received)
    }

    /// A client whose resolver sends HOST to the mock server.
    fn client_for(roots: Arc<RootCertStore>, pins: Arc<PinSet>, port: u16) -> reqwest::Client {
        let tls = pinning::client_config(roots, pins).unwrap();
        reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve(HOST, std::net::SocketAddr::from(([127, 0, 0, 1], port)))
            .build()
            .unwrap()
    }

    /// The origin of the mock server.
    fn origin_of(port: u16) -> String {
        format!("https://{HOST}:{port}")
    }

    /// Signed in to `origin` (token `secret-token`, as Rust keeps it) and bound to it (`beacon_bind`).
    fn signed_in_to(origin: &str) -> Arc<Session> {
        let session = session(&MemoryStore::with(origin, "secret-token"));
        session.bind(&url::Url::parse(origin).unwrap()).unwrap();
        session
    }

    fn signed_in(port: u16) -> Arc<Session> {
        signed_in_to(&origin_of(port))
    }

    fn decode(body: String) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap()
    }

    /// An authenticated request; the UI's own `Authorization` (anything a script could set) is dropped.
    fn request(port: u16) -> FetchRequest {
        FetchRequest {
            url: format!("https://{HOST}:{port}/api/time-track/me"),
            method: "GET".into(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Authorization".into(), "Bearer from-the-webview".into()),
                ("Cookie".into(), "dropped=1".into()),
            ],
            body: None,
            auth: true,
        }
    }

    #[tokio::test]
    async fn pinned_server_answers() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, seen) = mock_server(vec![leaf], &key, 1);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let response = send(&client, request(port), &signed_in(port))
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.status_text, "OK");
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name == "x-min-supported-version" && value == "0.1.0"));
        // Only the headers the UI reads (GM-D-3): no cookie, no token header.
        let names: Vec<&str> = response
            .headers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert!(
            names
                .iter()
                .all(|name| secret::RESPONSE_HEADERS.contains(name)),
            "{names:?}"
        );
        assert!(!names.contains(&"set-cookie") && !names.contains(&"x-auth-token"));
        let body = base64::engine::general_purpose::STANDARD
            .decode(response.body)
            .unwrap();
        assert_eq!(body, br#"{"ok":true}"#);
        let head = seen.recv().unwrap().to_ascii_lowercase();
        assert!(head.contains("authorization: bearer secret-token"));
        assert!(
            !head.contains("from-the-webview"),
            "the UI's Authorization is dropped"
        );
        assert_eq!(head.matches("authorization").count(), 1);
        assert!(
            !head.contains("cookie"),
            "only allow-listed headers are sent"
        );
    }

    #[tokio::test]
    async fn pin_mismatch_fails_closed_before_any_request() {
        // The server's CA is trusted (as a rogue CA or an inspecting proxy would be) but not pinned.
        let official = TestCa::new("Official Root");
        let rogue = TestCa::new("Rogue Root");
        let (leaf, key) = rogue.leaf(HOST);
        let (port, seen) = mock_server(vec![leaf], &key, 1);
        let mut roots = RootCertStore::empty();
        roots.add(official.der()).unwrap();
        roots.add(rogue.der()).unwrap();
        let client = client_for(
            Arc::new(roots),
            pin_set(&[HOST], &[&official.spki_pin], "2999-01-01"),
            port,
        );
        let error = send(&client, request(port), &signed_in(port))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            format!("{UNTRUSTED_MARKER}: unexpected certificate for {HOST} (pin set v9)")
        );
        assert!(!error.contains("secret-token"));
        assert!(!error.contains("/api/time-track"), "no URL in the error");
        // Nothing (no token) reached the server.
        assert!(seen
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err());
    }

    #[tokio::test]
    async fn pinned_intermediate_chain_answers() {
        let root = TestCa::new("E2E Root");
        let int = root.intermediate("E2E Intermediate");
        let (leaf, key) = int.leaf(HOST);
        let (port, _) = mock_server(vec![leaf, int.der()], &key, 1);
        let client = client_for(
            root.roots(),
            pin_set(&[HOST], &[&root.spki_pin], "2999-01-01"),
            port,
        );
        assert_eq!(
            send(&client, request(port), &signed_in(port))
                .await
                .unwrap()
                .status,
            200
        );
    }

    #[tokio::test]
    async fn unpinned_host_needs_webpki_only() {
        let official = TestCa::new("Official Root");
        let other = TestCa::new("Self-hosted Root");
        let (leaf, key) = other.leaf(HOST);
        let (port, _) = mock_server(vec![leaf], &key, 1);
        let client = client_for(
            other.roots(),
            pin_set(
                &["beacon.elsewhere.example"],
                &[&official.spki_pin],
                "2999-01-01",
            ),
            port,
        );
        assert_eq!(
            send(&client, request(port), &signed_in(port))
                .await
                .unwrap()
                .status,
            200
        );
    }

    #[tokio::test]
    async fn untrusted_ca_is_a_plain_tls_error() {
        let trusted = TestCa::new("Trusted Root");
        let untrusted = TestCa::new("Untrusted Root");
        let (leaf, key) = untrusted.leaf(HOST);
        let (port, _) = mock_server(vec![leaf], &key, 1);
        let client = client_for(
            trusted.roots(),
            pin_set(&[HOST], &[&trusted.spki_pin], "2999-01-01"),
            port,
        );
        let error = send(&client, request(port), &signed_in(port))
            .await
            .unwrap_err();
        assert!(!error.contains(UNTRUSTED_MARKER), "{error}");
        assert!(error.to_lowercase().contains("certificate"), "{error}");
    }

    #[tokio::test]
    async fn requests_are_validated_before_sending() {
        let client = build_client(pinning::shipped_client_config()).unwrap();
        let example = signed_in_to("https://beacon.example.com");
        for (url, method) in [
            ("http://beacon.example.com/api", "GET"),
            ("https://user:pw@beacon.example.com/api", "GET"),
            ("not a url", "GET"),
            ("https://beacon.example.com/api", "DELETE"),
        ] {
            let request = FetchRequest {
                url: url.into(),
                method: method.into(),
                headers: vec![],
                body: None,
                auth: true,
            };
            assert!(
                send(&client, request, &example).await.is_err(),
                "{url} {method}"
            );
        }
        let bad_header = FetchRequest {
            url: "https://beacon.example.com/api".into(),
            method: "POST".into(),
            headers: vec![("Accept".into(), "application/json\n".into())],
            body: Some("{}".into()),
            auth: false,
        };
        assert!(send(&client, bad_header, &example).await.is_err());
    }

    const PUT_DELETE: Writes = Writes {
        put_delete: true,
        patch: false,
    };
    const PATCH: Writes = Writes {
        put_delete: false,
        patch: true,
    };

    #[test]
    fn write_methods_reach_only_the_routes_that_take_them() {
        for method in ["GET", "get", "POST"] {
            for writes in [Writes::default(), PUT_DELETE, PATCH] {
                assert!(method_of(method, writes).is_ok(), "{method} {writes:?}");
            }
        }
        for method in ["PUT", "delete"] {
            assert!(method_of(method, PUT_DELETE).is_ok(), "{method}");
            assert!(method_of(method, PATCH).is_err(), "{method}");
            assert!(method_of(method, Writes::default()).is_err(), "{method}");
        }
        // PATCH only where a task route takes it (no message edits, audit ZDG-L1).
        assert!(method_of("PATCH", PATCH).is_ok());
        assert!(method_of("PATCH", PUT_DELETE).is_err());
        for method in ["OPTIONS", "HEAD", "TRACE", "CONNECT", ""] {
            let all = Writes {
                put_delete: true,
                patch: true,
            };
            assert!(method_of(method, all).is_err(), "{method}");
        }
        // Task routes: PATCH on a task and a checklist item, PUT / DELETE on a member, nothing else.
        let task = |path: &str| {
            secret::task_write_methods(
                &url::Url::parse(&format!(
                    "https://beacon.example.com/api/task-board/v1/{path}"
                ))
                .unwrap(),
                "",
            )
        };
        assert_eq!(task("tasks/t1"), (false, true));
        assert_eq!(task("tasks/t1/checklist-items/i1"), (false, true));
        assert_eq!(task("tasks/t1/members/me"), (true, false));
        for path in [
            "tasks",
            "tasks/t1/move",
            "boards/b1",
            "tasks/t1/members",
            "tasks/t1/members/a/b",
            "tasks/../x",
            "tasks/-x",
            "me",
        ] {
            assert_eq!(task(path), (false, false), "{path}");
        }
        assert_eq!(
            secret::task_write_methods(
                &url::Url::parse("https://beacon.example.com/x/api/task-board/v1/tasks/t1")
                    .unwrap(),
                ""
            ),
            (false, false)
        );
        const C: &str = "0c000000-0000-4000-8000-000000000001";
        const M: &str = "0c000000-0000-4000-8000-00000000000a";
        let url =
            |path: &str| url::Url::parse(&format!("https://beacon.example.com{path}")).unwrap();
        let reaction =
            format!("/api/chat/v1/conversations/{C}/messages/{M}/reactions/%F0%9F%91%8D");
        assert!(secret::is_reaction_path(&url(&reaction), ""));
        assert!(secret::is_reaction_path(
            &url(&format!("/beacon{reaction}")),
            "/beacon"
        ));
        for path in [
            format!("/api/chat/v1/conversations/{C}/messages/{M}"),
            format!("/api/chat/v1/conversations/{C}/messages/{M}/reactions/"),
            format!("/api/chat/v1/conversations/{C}/messages/{M}/reactions/a/b"),
            format!("/api/chat/v1/conversations/{C}/messages/{M}/thread"),
            format!("/api/chat/v1/conversations/{C}/mute"),
            format!("/api/chat/v1/conversations/x/messages/{M}/reactions/a"),
            format!("/api/chat/v1/conversations/{C}/messages/not-a-uuid/reactions/a"),
            format!("/other/api/chat/v1/conversations/{C}/messages/{M}/reactions/a"),
            "/api/time-track/timer/1".to_string(),
        ] {
            assert!(!secret::is_reaction_path(&url(&path), ""), "{path}");
        }
        // `..` as the emoji: the URL parser resolves it to the message route, which is not the reaction route.
        assert!(!secret::is_reaction_path(
            &url(&format!(
                "/api/chat/v1/conversations/{C}/messages/{M}/reactions/.."
            )),
            ""
        ));
    }

    #[tokio::test]
    async fn chat_writes_carry_the_chat_token_and_the_idempotency_key() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, seen) =
            mock_server_with(vec![leaf], &key, 1, r#"{"reactions":[],"replayed":false}"#);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let origin = origin_of(port);
        let session = Arc::new(
            Session::with_timing(
                Box::new(MemoryStore::with(&origin, "secret-token")),
                secret::SIGN_IN_WINDOW,
                std::time::Duration::ZERO,
            )
            .with_chat_store(Box::new(MemoryStore::with(&origin, "chat-secret"))),
        );
        session.bind(&url::Url::parse(&origin).unwrap()).unwrap();
        let path = "/api/chat/v1/conversations/0c000000-0000-4000-8000-000000000001/messages/0c000000-0000-4000-8000-000000000002/reactions/%F0%9F%91%8D";
        let write = FetchRequest {
            url: format!("{origin}{path}"),
            method: "PUT".into(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Idempotency-Key".into(), "k-1".into()),
                ("X-Beacon-Context".into(), "personal".into()),
            ],
            body: None,
            auth: true,
        };
        let response = send(&client, write, &session).await.unwrap();
        assert_eq!(response.status, 200);
        let head = seen.recv().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("put /api/chat/v1/"), "{head}");
        assert!(head.contains("idempotency-key: k-1"), "{head}");
        assert!(head.contains("authorization: bearer chat-secret"), "{head}");
        assert!(!head.contains("secret-token"), "{head}");
        // The time API never takes a write method, whatever the UI asks.
        let time = FetchRequest {
            url: format!("{origin}/api/time-track/timer/1"),
            method: "DELETE".into(),
            headers: vec![],
            body: None,
            auth: true,
        };
        assert_eq!(
            send(&client, time, &session).await.unwrap_err(),
            "method not allowed"
        );
        // Nor any other chat route: deleting or editing a message is not a write of this version (ZDG-L1).
        let message = "/api/chat/v1/conversations/0c000000-0000-4000-8000-000000000001/messages/0c000000-0000-4000-8000-000000000002";
        for (method, target) in [("DELETE", message), ("PATCH", message), ("PATCH", path)] {
            let request = FetchRequest {
                url: format!("{origin}{target}"),
                method: method.into(),
                headers: vec![],
                body: None,
                auth: true,
            };
            assert_eq!(
                send(&client, request, &session).await.unwrap_err(),
                "method not allowed",
                "{method} {target}"
            );
        }
    }

    #[tokio::test]
    async fn other_origins_are_refused_and_never_get_the_token() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        // Up to three connections, none expected.
        let (port, seen) = mock_server(vec![leaf], &key, 3);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        // Signed in to (and bound to) another host, the same host on another port, http of the same host; or
        // nothing bound.
        for other in [
            "https://beacon.elsewhere.example".to_string(),
            format!("https://{HOST}:{}", port.wrapping_add(1)),
            format!("http://{HOST}:{port}"),
        ] {
            let error = send(&client, request(port), &signed_in_to(&other))
                .await
                .unwrap_err();
            assert_eq!(error, OTHER_ORIGIN, "{other}");
        }
        let nothing = session(&MemoryStore::with(&origin_of(port), "secret-token"));
        let error = send(&client, request(port), &nothing).await.unwrap_err();
        assert!(error.contains("sign in"), "{error}");
        // Nothing (no Authorization header) reached the server.
        assert!(seen
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err());
    }

    #[tokio::test]
    async fn without_a_stored_token_nothing_is_sent_and_the_ui_gets_401() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, seen) = mock_server(vec![leaf], &key, 1);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let signed_out = session(&MemoryStore::default());
        signed_out
            .bind(&url::Url::parse(&origin_of(port)).unwrap())
            .unwrap();
        let response = send(&client, request(port), &signed_out).await.unwrap();
        assert_eq!(response.status, 401);
        let body = decode(response.body);
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "invalid_token");
        assert!(seen
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err());
    }

    #[tokio::test]
    async fn unauthenticated_requests_carry_no_token() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, seen) = mock_server(vec![leaf], &key, 1);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let request = FetchRequest {
            auth: false,
            ..request(port)
        };
        let response = send(&client, request, &signed_in(port)).await.unwrap();
        assert_eq!(response.status, 200);
        let head = seen.recv().unwrap().to_ascii_lowercase();
        assert!(!head.contains("authorization"), "{head}");
    }

    /// POST to a sign-in route of the mock server.
    fn sign_in_request(port: u16, path: &str) -> FetchRequest {
        FetchRequest {
            url: format!("https://{HOST}:{port}{path}"),
            method: "POST".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(r#"{"deviceCode":"d"}"#.into()),
            auth: false,
        }
    }

    const SIGN_IN_ANSWER: &str =
        r#"{"token":"fresh-token","expiresAt":"2027-01-01T00:00:00Z","scopes":["timer:read"]}"#;

    #[tokio::test]
    async fn a_started_sign_in_keeps_the_token_in_rust_bound_to_its_origin() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, seen) = mock_server_with(vec![leaf], &key, 2, SIGN_IN_ANSWER);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let keychain = MemoryStore::default();
        let session = session(&keychain);
        begin(&session, &origin_of(port)).unwrap();
        let response = send(
            &client,
            sign_in_request(port, "/api/time-track/device/token"),
            &session,
        )
        .await
        .unwrap();
        let stored = keychain.stored().unwrap();
        assert_eq!(stored.token, "fresh-token");
        assert_eq!(stored.origin.as_deref(), Some(origin_of(port).as_str()));
        let body = decode(response.body);
        assert!(!String::from_utf8_lossy(&body).contains("fresh-token"));
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["token"], SESSION_HANDLE);
        assert_eq!(json["scopes"][0], "timer:read");
        // The next authenticated call carries the captured token.
        let _ = seen.recv().unwrap();
        send(&client, request(port), &session).await.unwrap();
        let head = seen.recv().unwrap().to_ascii_lowercase();
        assert!(head.contains("authorization: bearer fresh-token"), "{head}");
    }

    // GM-L2, end to end: a sign-in answer the app did not start is never stored, and never shown.
    #[tokio::test]
    async fn an_unstarted_sign_in_is_neither_stored_nor_shown() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, _) = mock_server_with(vec![leaf], &key, 1, SIGN_IN_ANSWER);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        // Signed in already (a script tries to swap in its own account).
        let keychain = MemoryStore::with(&origin_of(port), "secret-token");
        let session = session(&keychain);
        session
            .bind(&url::Url::parse(&origin_of(port)).unwrap())
            .unwrap();
        let response = send(
            &client,
            sign_in_request(port, "/api/time-track/login"),
            &session,
        )
        .await
        .unwrap();
        assert_eq!(keychain.stored().unwrap().token, "secret-token");
        let body = String::from_utf8(decode(response.body)).unwrap();
        assert!(!body.contains("fresh-token"), "{body}");
    }

    // GM-D-1: the app is device-flow only; a password sign-in answer is never stored, even during a sign-in.
    #[tokio::test]
    async fn the_password_route_is_never_captured() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, _) = mock_server_with(vec![leaf], &key, 1, SIGN_IN_ANSWER);
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let keychain = MemoryStore::default();
        let session = session(&keychain);
        begin(&session, &origin_of(port)).unwrap();
        let (response, stored_for) = send_and_capture(
            &client,
            sign_in_request(port, "/api/time-track/login"),
            &session,
        )
        .await
        .unwrap();
        assert!(stored_for.is_none());
        assert_eq!(keychain.stored(), None);
        let body = String::from_utf8(decode(response.body)).unwrap();
        assert!(!body.contains("fresh-token"), "{body}");
    }

    // GM-L1 / GM-I1, end to end.
    #[tokio::test]
    async fn encoded_sign_in_paths_are_refused_and_every_answer_is_scrubbed() {
        let ca = TestCa::new("E2E Root");
        let (leaf, key) = ca.leaf(HOST);
        let (port, seen) = mock_server_with(
            vec![leaf],
            &key,
            1,
            r#"{"identifier":"ana","data":{"access_token":"fresh-token"},"token":"fresh-token"}"#,
        );
        let client = client_for(
            ca.roots(),
            pin_set(&[HOST], &[&ca.spki_pin], "2999-01-01"),
            port,
        );
        let session = session(&MemoryStore::default());
        begin(&session, &origin_of(port)).unwrap();
        for path in [
            "/api/time-track/%6Cogin",
            "/api/time-track/device/to%6Ben",
            "/api/time-track/device%2Ftoken",
        ] {
            let error = send(&client, sign_in_request(port, path), &session)
                .await
                .unwrap_err();
            assert_eq!(error, "invalid URL", "{path}");
        }
        assert!(seen
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
        // Any other answer with token fields: scrubbed, whatever the route.
        let response = send(
            &client,
            FetchRequest {
                auth: false,
                ..request(port)
            },
            &session,
        )
        .await
        .unwrap();
        let body = String::from_utf8(decode(response.body)).unwrap();
        assert!(!body.contains("fresh-token"), "{body}");
        assert!(body.contains("ana"), "{body}");
    }

    #[tokio::test]
    async fn error_paths_never_echo_the_token() {
        let client = build_client(pinning::shipped_client_config()).unwrap();
        // Connection refused (nothing listens on the port): the transport error.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let url = format!("http://127.0.0.1:{port}/api/time-track/me");
        let request = |url: &str| FetchRequest {
            url: url.into(),
            method: "GET".into(),
            headers: vec![],
            body: None,
            auth: true,
        };
        let mut errors = vec![];
        if ALLOW_LOOPBACK_HTTP {
            let loopback = format!("http://127.0.0.1:{port}");
            errors.push(
                send(&client, request(&url), &signed_in_to(&loopback))
                    .await
                    .unwrap_err(),
            );
        }
        // A stored token that is not a valid header value, another origin, no origin.
        let example = "https://beacon.example.com";
        let bad = session(&MemoryStore::with(example, "secret-token\nX-Injected: 1"));
        bad.bind(&url::Url::parse(example).unwrap()).unwrap();
        let unbound = session(&MemoryStore::with(example, "secret-token"));
        for session in [
            &bad,
            &signed_in_to("https://beacon.other.example"),
            &unbound,
        ] {
            errors.push(
                send(
                    &client,
                    request(&format!("{example}/api/time-track/me")),
                    session,
                )
                .await
                .unwrap_err(),
            );
        }
        for error in &errors {
            assert!(!error.contains("secret-token"), "{error}");
            assert!(!error.to_ascii_lowercase().contains("bearer"), "{error}");
        }
    }

    #[test]
    fn origin_binding_rules() {
        let a = url::Url::parse("https://beacon.a.example/").unwrap();
        let a_path = url::Url::parse("https://beacon.a.example:443/api/time-track/me").unwrap();
        let b = url::Url::parse("https://beacon.b.example/").unwrap();
        assert!(require_origin(None, &a).is_err());
        assert!(require_origin(Some(&a.origin()), &a_path).is_ok());
        assert_eq!(
            require_origin(Some(&a.origin()), &b),
            Err(OTHER_ORIGIN.to_string())
        );
        // Binding rules with a stored token: secret.rs tests (GM-M1).
    }

    #[test]
    fn error_text_redacts_presigned_urls() {
        let text = "error sending request for url (https://s3.example.com/time-track-clients/desktop/0.5.1/app.AppImage.tar.gz?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=deadbeef): connection reset";
        let redacted = redact_urls(text);
        assert_eq!(
            redacted,
            "error sending request for url (https://s3.example.com/time-track-clients/desktop/0.5.1/app.AppImage.tar.gz?[redacted]): connection reset"
        );
        assert!(!redacted.contains("X-Amz"));
        assert_eq!(redact_urls("no url here"), "no url here");
        assert_eq!(
            redact_urls("http://localhost:8000/a#frag and https://b.example/c"),
            "http://localhost:8000/a?[redacted] and https://b.example/c"
        );
        #[derive(Debug)]
        struct Failed;
        impl std::fmt::Display for Failed {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(
                    f,
                    "download failed: https://s3.example.com/x?X-Amz-Signature=abc"
                )
            }
        }
        impl std::error::Error for Failed {}
        assert_eq!(
            error_text(&Failed),
            "download failed: https://s3.example.com/x?[redacted]"
        );
    }

    #[test]
    fn error_text_keeps_causes_and_reduces_a_pin_mismatch() {
        #[derive(Debug)]
        struct Outer(Inner);
        #[derive(Debug)]
        struct Inner(&'static str);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "error sending request")
            }
        }
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
        impl std::error::Error for Inner {}
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        assert_eq!(
            error_text(&Outer(Inner("connection refused"))),
            "error sending request: connection refused"
        );
        assert_eq!(
            error_text(&Outer(Inner("invalid peer certificate: Other(OtherError(beacon_untrusted_certificate: unexpected certificate for a.example (pin set v2)))"))),
            "beacon_untrusted_certificate: unexpected certificate for a.example (pin set v2)"
        );
        assert_eq!(
            error_text(&Inner("beacon_untrusted_certificate")),
            "beacon_untrusted_certificate"
        );
    }

    #[test]
    fn loopback_http_only_in_debug_builds() {
        // Debug rule (`cargo test` and `tauri dev`).
        assert!(validate_url_with("http://localhost:8000", true).is_ok());
        assert!(validate_url_with("http://127.0.0.1:8000", true).is_ok());
        assert!(validate_url_with("http://[::1]:8000", true).is_ok());
        // Aligned with the UI: no `*.localhost`, no other 127/8 address.
        assert!(validate_url_with("http://app.localhost:8000", true).is_err());
        assert!(validate_url_with("http://127.0.0.2:8000", true).is_err());
        assert!(validate_url_with("http://beacon.example.com", true).is_err());
        // Release rule: https only.
        for url in [
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://[::1]:8000",
        ] {
            assert!(validate_url_with(url, false).is_err(), "{url}");
        }
        assert!(validate_url_with("https://localhost:8443", false).is_ok());
        assert!(validate_url_with("https://beacon.example.com", false).is_ok());
        assert_eq!(
            validate_url("http://localhost:8000").is_ok(),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn release_builds_bind_the_official_server_only() {
        // Release rule (owner decision 2026-11-27): https://beacon.nowo.tech and nothing else.
        assert!(validate_server_url_with("https://beacon.nowo.tech", false, true).is_ok());
        assert!(validate_server_url_with("https://BEACON.nowo.tech/", false, true).is_ok());
        for url in [
            "https://beacon.nowo.tech:8443",
            "https://beacon.nowo.tech.example",
            "https://evil.beacon.nowo.tech",
            "https://beacon.example.com",
            "http://beacon.nowo.tech",
            "http://localhost:8787",
        ] {
            assert_eq!(
                validate_server_url_with(url, false, true).err().as_deref(),
                if url.starts_with("http://") {
                    Some("invalid URL")
                } else {
                    Some(NOT_THE_OFFICIAL_SERVER)
                },
                "{url}"
            );
        }
        // Debug rule: an override host (the mock, a staging server) still binds.
        assert!(validate_server_url_with("http://127.0.0.1:8787", true, false).is_ok());
        assert!(validate_server_url_with("https://beacon.example.com", true, false).is_ok());
        assert_eq!(FIXED_SERVER, !cfg!(debug_assertions));
        assert_eq!(
            validate_server_url("https://beacon.example.com").is_ok(),
            cfg!(debug_assertions)
        );
        assert!(validate_server_url(OFFICIAL_SERVER).is_ok());
    }

    #[test]
    fn connection_security_per_server() {
        let pins = pin_set(&["beacon.nowo.test"], &[], "2999-01-01");
        let now = 1_800_000_000;
        let status = |server: &str| connection_security_of(&pins, server, now).unwrap().status;
        assert_eq!(status("https://beacon.nowo.test"), PinStatus::Pinned);
        assert_eq!(
            status("https://beacon.self-hosted.example"),
            PinStatus::Unpinned
        );
        assert_eq!(status("http://localhost:8000"), PinStatus::Local);
        assert!(connection_security_of(&pins, "ftp://x", now).is_err());
        let shipped =
            connection_security_of(&PinSet::shipped(), "https://beacon.nowo.tech", now).unwrap();
        assert_eq!(shipped.status, PinStatus::Pinned);
        assert_eq!(
            serde_json::to_value(&shipped).unwrap(),
            serde_json::json!({"status": "pinned", "pinSetVersion": PinSet::shipped().version})
        );
    }
}
