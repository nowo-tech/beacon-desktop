//! The app's HTTP client: every Beacon request (API calls from the UI through `beacon_fetch`, the update check and
//! the updater) uses the pinned TLS configuration of `pinning.rs`. The webview itself cannot reach the network (CSP
//! `connect-src ipc:`, no HTTP plugin), so there is no unpinned path to Beacon.
//!
//! Every request is bound to the origin (scheme, host, port) of the Beacon server the app is signed in to (or signing
//! in to): `beacon_fetch`, the update check and the updater refuse any other origin, so the Bearer token never goes
//! anywhere else (audit FY-L1). Plain `http://` is accepted for loopback development servers in debug builds only.
//!
//! No redirects (the Bearer token stays bound to the configured server), no cookies, no request or response logging.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::pinning::{self, PinSet, PinStatus, UNTRUSTED_MARKER};

/// Largest response body handed to the UI (exports included).
const MAX_BODY: usize = 32 * 1024 * 1024;

/// Request headers the UI may set; anything else is dropped.
const ALLOWED_HEADERS: &[&str] = &["accept", "accept-language", "authorization", "content-type"];

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

/// The origin of the Beacon server the app is signed in to (or signing in to). Held in Rust, managed by Tauri.
#[derive(Default)]
pub struct BoundServer(Mutex<Option<url::Origin>>);

impl BoundServer {
    pub fn origin(&self) -> Option<url::Origin> {
        self.0.lock().ok().and_then(|bound| bound.clone())
    }

    /// Binds `server`. Rebinding to another origin while a session token is stored is refused: the UI signs out
    /// first (`secret_delete` clears the binding).
    pub fn bind(&self, server: &url::Url, signed_in: bool) -> Result<(), String> {
        let mut bound = self.0.lock().map_err(|_| "state unavailable")?;
        let origin = server.origin();
        if signed_in && bound.as_ref().is_some_and(|current| *current != origin) {
            return Err("signed in to another server: sign out first".into());
        }
        *bound = Some(origin);
        Ok(())
    }

    pub fn clear(&self) {
        if let Ok(mut bound) = self.0.lock() {
            *bound = None;
        }
    }
}

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

/// Sends one request with `client`, only to the `bound` server origin (so the `Authorization` header never reaches
/// another origin). Errors are strings for the UI (see [`describe_error`]).
pub async fn send(
    client: &reqwest::Client,
    request: FetchRequest,
    bound: Option<&url::Origin>,
) -> Result<FetchResponse, String> {
    let url = validate_url(&request.url)?;
    require_origin(bound, &url)?;
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err("method not allowed".into()),
    };
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
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(describe_error)?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(describe_error)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(FetchResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        headers,
        body: base64::engine::general_purpose::STANDARD.encode(body),
    })
}

/// Every Beacon API call of the UI (src/lib/nativeFetch.ts): pinned TLS, no redirects, bound server origin only, main
/// window only.
#[tauri::command]
pub async fn beacon_fetch(
    window: tauri::Window,
    bound: tauri::State<'_, BoundServer>,
    request: FetchRequest,
) -> Result<FetchResponse, String> {
    crate::only_from(&window, "main")?;
    let origin = bound.origin();
    send(client(), request, origin.as_ref()).await
}

