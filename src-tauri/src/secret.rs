//! The session token and the Beacon server it belongs to. Both live in the OS keychain (macOS Keychain, Windows
//! Credential Manager, Secret Service) and are used by Rust only (audit FY-D-2, appendix GM):
//!
//! - **Never in the webview.** `beacon_fetch` (net.rs) and the updater commands set `Authorization` themselves. No
//!   command returns the token; the webview only learns whether one is stored (`secret_status`) and can delete it
//!   (`secret_delete`, sign-out). Every JSON answer has its `token` / `access_token` / `refresh_token` fields scrubbed,
//!   at any depth and on any status, before the webview sees it (GM-I1).
//! - **Bound to its origin** (GM-M1). The keychain entry is `{"v":1,"origin":…,"token":…}`. While a token is stored,
//!   only its origin can be bound (whether or not something is bound yet, so a server changed in `localStorage` is
//!   refused at start-up), and the bearer is attached only to requests to that origin. A keychain that cannot be read
//!   refuses the binding (fail closed). A 0.5.1 entry (the bare token) has no origin: the first binding of the upgraded
//!   app adopts it (trust on first use, no less than 0.5.1 itself trusted) and rewrites the entry.
//! - **Captured only for a sign-in the app started** (GM-L2). `sign_in_begin` (main window, no token stored) binds the
//!   server and opens a sign-in window; only then is the token of a 2xx sign-in answer (`login`, `device/token`, path
//!   percent-decoded, GM-L1) from that origin stored. A stored token is never replaced: sign out first.
//! - **Atomic** (GM-L3). One lock covers the in-memory copy, the binding, the pending sign-in and every keychain call.
//!   Sign-out deletes the keychain entry first; on failure the token and the binding stay and the error is reported.
//!
//! Error texts never carry the token: keychain errors are reduced to fixed texts per kind.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use reqwest::header::HeaderValue;
use serde_json::Value;

const KEYCHAIN_SERVICE: &str = "tech.nowo.time-track-desktop";
const KEYCHAIN_USER: &str = "session-token";

/// What the UI gets in place of the token (sign-in answers). Not a credential: Rust ignores it.
pub const SESSION_HANDLE: &str = "stored-in-os-keychain";

/// Sign-in routes of the client API whose 2xx answer carries the token (contract v0.3, `token` at the top level).
const SIGN_IN_PATHS: &[&str] = &["/api/time-track/login", "/api/time-track/device/token"];

/// Fields never handed to the webview, at any depth of a JSON answer (GM-I1).
const SECRET_FIELDS: &[&str] = &["token", "access_token", "refresh_token"];

/// How long a sign-in started with `sign_in_begin` may take (the device code itself expires sooner).
pub const SIGN_IN_WINDOW: Duration = Duration::from_secs(30 * 60);

/// Refusal while a token is stored for another server.
pub const SIGNED_IN_ELSEWHERE: &str = "signed in to another server: sign out first";
/// Refusal of a sign-in while a token is stored.
pub const ALREADY_SIGNED_IN: &str = "already signed in: sign out first";

/// A stored session: the token and the origin (ASCII serialisation) that issued it. `origin` is `None` only for an
/// entry written by 0.5.1 or earlier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored {
    pub origin: Option<String>,
    pub token: String,
}

impl Stored {
    fn encode(&self) -> String {
        serde_json::json!({"v": 1, "origin": self.origin, "token": self.token}).to_string()
    }

    /// The keychain value: our JSON entry, else (0.5.1) the bare token.
    fn decode(value: String) -> Self {
        if let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(&value) {
            if entry.get("v").and_then(Value::as_u64) == Some(1) {
                if let Some(token) = entry.get("token").and_then(Value::as_str) {
                    return Self {
                        origin: entry
                            .get("origin")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        token: token.to_string(),
                    };
                }
            }
        }
        Self {
            origin: None,
            token: value,
        }
    }
}

