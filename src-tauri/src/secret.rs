//! The session token. It lives in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service) and is
//! used by Rust only: `beacon_fetch` (net.rs) and the updater commands read it and set the `Authorization` header
//! themselves, and the sign-in responses (`login`, `device/token`) are stored here before the UI sees them, with the
//! token replaced by [`SESSION_HANDLE`]. No command returns the token, so a script running in the main webview cannot
//! read it (it was readable through `secret_get` up to 0.5.1).
//!
//! The webview only learns whether a token is stored (`secret_status`) and can delete it (`secret_delete`, sign-out).
//! Error texts never carry the token: keychain errors are reduced to fixed texts per kind.

use std::sync::Mutex;

use reqwest::header::HeaderValue;

const KEYCHAIN_SERVICE: &str = "tech.nowo.time-track-desktop";
const KEYCHAIN_USER: &str = "session-token";

/// What the UI gets in place of the token (sign-in responses, `secret_status`). Not a credential: Rust ignores it.
pub const SESSION_HANDLE: &str = "stored-in-os-keychain";

/// Sign-in routes of the client API whose 2xx answer carries the token (contract v0.3, `token` at the top level).
const SIGN_IN_PATHS: &[&str] = &["/api/time-track/login", "/api/time-track/device/token"];

/// Where the session token is kept. The app uses [`Keychain`]; the tests use an in-memory store.
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, token: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The OS keychain entry of the app, read once per run and then kept in Rust memory (never in the webview).
pub struct Keychain;

/// The token as last read from or written to the keychain; `None` = not read yet or deleted.
static CACHE: Mutex<Option<String>> = Mutex::new(None);

fn cached() -> Option<String> {
    CACHE.lock().ok().and_then(|cache| cache.clone())
}

fn remember(token: Option<&str>) {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = token.map(str::to_string);
    }
}

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
    fn get(&self) -> Result<Option<String>, String> {
        if let Some(token) = cached() {
            return Ok(Some(token));
        }
        match entry()?.get_password() {
            Ok(token) => {
                remember(Some(&token));
                Ok(Some(token))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn set(&self, token: &str) -> Result<(), String> {
        entry()?
            .set_password(token)
            .map_err(|e| keychain_error(&e))?;
        remember(Some(token));
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        remember(None);
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(&e)),
        }
    }
}

/// True when a session token is stored (`beacon_bind` then refuses to switch servers).
pub fn has_token(store: &dyn TokenStore) -> bool {
    matches!(store.get(), Ok(Some(_)))
}

/// `Bearer <token>` as a sensitive header value. The error never quotes the token.
pub fn bearer(token: &str) -> Result<HeaderValue, String> {
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "the stored session token is not a valid header value".to_string())?;
    value.set_sensitive(true);
    Ok(value)
}

/// A request to a sign-in route (POST `…/api/time-track/login` or `…/device/token`, any base path).
pub fn is_sign_in(method: &reqwest::Method, url: &url::Url) -> bool {
    *method == reqwest::Method::POST && SIGN_IN_PATHS.iter().any(|path| url.path().ends_with(path))
}

/// Takes the token out of a 2xx sign-in answer: stores it and returns the body with [`SESSION_HANDLE`] in its place.
/// An answer that is not a JSON object becomes `{}` (the UI then reports "the server did not return a token"), so a
/// token never reaches the webview in any shape.
pub fn capture_token(body: &[u8], store: &dyn TokenStore) -> Result<Vec<u8>, String> {
    let Ok(serde_json::Value::Object(mut answer)) = serde_json::from_slice(body) else {
        return Ok(b"{}".to_vec());
    };
    if let Some(token) = answer.get("token").and_then(|token| token.as_str()) {
        if !token.is_empty() {
            store.set(token)?;
            answer.insert("token".into(), SESSION_HANDLE.into());
        }
    }
    serde_json::to_vec(&answer).map_err(|_| "invalid sign-in response".to_string())
}

/// Whether a session token is stored (the UI then starts signed in). Never the token itself.
#[tauri::command]
pub fn secret_status(window: tauri::Window) -> Result<bool, String> {
    crate::only_from(&window, "main")?;
    Ok(Keychain.get()?.is_some())
}

/// Signs out locally: deletes the token and unbinds the server (net.rs, FY-L1).
#[tauri::command]
pub fn secret_delete(
    window: tauri::Window,
    bound: tauri::State<'_, crate::net::BoundServer>,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    bound.clear();
    Keychain.delete()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// An in-memory [`TokenStore`].
    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<Option<String>>);

    impl MemoryStore {
        pub fn with(token: &str) -> Self {
            Self(Mutex::new(Some(token.to_string())))
        }

        pub fn token(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
    }

    impl TokenStore for MemoryStore {
        fn get(&self) -> Result<Option<String>, String> {
            Ok(self.token())
        }

        fn set(&self, token: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(token.to_string());
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    /// A store whose keychain is unavailable.
    pub struct BrokenStore;

    impl TokenStore for BrokenStore {
        fn get(&self) -> Result<Option<String>, String> {
            Err(keychain_error(&keyring::Error::BadEncoding(
                b"secret-token".to_vec(),
            )))
        }

        fn set(&self, _token: &str) -> Result<(), String> {
            Err(keychain_error(&keyring::Error::NoStorageAccess(
                "secret-token".into(),
            )))
        }

        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

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
    fn sign_in_routes_are_post_only_and_keep_the_base_path() {
        let url = |u: &str| url::Url::parse(u).unwrap();
        let post = reqwest::Method::POST;
        assert!(is_sign_in(
            &post,
            &url("https://b.example/api/time-track/device/token")
        ));
        assert!(is_sign_in(
            &post,
            &url("https://b.example/beacon/api/time-track/login")
        ));
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
    }

    #[test]
    fn sign_in_answers_are_stored_and_the_token_replaced() {
        let store = MemoryStore::default();
        let body = br#"{"token":"secret-token","expiresAt":"2027-01-01T00:00:00Z","scopes":["timer:read"]}"#;
        let out = capture_token(body, &store).unwrap();
        assert_eq!(store.token().as_deref(), Some("secret-token"));
        let json: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(json["token"], SESSION_HANDLE);
        assert_eq!(json["expiresAt"], "2027-01-01T00:00:00Z");
        assert_eq!(json["scopes"][0], "timer:read");
        assert!(!String::from_utf8_lossy(&out).contains("secret-token"));
        // No token (an error object), an empty token, not an object, not JSON: nothing stored.
        let empty = MemoryStore::default();
        assert_eq!(
            capture_token(br#"{"status":"pending"}"#, &empty).unwrap(),
            br#"{"status":"pending"}"#
        );
        assert_eq!(
            capture_token(br#"{"token":""}"#, &empty).unwrap(),
            br#"{"token":""}"#
        );
        assert_eq!(
            capture_token(br#"["secret-token"]"#, &empty).unwrap(),
            b"{}"
        );
        assert_eq!(capture_token(b"token=secret-token", &empty).unwrap(), b"{}");
        assert_eq!(empty.token(), None);
        // The keychain refuses it: an error, never the token.
        let error = capture_token(body, &BrokenStore).unwrap_err();
        assert!(!error.contains("secret-token"), "{error}");
    }

    #[test]
    fn has_token_is_false_on_errors() {
        assert!(has_token(&MemoryStore::with("t")));
        assert!(!has_token(&MemoryStore::default()));
        assert!(!has_token(&BrokenStore));
    }
}