/// Binds the Beacon server the UI signs in to (before the sign-in requests) or is signed in to (at start-up).
#[tauri::command]
pub fn beacon_bind(
    window: tauri::Window,
    bound: tauri::State<'_, BoundServer>,
    server: String,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    let url = validate_url(&server)?;
    bound.bind(&url, crate::has_session_token())
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
                let body = r#"{"ok":true}"#;
                let _ = write!(
                    tls,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Min-Supported-Version: 0.1.0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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

    /// The origin the UI bound (`beacon_bind`) for the mock server.
    fn bound(port: u16) -> url::Origin {
        url::Url::parse(&format!("https://{HOST}:{port}/"))
            .unwrap()
            .origin()
    }

    fn request(port: u16) -> FetchRequest {
        FetchRequest {
            url: format!("https://{HOST}:{port}/api/time-track/me"),
            method: "GET".into(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Authorization".into(), "Bearer secret-token".into()),
                ("Cookie".into(), "dropped=1".into()),
            ],
            body: None,
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
        let response = send(&client, request(port), Some(&bound(port)))
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.status_text, "OK");
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name == "x-min-supported-version" && value == "0.1.0"));
        let body = base64::engine::general_purpose::STANDARD
            .decode(response.body)
            .unwrap();
        assert_eq!(body, br#"{"ok":true}"#);
        let head = seen.recv().unwrap().to_ascii_lowercase();
        assert!(head.contains("authorization: bearer secret-token"));
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
        let error = send(&client, request(port), Some(&bound(port)))
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
            send(&client, request(port), Some(&bound(port)))
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
            send(&client, request(port), Some(&bound(port)))
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
        let error = send(&client, request(port), Some(&bound(port)))
            .await
            .unwrap_err();
        assert!(!error.contains(UNTRUSTED_MARKER), "{error}");
        assert!(error.to_lowercase().contains("certificate"), "{error}");
    }

    #[tokio::test]
    async fn requests_are_validated_before_sending() {
        let client = build_client(pinning::shipped_client_config()).unwrap();
        let example = url::Url::parse("https://beacon.example.com")
            .unwrap()
            .origin();
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
            };
            assert!(
                send(&client, request, Some(&example)).await.is_err(),
                "{url} {method}"
            );
        }
        let bad_header = FetchRequest {
            url: "https://beacon.example.com/api".into(),
            method: "POST".into(),
            headers: vec![("Authorization".into(), "Bearer \n".into())],
            body: Some("{}".into()),
        };
        assert!(send(&client, bad_header, Some(&example)).await.is_err());
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
        // Bound to another host, to the same host on another port, to http of the same host, or to nothing.
        let other_host = url::Url::parse("https://beacon.elsewhere.example")
            .unwrap()
            .origin();
        let other_port = url::Url::parse(&format!("https://{HOST}:{}/", port.wrapping_add(1)))
            .unwrap()
            .origin();
        let other_scheme = url::Url::parse(&format!("http://{HOST}:{port}/"))
            .unwrap()
            .origin();
        for origin in [Some(&other_host), Some(&other_port), Some(&other_scheme)] {
            let error = send(&client, request(port), origin).await.unwrap_err();
            assert_eq!(error, OTHER_ORIGIN);
        }
        let error = send(&client, request(port), None).await.unwrap_err();
        assert!(error.contains("sign in"), "{error}");
        // Nothing (no Authorization header) reached the server.
        assert!(seen
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err());
    }

    #[test]
    fn origin_binding_rules() {
        let server = BoundServer::default();
        let a = url::Url::parse("https://beacon.a.example/").unwrap();
        let a_path = url::Url::parse("https://beacon.a.example:443/api/time-track/me").unwrap();
        let b = url::Url::parse("https://beacon.b.example/").unwrap();
        assert!(require_origin(server.origin().as_ref(), &a).is_err());
        // Signing in: any server may be bound while no token is stored.
        server.bind(&a, false).unwrap();
        server.bind(&b, false).unwrap();
        server.bind(&a, false).unwrap();
        assert!(require_origin(server.origin().as_ref(), &a_path).is_ok());
        assert_eq!(
            require_origin(server.origin().as_ref(), &b),
            Err(OTHER_ORIGIN.to_string())
        );
        // Signed in: the same server again is fine (start-up), another one is refused until sign-out.
        server.bind(&a, true).unwrap();
        assert!(server.bind(&b, true).is_err());
        assert_eq!(server.origin(), Some(a.origin()));
        server.clear();
        assert_eq!(server.origin(), None);
        server.bind(&b, true).unwrap();
        assert!(require_origin(server.origin().as_ref(), &b).is_ok());
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