/// Where the session is kept. The app uses [`Keychain`]; the tests use an in-memory store.
pub trait TokenStore: Send + Sync {
    fn read(&self) -> Result<Option<Stored>, String>;
    fn write(&self, stored: &Stored) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The OS keychain entry of the app (raw: [`Session`] keeps the in-memory copy and the lock).
pub struct Keychain;

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| keychain_error(&e))
}

/// A keychain error as a fixed text: never the stored data (`BadEncoding` carries the raw secret) nor a platform
/// message that could quote it.
pub fn keychain_error(error: &keyring::Error) -> String {
    match error {
        keyring::Error::NoEntry => "no session token stored",
        keyring::Error::NoStorageAccess(_) => "the OS keychain is locked or unavailable",
        keyring::Error::BadEncoding(_) => "the stored session token is unreadable",
        keyring::Error::TooLong(..) | keyring::Error::Invalid(..) => {
            "the session token cannot be stored"
        }
        keyring::Error::Ambiguous(_) => "more than one session token is stored",
        _ => "OS keychain error",
    }
    .to_string()
}

impl TokenStore for Keychain {
    fn read(&self) -> Result<Option<Stored>, String> {
        match entry()?.get_password() {
            Ok(value) => Ok(Some(Stored::decode(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn write(&self, stored: &Stored) -> Result<(), String> {
        entry()?
            .set_password(&stored.encode())
            .map_err(|e| keychain_error(&e))
    }

    fn delete(&self) -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(&e)),
        }
    }
}

/// `Bearer <token>` as a sensitive header value. The error never quotes the token.
pub fn bearer(token: &str) -> Result<HeaderValue, String> {
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "the stored session token is not a valid header value".to_string())?;
    value.set_sensitive(true);
    Ok(value)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The escapes of a path: `(position, decoded byte)`, or `None` when one is malformed.
fn escapes(path: &str) -> Option<Vec<(usize, u8)>> {
    let raw = path.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let high = hex(*raw.get(i + 1)?)?;
            let low = hex(*raw.get(i + 2)?)?;
            found.push((i, high * 16 + low));
            i += 3;
        } else {
            i += 1;
        }
    }
    Some(found)
}

/// The percent-decoded path (as the server's router matches it, GM-L1); `None` for a malformed escape.
pub fn decoded_path(url: &url::Url) -> Option<String> {
    let path = url.path();
    let raw = path.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut last = 0;
    for (at, byte) in escapes(path)? {
        out.extend_from_slice(&raw[last..at]);
        out.push(byte);
        last = at + 3;
    }
    out.extend_from_slice(&raw[last..]);
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// A path that escapes an unreserved character or `/` (`%6C` for `l` …), or is malformed: the client never sends one,
/// and it is how a route match could be dodged (GM-L1). Refused before anything is sent.
pub fn obfuscated_path(url: &url::Url) -> bool {
    match escapes(url.path()) {
        None => true,
        Some(found) => found.iter().any(|&(_, byte)| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/')
        }),
    }
}

/// A request to a sign-in route (POST `…/api/time-track/login` or `…/device/token`, any base path, decoded path).
pub fn is_sign_in(method: &reqwest::Method, url: &url::Url) -> bool {
    *method == reqwest::Method::POST
        && decoded_path(url)
            .is_some_and(|path| SIGN_IN_PATHS.iter().any(|route| path.ends_with(route)))
}

/// Replaces every secret field (any depth) with `null`; returns how many were replaced.
fn scrub_value(value: &mut Value) -> usize {
    match value {
        Value::Object(map) => map
            .iter_mut()
            .map(|(key, child)| {
                if SECRET_FIELDS.contains(&key.to_ascii_lowercase().as_str()) {
                    *child = Value::Null;
                    1
                } else {
                    scrub_value(child)
                }
            })
            .sum(),
        Value::Array(items) => items.iter_mut().map(scrub_value).sum(),
        _ => 0,
    }
}

/// The body without secret fields (GM-I1): `null` in their place. Non-JSON bodies (exports) and JSON without secret
/// fields pass unchanged.
pub fn scrub(body: Vec<u8>) -> Vec<u8> {
    let Ok(mut json) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };
    if scrub_value(&mut json) == 0 {
        return body;
    }
    serde_json::to_vec(&json).unwrap_or_else(|_| b"{}".to_vec())
}

