//! The app's HTTP client: every Beacon request (API calls from the UI through `beacon_fetch`, the update check and
//! the updater) uses the pinned TLS configuration of `pinning.rs`. The webview itself cannot reach the network (CSP
//! `connect-src ipc:`, no HTTP plugin), so there is no unpinned path to Beacon.
//!
//! No redirects (the Bearer token stays bound to the configured server), no cookies, no request or response logging.

use std::sync::LazyLock;
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

/// The server URL rule of the app: https, or http on loopback only; no userinfo.
pub fn validate_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "invalid URL".to_string())?;
    let host = url.host_str().ok_or("invalid URL")?;
    let scheme_ok =
        url.scheme() == "https" || (url.scheme() == "http" && pinning::is_loopback(host));
    if !scheme_ok || !url.username().is_empty() || url.password().is_some() {
        return Err("invalid URL".into());
    }
    Ok(url)
}

/// A reqwest error as text for the UI: the pin mismatch keeps its marker, the URL is never included.
pub fn describe_error(error: reqwest::Error) -> String {
    error_text(&error.without_url())
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

/// Sends one request with `client`. Errors are strings for the UI (see [`describe_error`]).
pub async fn send(
    client: &reqwest::Client,
    request: FetchRequest,
) -> Result<FetchResponse, String> {
    let url = validate_url(&request.url)?;
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

/// Every Beacon API call of the UI (src/lib/nativeFetch.ts): pinned TLS, no redirects, main window only.
#[tauri::command]
pub async fn beacon_fetch(
    window: tauri::Window,
    request: FetchRequest,
) -> Result<FetchResponse, String> {
    crate::only_from(&window, "main")?;
    send(client(), request).await
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
        let response = send(&client, request(port)).await.unwrap();
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
        let error = send(&client, request(port)).await.unwrap_err();
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
        assert_eq!(send(&client, request(port)).await.unwrap().status, 200);
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
        assert_eq!(send(&client, request(port)).await.unwrap().status, 200);
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
        let error = send(&client, request(port)).await.unwrap_err();
        assert!(!error.contains(UNTRUSTED_MARKER), "{error}");
        assert!(error.to_lowercase().contains("certificate"), "{error}");
    }

    #[tokio::test]
    async fn requests_are_validated_before_sending() {
        let client = build_client(pinning::shipped_client_config()).unwrap();
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
            assert!(send(&client, request).await.is_err(), "{url} {method}");
        }
        let bad_header = FetchRequest {
            url: "https://beacon.example.com/api".into(),
            method: "POST".into(),
            headers: vec![("Authorization".into(), "Bearer \n".into())],
            body: Some("{}".into()),
        };
        assert!(send(&client, bad_header).await.is_err());
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
    fn loopback_http_is_allowed() {
        assert!(validate_url("http://localhost:8000").is_ok());
        assert!(validate_url("http://127.0.0.1:8000").is_ok());
        assert!(validate_url("http://[::1]:8000").is_ok());
        assert!(validate_url("http://beacon.example.com").is_err());
        assert!(validate_url("https://beacon.example.com").is_ok());
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