#[derive(Default)]
struct State {
    /// The keychain was read (`stored` is then what it holds).
    loaded: bool,
    stored: Option<Stored>,
    bound: Option<url::Origin>,
    /// The origin of the sign-in `sign_in_begin` started, and when.
    sign_in: Option<(url::Origin, Instant)>,
}

/// The session of the app (managed by Tauri): token, binding and pending sign-in under one lock.
pub struct Session {
    store: Box<dyn TokenStore>,
    state: Mutex<State>,
    sign_in_window: Duration,
}

/// What an authenticated request gets.
pub enum Authorization {
    Bearer(HeaderValue),
    /// No token for this origin: the UI gets 401 and nothing is sent.
    None,
}

impl Session {
    pub fn new(store: Box<dyn TokenStore>) -> Self {
        Self::with_window(store, SIGN_IN_WINDOW)
    }

    pub fn with_window(store: Box<dyn TokenStore>, sign_in_window: Duration) -> Self {
        Self {
            store,
            state: Mutex::new(State::default()),
            sign_in_window,
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>, String> {
        self.state
            .lock()
            .map_err(|_| "session state unavailable".to_string())
    }

    /// The stored session, read from the keychain once (under the lock). A keychain error is returned, never ignored.
    fn stored<'a>(&self, state: &'a mut State) -> Result<Option<&'a Stored>, String> {
        if !state.loaded {
            state.stored = self.store.read()?;
            state.loaded = true;
        }
        Ok(state.stored.as_ref())
    }

    /// Whether a token is stored (`secret_status`). A keychain that cannot be read is an error.
    pub fn signed_in(&self) -> Result<bool, String> {
        let mut state = self.lock()?;
        Ok(self.stored(&mut state)?.is_some())
    }

    pub fn bound_origin(&self) -> Option<url::Origin> {
        self.lock().ok().and_then(|state| state.bound.clone())
    }

    /// Binds `server` (start-up, or no session). While a token is stored, only its origin; a 0.5.1 token without one
    /// adopts this origin (trust on first use) and the entry is rewritten.
    pub fn bind(&self, server: &url::Url) -> Result<(), String> {
        let origin = server.origin();
        let serialised = origin.ascii_serialization();
        let mut state = self.lock()?;
        match self.stored(&mut state)?.cloned() {
            Some(Stored {
                origin: Some(owner),
                ..
            }) if owner != serialised => return Err(SIGNED_IN_ELSEWHERE.into()),
            Some(Stored {
                origin: None,
                token,
            }) => {
                let adopted = Stored {
                    origin: Some(serialised),
                    token,
                };
                self.store.write(&adopted)?;
                state.stored = Some(adopted);
            }
            _ => {}
        }
        state.bound = Some(origin);
        Ok(())
    }

    /// Starts a sign-in to `server`: refused while a token is stored; binds the server and allows one capture.
    pub fn begin_sign_in(&self, server: &url::Url) -> Result<(), String> {
        let origin = server.origin();
        let mut state = self.lock()?;
        if self.stored(&mut state)?.is_some() {
            return Err(ALREADY_SIGNED_IN.into());
        }
        state.bound = Some(origin.clone());
        state.sign_in = Some((origin, Instant::now()));
        Ok(())
    }

    /// The `Authorization` for a request to `url`: only the stored token's own origin gets it.
    pub fn authorization_for(&self, url: &url::Url) -> Result<Authorization, String> {
        let origin = url.origin().ascii_serialization();
        let mut state = self.lock()?;
        match self.stored(&mut state)? {
            Some(Stored {
                origin: Some(owner),
                token,
            }) if *owner == origin => Ok(Authorization::Bearer(bearer(token)?)),
            _ => Ok(Authorization::None),
        }
    }

    /// A 2xx answer to a sign-in route of `url`'s origin: stores its token when the app started that sign-in and no
    /// token is stored, and puts [`SESSION_HANDLE`] in its place. Otherwise nothing is stored and the token is
    /// scrubbed like any other answer. A non-object answer becomes `{}`.
    pub fn capture(&self, url: &url::Url, body: &[u8]) -> Result<Vec<u8>, String> {
        let Ok(mut answer @ Value::Object(_)) = serde_json::from_slice::<Value>(body) else {
            return Ok(b"{}".to_vec());
        };
        let token = answer
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string);
        let origin = url.origin();
        let mut captured = false;
        {
            let mut state = self.lock()?;
            let started = state.sign_in.as_ref().is_some_and(|(pending, at)| {
                *pending == origin && at.elapsed() <= self.sign_in_window
            });
            if let (Some(token), true) = (token, started) {
                if self.stored(&mut state)?.is_none() {
                    let stored = Stored {
                        origin: Some(origin.ascii_serialization()),
                        token,
                    };
                    self.store.write(&stored)?;
                    state.stored = Some(stored);
                    state.sign_in = None;
                    captured = true;
                }
            }
        }
        scrub_value(&mut answer);
        if captured {
            answer["token"] = Value::String(SESSION_HANDLE.into());
        }
        serde_json::to_vec(&answer).map_err(|_| "invalid sign-in response".to_string())
    }

    /// Signs out locally: deletes the keychain entry first; only then forgets the token, the binding and any pending
    /// sign-in. On failure nothing changes and the error is returned.
    pub fn sign_out(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        self.store.delete()?;
        *state = State {
            loaded: true,
            ..State::default()
        };
        Ok(())
    }
}

/// Whether a session token is stored (the UI then starts signed in). Never the token itself.
#[tauri::command]
pub fn secret_status(
    window: tauri::Window,
    session: tauri::State<'_, Session>,
) -> Result<bool, String> {
    crate::only_from(&window, "main")?;
    session.signed_in()
}

/// Starts a sign-in to `server` (before its requests): refused while signed in; binds the server, and the next 2xx
/// sign-in answer from it (within [`SIGN_IN_WINDOW`]) is stored in the keychain.
#[tauri::command]
pub fn sign_in_begin(
    window: tauri::Window,
    session: tauri::State<'_, Session>,
    server: String,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    let url = crate::net::validate_url(&server)?;
    session.begin_sign_in(&url)
}

/// Signs out locally: deletes the token, then unbinds the server (net.rs, FY-L1). A keychain that refuses the delete
/// keeps both, and the error is returned.
#[tauri::command]
pub fn secret_delete(
    window: tauri::Window,
    session: tauri::State<'_, Session>,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    session.sign_out()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// An in-memory [`TokenStore`]; `fail_read` / `fail_delete` simulate a locked keychain.
    #[derive(Default, Clone)]
    pub struct MemoryStore {
        pub value: Arc<Mutex<Option<Stored>>>,
        pub fail_read: Arc<AtomicBool>,
        pub fail_delete: Arc<AtomicBool>,
    }

    impl MemoryStore {
        pub fn with(origin: &str, token: &str) -> Self {
            let store = Self::default();
            *store.value.lock().unwrap() = Some(Stored {
                origin: Some(
                    url::Url::parse(origin)
                        .unwrap()
                        .origin()
                        .ascii_serialization(),
                ),
                token: token.into(),
            });
            store
        }

        pub fn legacy(token: &str) -> Self {
            let store = Self::default();
            *store.value.lock().unwrap() = Some(Stored {
                origin: None,
                token: token.into(),
            });
            store
        }

        pub fn stored(&self) -> Option<Stored> {
            self.value.lock().unwrap().clone()
        }
    }

    fn locked() -> String {
        keychain_error(&keyring::Error::NoStorageAccess("secret-token".into()))
    }

    impl TokenStore for MemoryStore {
        fn read(&self) -> Result<Option<Stored>, String> {
            if self.fail_read.load(Ordering::SeqCst) {
                return Err(locked());
            }
            Ok(self.stored())
        }

        fn write(&self, stored: &Stored) -> Result<(), String> {
            *self.value.lock().unwrap() = Some(stored.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(locked());
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    /// A session over `store` (sharing its value).
    pub fn session(store: &MemoryStore) -> Session {
        Session::new(Box::new(store.clone()))
    }

    fn url(value: &str) -> url::Url {
        url::Url::parse(value).unwrap()
    }

    fn bearer_of(session: &Session, target: &str) -> Option<String> {
        match session.authorization_for(&url(target)).unwrap() {
            Authorization::Bearer(value) => Some(value.to_str().unwrap().to_string()),
            Authorization::None => None,
        }
    }

    fn json(bytes: Vec<u8>) -> Value {
        serde_json::from_slice(&bytes).unwrap()
    }

    const A: &str = "https://beacon.a.example";
    const B: &str = "https://beacon.b.example";
    const ANSWER: &[u8] =
        br#"{"token":"fresh-token","expiresAt":"2027-01-01T00:00:00Z","scopes":["timer:read"]}"#;

    #[test]
    fn keychain_errors_never_quote_the_secret() {
        for error in [
            keyring::Error::BadEncoding(b"secret-token".to_vec()),
            keyring::Error::NoStorageAccess("secret-token".into()),
            keyring::Error::PlatformFailure("secret-token".into()),
            keyring::Error::Invalid("secret-token".into(), "secret-token".into()),
            keyring::Error::TooLong("secret-token".into(), 1),
        ] {
            let text = keychain_error(&error);
            assert!(!text.contains("secret-token"), "{text}");
            assert!(!text.is_empty());
        }
    }

    #[test]
    fn bearer_is_sensitive_and_its_error_never_quotes_the_token() {
        let value = bearer("abc").unwrap();
        assert_eq!(value.to_str().unwrap(), "Bearer abc");
        assert!(value.is_sensitive());
        assert!(!format!("{value:?}").contains("abc"));
        let error = bearer("secret-token\n").unwrap_err();
        assert!(!error.contains("secret-token"), "{error}");
    }

    #[test]
    fn keychain_entry_keeps_the_origin_and_reads_a_0_5_1_token() {
        let stored = Stored {
            origin: Some(A.into()),
            token: "t\"ok".into(),
        };
        assert_eq!(Stored::decode(stored.encode()), stored);
        assert_eq!(
            Stored::decode("bare-0.5.1-token".into()),
            Stored {
                origin: None,
                token: "bare-0.5.1-token".into()
            }
        );
        // A JSON-looking bare token is still a bare token.
        assert_eq!(Stored::decode(r#"{"token":"x"}"#.into()).origin, None);
    }

    // GM-M1: the token's origin, not the UI's saved server, decides.
    #[test]
    fn a_stored_token_only_binds_and_authorises_its_own_origin() {
        let store = MemoryStore::with(A, "secret-token");
        // Start-up: nothing bound yet, the UI's saved server was changed to B (localStorage).
        let session = session(&store);
        assert_eq!(session.bind(&url(B)).unwrap_err(), SIGNED_IN_ELSEWHERE);
        assert_eq!(session.bound_origin(), None);
        assert_eq!(bearer_of(&session, &format!("{B}/api/time-track/me")), None);
        // Its own origin binds and gets the bearer; other origins, ports and schemes never do.
        session.bind(&url(&format!("{A}/"))).unwrap();
        assert_eq!(
            bearer_of(&session, &format!("{A}/api/time-track/me")).as_deref(),
            Some("Bearer secret-token")
        );
        for other in [
            format!("{B}/api"),
            "https://beacon.a.example:8443/api".into(),
            "http://beacon.a.example/api".into(),
        ] {
            assert_eq!(bearer_of(&session, &other), None, "{other}");
        }
        assert!(session.bind(&url(B)).is_err());
        assert_eq!(session.bound_origin(), Some(url(A).origin()));
    }

    #[test]
    fn a_locked_keychain_fails_closed() {
        let store = MemoryStore::with(A, "secret-token");
        store.fail_read.store(true, Ordering::SeqCst);
        let session = session(&store);
        // Locked: no binding without knowing the token's origin, no sign-in, no bearer.
        assert!(session.bind(&url(B)).is_err());
        assert!(session.begin_sign_in(&url(B)).is_err());
        assert!(session.signed_in().is_err());
        assert!(session.authorization_for(&url(B)).is_err());
        assert_eq!(session.bound_origin(), None);
        // Readable later: still A only.
        store.fail_read.store(false, Ordering::SeqCst);
        assert_eq!(session.bind(&url(B)).unwrap_err(), SIGNED_IN_ELSEWHERE);
        session.bind(&url(A)).unwrap();
    }

    #[test]
    fn a_0_5_1_token_adopts_the_first_binding_then_keeps_it() {
        let store = MemoryStore::legacy("secret-token");
        let first = session(&store);
        assert_eq!(
            bearer_of(&first, &format!("{A}/api")),
            None,
            "no origin yet: no bearer"
        );
        first.bind(&url(A)).unwrap();
        assert_eq!(store.stored().unwrap().origin.as_deref(), Some(A));
        assert!(bearer_of(&first, &format!("{A}/api")).is_some());
        // Next start-up: the rewritten entry pins A.
        let again = session(&store);
        assert_eq!(again.bind(&url(B)).unwrap_err(), SIGNED_IN_ELSEWHERE);
    }

    // GM-L1
    #[test]
    fn sign_in_routes_are_matched_on_the_decoded_path() {
        let post = reqwest::Method::POST;
        for route in [
            "https://b.example/api/time-track/device/token",
            "https://b.example/beacon/api/time-track/login",
            "https://b.example/api/time-track/%6Cogin",
            "https://b.example/api/time-track/device/to%6Ben",
            "https://b.example/api/time-track/device%2Ftoken",
        ] {
            assert!(is_sign_in(&post, &url(route)), "{route}");
        }
        assert!(!is_sign_in(
            &reqwest::Method::GET,
            &url("https://b.example/api/time-track/login")
        ));
        assert!(!is_sign_in(
            &post,
            &url("https://b.example/api/time-track/device/code")
        ));
        assert!(!is_sign_in(
            &post,
            &url("https://b.example/api/time-track/me")
        ));
        for obfuscated in [
            "https://b.example/api/time-track/%6Cogin",
            "https://b.example/api/time-track/device%2Ftoken",
            "https://b.example/api/time-track/%7e",
            "https://b.example/api/%zz",
            "https://b.example/api/%4",
        ] {
            assert!(obfuscated_path(&url(obfuscated)), "{obfuscated}");
        }
        for plain in [
            "https://b.example/api/time-track/login",
            "https://b.example/api/time-track/tasks?search=%6C",
            "https://b.example/api/caf%C3%A9",
            "https://b.example/api/a%20b",
        ] {
            assert!(!obfuscated_path(&url(plain)), "{plain}");
        }
        assert_eq!(
            decoded_path(&url("https://b.example/a%20b/%6C")).as_deref(),
            Some("/a b/l")
        );
    }

    // GM-L2
    #[test]
    fn only_a_started_sign_in_is_captured_and_never_over_a_stored_token() {
        let login = url(&format!("{A}/api/time-track/device/token"));
        // No sign-in started: nothing stored, token scrubbed.
        let store = MemoryStore::default();
        let session = session(&store);
        session.bind(&url(A)).unwrap();
        let out = json(session.capture(&login, ANSWER).unwrap());
        assert_eq!(out["token"], Value::Null);
        assert_eq!(out["scopes"][0], "timer:read");
        assert_eq!(store.stored(), None);
        // Started for A: stored with A's origin, the handle in its place, and only once.
        session.begin_sign_in(&url(A)).unwrap();
        let out = json(session.capture(&login, ANSWER).unwrap());
        assert_eq!(out["token"], SESSION_HANDLE);
        assert_eq!(
            store.stored(),
            Some(Stored {
                origin: Some(A.into()),
                token: "fresh-token".into()
            })
        );
        let other = br#"{"token":"attacker-token"}"#;
        assert_eq!(
            json(session.capture(&login, other).unwrap())["token"],
            Value::Null
        );
        assert_eq!(store.stored().unwrap().token, "fresh-token");
        // Signed in: no new sign-in until sign-out.
        assert_eq!(
            session.begin_sign_in(&url(A)).unwrap_err(),
            ALREADY_SIGNED_IN
        );
        session.sign_out().unwrap();
        session.begin_sign_in(&url(A)).unwrap();
        // A sign-in started for A does not capture B's answer.
        let from_b = url(&format!("{B}/api/time-track/login"));
        assert_eq!(
            json(session.capture(&from_b, ANSWER).unwrap())["token"],
            Value::Null
        );
        assert_eq!(store.stored(), None);
        // Expired sign-in window.
        let late = Session::with_window(Box::new(store.clone()), Duration::ZERO);
        late.begin_sign_in(&url(A)).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(
            json(late.capture(&login, ANSWER).unwrap())["token"],
            Value::Null
        );
        assert_eq!(store.stored(), None);
        // Not an object: `{}`.
        assert_eq!(
            session.capture(&login, br#"["fresh-token"]"#).unwrap(),
            b"{}"
        );
        assert_eq!(
            session.capture(&login, b"token=fresh-token").unwrap(),
            b"{}"
        );
    }

    // GM-L3
    #[test]
    fn a_failed_sign_out_keeps_the_token_and_the_binding() {
        let store = MemoryStore::with(A, "secret-token");
        let session = session(&store);
        session.bind(&url(A)).unwrap();
        store.fail_delete.store(true, Ordering::SeqCst);
        let error = session.sign_out().unwrap_err();
        assert!(!error.contains("secret-token"), "{error}");
        assert_eq!(session.bound_origin(), Some(url(A).origin()));
        assert!(session.signed_in().unwrap());
        assert!(session.bind(&url(B)).is_err(), "still pinned to A");
        store.fail_delete.store(false, Ordering::SeqCst);
        session.sign_out().unwrap();
        assert_eq!(store.stored(), None);
        assert_eq!(session.bound_origin(), None);
        assert!(!session.signed_in().unwrap());
        assert_eq!(bearer_of(&session, &format!("{A}/api")), None);
    }

    #[test]
    fn sign_out_racing_requests_never_brings_the_token_back() {
        for _ in 0..20 {
            let store = MemoryStore::with(A, "secret-token");
            // Not read yet: the readers race the first keychain read against the delete.
            let session = Arc::new(session(&store));
            let readers: Vec<_> = (0..4)
                .map(|_| {
                    let session = session.clone();
                    std::thread::spawn(move || {
                        for _ in 0..200 {
                            let _ = session.authorization_for(&url(&format!("{A}/api")));
                        }
                    })
                })
                .collect();
            session.sign_out().unwrap();
            for reader in readers {
                reader.join().unwrap();
            }
            assert_eq!(store.stored(), None);
            assert_eq!(bearer_of(&session, &format!("{A}/api")), None);
            assert!(!session.signed_in().unwrap());
        }
    }

    // GM-I1
    #[test]
    fn secret_fields_are_scrubbed_at_any_depth() {
        let body = br#"{"data":{"token":"t1","list":[{"access_token":"t2"},{"Refresh_Token":{"x":"t3"}}]},"token":7,"ok":"token"}"#;
        let out = String::from_utf8(scrub(body.to_vec())).unwrap();
        for secret in ["t1", "t2", "t3", ":7"] {
            assert!(!out.contains(secret), "{out}");
        }
        assert!(
            out.contains(r#""ok":"token""#),
            "values named token stay: {out}"
        );
        // Nothing to scrub, or not JSON (an export): byte for byte.
        let csv = b"date,token\n2026-01-01,abc".to_vec();
        assert_eq!(scrub(csv.clone()), csv);
        let plain = br#"{"identifier":"ana"}"#.to_vec();
        assert_eq!(scrub(plain.clone()), plain);
    }
}
