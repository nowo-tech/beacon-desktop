//! The session token and the Beacon server it belongs to. Both live in the OS keychain (macOS Keychain, Windows
//! Credential Manager, Secret Service) and are used by Rust only (audit FY-D-2, appendix GM):
//!
//! - **Never in the webview.** `beacon_fetch` (net.rs) and the updater commands set `Authorization` themselves. No
//!   command returns the token; the webview only learns whether one is stored (`secret_status`), can start a sign-in
//!   (`sign_in_begin`) and delete it (`secret_delete`, sign-out). Every JSON answer has its token fields (`token`,
//!   `access_token` / `accessToken`, `refresh_token`, `session_token`, `id_token`, `bearer`, any case) scrubbed at any
//!   depth and on any status, and only allow-listed response headers reach the webview (GM-I1, GM-D-3).
//! - **Bound to its origin** (GM-M1). The keychain entry is `{"v":1,"origin":…,"token":…}`. While a token is stored,
//!   only its origin can be bound (whether or not something is bound yet, so a server changed in `localStorage` is
//!   refused at start-up), and the bearer is attached only to requests to that origin. A keychain that cannot be read
//!   refuses the binding (fail closed). A 0.5.1 entry (the bare token) has no origin: the first binding of the upgraded
//!   app adopts it (trust on first use, no less than 0.5.1 itself trusted) and rewrites the entry.
//! - **Captured only for a sign-in the person confirmed** (GM-L2, GM-D-1). `sign_in_begin` (main window, no token
//!   stored) asks in a native dialog the webview cannot answer ("Sign in to <host>?"); only after "Sign in" is the
//!   token of a 2xx `device/token` answer (path percent-decoded, GM-L1) from that origin stored, within 30 minutes, and
//!   an OS notification says so. A stored token is never replaced: sign out first. The password route is never
//!   captured (the app is device-flow only).
//! - **Atomic** (GM-L3) **and off the UI threads** (GM-D-4). `io` serialises every keychain call and change, `state`
//!   is held only briefly; the commands run the keychain and the dialog with `spawn_blocking`. Sign-out deletes the
//!   keychain entry first; on failure the token and the binding stay and the error is reported.
//!
//! Error texts never carry the token: keychain errors are reduced to fixed texts per kind.
//!
//! **Chat token (BD-2, design §2.3 / §4.5).** A second keychain entry under the same service, user `chat-token`, holds
//! the `chat` family token (TimeTrackBundle 2.2 scope families, contract v0.5). Same rules as the time token, plus:
//!
//! - It is attached **only** to chat client API routes (`…/api/chat/…`), and the time token never is: a chat route
//!   gets the chat token or nothing, every other route the time token or nothing, anchored to `<base path>/api/chat/v1/` ([`route_of`]).
//! - It is captured only from a 2xx `device/token` answer whose `scopeFamily` is `chat`, after `chat_connect_begin`
//!   (main window, a person at the app, the time token stored for the bound origin, no chat token yet), within
//!   [`SIGN_IN_WINDOW`], from the time token's own origin. A `chat` answer never lands in the time entry and a `time`
//!   answer never in the chat entry; any other family is scrubbed and never stored.
//! - No native dialog: the approval page in Beacon accepts a chained request only from the time token's owner
//!   (contract v0.5), so the origin and the person are already fixed. An OS notification still announces it.
//! - "Disconnect chat" deletes the chat entry only; sign-out deletes the chat entry first, then the time entry.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderValue;
use serde_json::Value;

const KEYCHAIN_SERVICE: &str = "tech.nowo.time-track-desktop";
const KEYCHAIN_USER: &str = "session-token";
/// The chat token's keychain user (same service): BD-2, design §4.5. Never changes (installed copies read it).
const KEYCHAIN_CHAT_USER: &str = "chat-token";

/// What the UI gets in place of the token (sign-in answers). Not a credential: Rust ignores it.
pub const SESSION_HANDLE: &str = "stored-in-os-keychain";

/// Sign-in route of the client API whose 2xx answer carries the token (contract v0.3, `token` at the top level). The
/// app signs in with the device flow only: the password route (`…/login`) is never captured, so its token is scrubbed
/// like any other (GM-D-1).
const SIGN_IN_PATHS: &[&str] = &["/api/time-track/device/token"];

/// How long a sign-in started with `sign_in_begin` may take (the device code itself expires sooner).
pub const SIGN_IN_WINDOW: Duration = Duration::from_secs(30 * 60);

/// Refusal while a token is stored for another server.
pub const SIGNED_IN_ELSEWHERE: &str = "signed in to another server: sign out first";
/// Refusal of a rebind to another base path of the same server while a chat token is stored (ZBZ-v-I1).
pub const CHAT_BOUND_ELSEWHERE: &str =
    "chat is connected under another path of this server: disconnect chat first";
/// Refusal of a sign-in while a token is stored.
pub const ALREADY_SIGNED_IN: &str = "already signed in: sign out first";

/// A stored session: the token and the origin (ASCII serialisation) that issued it. `origin` is `None` only for an
/// entry written by 0.5.1 or earlier. `base` (chat token, 0.11.0+): the server's base path when the token was stored;
/// chat routes stay anchored to it and a rebind to another base path is refused while it is stored (ZBZ-v-I1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored {
    pub origin: Option<String>,
    pub token: String,
    pub base: Option<String>,
}

impl Stored {
    fn encode(&self) -> String {
        match &self.base {
            Some(base) => serde_json::json!({"v": 1, "origin": self.origin, "token": self.token, "base": base}),
            None => serde_json::json!({"v": 1, "origin": self.origin, "token": self.token}),
        }
        .to_string()
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
                        base: entry
                            .get("base")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    };
                }
            }
        }
        Self {
            origin: None,
            token: value,
            base: None,
        }
    }
}

/// Where the session is kept. The app uses [`Keychain`]; the tests use an in-memory store.
pub trait TokenStore: Send + Sync {
    fn read(&self) -> Result<Option<Stored>, String>;
    fn write(&self, stored: &Stored) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// An OS keychain entry of the app (raw: [`Session`] keeps the in-memory copy and the lock): the time session
/// ([`Keychain::time`]) or the chat token ([`Keychain::chat`]).
pub struct Keychain {
    user: &'static str,
}

impl Keychain {
    /// User `session-token`: the time token (since 0.1).
    pub fn time() -> Self {
        Self {
            user: KEYCHAIN_USER,
        }
    }

    /// User `chat-token`: the chat token (BD-2).
    pub fn chat() -> Self {
        Self {
            user: KEYCHAIN_CHAT_USER,
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, self.user).map_err(|e| keychain_error(&e))
    }
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
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(Stored::decode(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn write(&self, stored: &Stored) -> Result<(), String> {
        self.entry()?
            .set_password(&stored.encode())
            .map_err(|e| keychain_error(&e))
    }

    fn delete(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
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

/// A request to the sign-in route (POST `…/api/time-track/device/token`, any base path, decoded path).
pub fn is_sign_in(method: &reqwest::Method, url: &url::Url) -> bool {
    *method == reqwest::Method::POST
        && decoded_path(url)
            .is_some_and(|path| SIGN_IN_PATHS.iter().any(|route| path.ends_with(route)))
}

/// The chat client API v1 under the bound server's base path (ChatKit 2.4, Beacon `/api/chat/v1`).
pub const CHAT_PREFIX: &str = "/api/chat/v1/";

/// Which token a request may carry (audit ZBZ-L1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// `<base path>/api/chat/v1/…` exactly (decoded path, anchored): the chat token or nothing.
    Chat,
    /// Any other route: the time token or nothing.
    Time,
    /// Looks like a chat route but is not the anchored one (another base, other case, doubled slashes, `/api/chat`
    /// without `v1/`), or a path that cannot be decoded: no token at all.
    Neither,
}

/// The route of `url` for a server bound with base path `base` (no trailing slash; `""` at the root).
pub fn route_of(url: &url::Url, base: &str) -> Route {
    let Some(path) = decoded_path(url) else {
        return Route::Neither;
    };
    if path.starts_with(&format!("{base}{CHAT_PREFIX}")) {
        return Route::Chat;
    }
    let mut folded = path.to_ascii_lowercase();
    while folded.contains("//") {
        folded = folded.replace("//", "/");
    }
    if folded.contains("/api/chat") {
        Route::Neither
    } else {
        Route::Time
    }
}

/// Whether `s` is a UUID (8-4-4-4-12 hex digits).
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `<base>/api/chat/v1/conversations/{uuid}/messages/{uuid}/reactions/{emoji}` exactly (the raw path, one non-empty
/// emoji segment that is not `.` or `..`): the only route the UI may send `PUT` / `DELETE` to (audit ZDG-L1).
pub fn is_reaction_path(url: &url::Url, base: &str) -> bool {
    let Some(rest) = url.path().strip_prefix(&format!("{base}{CHAT_PREFIX}")) else {
        return false;
    };
    let parts: Vec<&str> = rest.split('/').collect();
    matches!(
        parts.as_slice(),
        ["conversations", conversation, "messages", message, "reactions", emoji]
            if is_uuid(conversation) && is_uuid(message) && !emoji.is_empty() && *emoji != "." && *emoji != ".."
    )
}

/// The scope family of a `device/token` answer (`scopeFamily`, contract v0.5). Absent: `time` (older servers).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Time,
    Chat,
    /// A family this app does not hold (never stored).
    Other,
}

impl Family {
    fn of(answer: &Value) -> Self {
        match answer.get("scopeFamily") {
            None | Some(Value::Null) => Self::Time,
            Some(Value::String(family)) if family == "time" => Self::Time,
            Some(Value::String(family)) if family == "chat" => Self::Chat,
            _ => Self::Other,
        }
    }
}

/// The secret field names, compared without case, `_` or `-` (`access_token`, `accessToken`, `Access-Token` …).
const SECRET_FIELDS: &[&str] = &[
    "token",
    "accesstoken",
    "refreshtoken",
    "sessiontoken",
    "idtoken",
    "bearer",
];

fn is_secret_field(key: &str) -> bool {
    let key: String = key
        .chars()
        .filter(|c| !matches!(c, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();
    SECRET_FIELDS.contains(&key.as_str())
}

/// Replaces every secret field (any depth) with `null`; returns how many were replaced.
fn scrub_value(value: &mut Value) -> usize {
    match value {
        Value::Object(map) => map
            .iter_mut()
            .map(|(key, child)| {
                if is_secret_field(key) {
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

/// The JSON of a body, a leading UTF-8 BOM ignored (GM-D-3).
fn parse_json(body: &[u8]) -> Option<Value> {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    serde_json::from_slice(body).ok()
}

/// The body without secret fields (GM-I1, GM-D-3): `null` in their place. Non-JSON bodies (exports) and JSON without
/// secret fields pass unchanged.
pub fn scrub(body: Vec<u8>) -> Vec<u8> {
    let Some(mut json) = parse_json(&body) else {
        return body;
    };
    if scrub_value(&mut json) == 0 {
        return body;
    }
    serde_json::to_vec(&json).unwrap_or_else(|_| b"{}".to_vec())
}

/// Response headers handed to the webview; any other (a `Set-Cookie`, an `X-Auth-Token` …) is dropped (GM-D-3).
pub const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-disposition",
    "retry-after",
    "x-min-supported-version",
];

/// Refusal when the person declines the native "Sign in to …?" confirmation (the UI goes back to the sign-in view).
pub const SIGN_IN_DECLINED: &str = "sign_in_declined";

/// The texts of the native sign-in confirmation and of the "signed in" notification, owned by Rust: the webview only
/// picks the language. The host is shown in full (ASCII, so an IDN look-alike shows as `xn--…`).
pub struct SignInTexts {
    pub title: String,
    pub body: String,
    /// The first, default button (Enter, a stray key press): declines (GM-D2-1).
    pub stay_out: String,
    /// The only button that confirms; never the default.
    pub sign_in: String,
    /// The third button (and Esc / closing): declines.
    pub cancel: String,
}

impl SignInTexts {
    /// Whether the dialog's answer is the "Sign in" button. The default button, Esc, closing the dialog and anything
    /// unknown decline. The dialog has three buttons because the plugin cannot make Cancel the default of two, and
    /// swapping the meaning of OK / Cancel would make Esc (reported as the second button on Linux) confirm.
    pub fn confirmed(&self, answer: &tauri_plugin_dialog::MessageDialogResult) -> bool {
        use tauri_plugin_dialog::MessageDialogResult;
        match answer {
            MessageDialogResult::Custom(label) => {
                *label == self.sign_in && self.sign_in != self.stay_out
            }
            // Only the exact "Sign in" label: a `No`, `Yes`, `Ok` or `Cancel` from a future backend declines (GO-I4).
            _ => false,
        }
    }
}

/// Base and cap of the pause after a declined sign-in (GM-D2-1): 10 s, doubling, at most 5 minutes.
pub const DECLINE_PAUSE: Duration = Duration::from_secs(10);
pub const DECLINE_PAUSE_MAX: Duration = Duration::from_secs(5 * 60);

/// Refusal of `sign_in_begin` while that pause runs (no dialog is shown).
pub const SIGN_IN_WAIT: &str = "sign_in_wait";

/// Refusal of `sign_in_begin` when nobody is at the app (window not focused, no recent input): no dialog, and it does
/// not count as a decline, so a script cannot start the pause for the person's own next sign-in (GO-I3).
pub const SIGN_IN_NOT_PRESENT: &str = "sign_in_not_present";

/// The sign-in dialog is only shown for a person at the app: the main window focused and some keyboard or mouse input
/// in the last [`RECENT_INPUT_SECS`] seconds (an OS that cannot tell reports 0). Otherwise it is declined unseen.
pub const RECENT_INPUT_SECS: u64 = 30;

pub fn person_at_the_app(focused: bool, idle_seconds: u64) -> bool {
    focused && idle_seconds <= RECENT_INPUT_SECS
}

fn spanish(locale: Option<&str>) -> bool {
    locale.is_some_and(|lang| lang.to_ascii_lowercase().starts_with("es"))
}

/// The dialog texts for `server`. `official` is the official Beacon host of this build (the first host of the shipped
/// pin set): any other host gets a "This is not <official>" line (GM-D2-2), against look-alikes such as
/// `beacon.nowo.tech.example`.
pub fn confirm_texts(
    server: &url::Url,
    locale: Option<&str>,
    official: Option<&str>,
) -> SignInTexts {
    let host = server.host_str().unwrap_or_default();
    let origin = server.origin().ascii_serialization();
    let other = official.filter(|official| !host.eq_ignore_ascii_case(official));
    if spanish(locale) {
        let warning = other
            .map(|official| format!("\n\nEste servidor no es {official}."))
            .unwrap_or_default();
        SignInTexts {
            title: format!("¿Iniciar sesión en {host}?"),
            body: format!("Beacon Desktop va a iniciar sesión en {origin} y guardará la sesión en el llavero de este equipo.{warning}\n\nSi no acabas de pedir iniciar sesión en este servidor, elige Cancelar."),
            stay_out: "Cancelar".into(),
            sign_in: "Iniciar sesión".into(),
            cancel: "Ahora no".into(),
        }
    } else {
        let warning = other
            .map(|official| format!("\n\nThis is not {official}."))
            .unwrap_or_default();
        SignInTexts {
            title: format!("Sign in to {host}?"),
            body: format!("Beacon Desktop is about to sign in to {origin} and keep the session in this computer's keychain.{warning}\n\nIf you did not just ask to sign in to this server, choose Cancel."),
            stay_out: "Cancel".into(),
            sign_in: "Sign in".into(),
            cancel: "Not now".into(),
        }
    }
}

/// The notification after every stored sign-in: `(title, body)`.
pub fn signed_in_notice(origin: &str, spanish: bool) -> (String, String) {
    if spanish {
        (
            "Beacon Desktop ha iniciado sesión".into(),
            format!("Sesión iniciada en {origin}. Si no has sido tú, cierra sesión en Beacon Desktop y revoca este dispositivo en Beacon (Cuenta → Seguridad)."),
        )
    } else {
        (
            "Beacon Desktop signed in".into(),
            format!("Signed in to {origin}. If this was not you, sign out in Beacon Desktop and revoke this device in Beacon (Account → Security)."),
        )
    }
}

#[derive(Clone)]
struct Pending {
    origin: url::Origin,
    at: Instant,
    spanish: bool,
}

#[derive(Default)]
struct State {
    /// The keychain was read (`stored` is then what it holds).
    loaded: bool,
    stored: Option<Stored>,
    bound: Option<url::Origin>,
    /// Path of the bound server URL without the trailing slash (`""` at the root): chat routes are anchored to it.
    base: String,
    /// The sign-in `sign_in_begin` started (and the person confirmed).
    sign_in: Option<Pending>,
    /// The chat keychain entry was read (`chat` is then what it holds).
    chat_loaded: bool,
    chat: Option<Stored>,
    /// The "Connect chat" `chat_connect_begin` started.
    chat_connect: Option<Pending>,
}

/// The session of the app (managed by Tauri). Two locks, always taken in this order: `io` serialises every keychain
/// call and every change (so sign-out stays atomic, GM-L3), `state` guards the in-memory copy and is held only for
/// short, non-blocking reads and writes, never across a keychain call or a prompt (GM-D-4).
pub struct Session {
    store: Box<dyn TokenStore>,
    /// The chat token's entry (`chat-token`).
    chat_store: Box<dyn TokenStore>,
    io: Mutex<()>,
    state: Mutex<State>,
    sign_in_window: Duration,
    /// Declines in a row and when the next dialog may be shown (GM-D2-1). Kept apart from `state`, so sign-out (which
    /// a script can call) never resets it.
    declines: Mutex<Declines>,
    decline_pause: Duration,
    /// Where the pause is kept across restarts (GO-I2): `sign-in-pause.json` in the app data folder.
    declines_file: Option<PathBuf>,
    /// The wall clock the pause is measured with (`SystemTime::now`; a fake one in tests, so they never sleep).
    clock: Arc<dyn Fn() -> SystemTime + Send + Sync>,
}

#[derive(Default, Debug, PartialEq, Eq)]
struct Declines {
    count: u32,
    until: Option<SystemTime>,
}

/// Declines in a row are capped (the pause is capped long before).
const MAX_DECLINES: u32 = 32;

impl Declines {
    fn encode(&self) -> String {
        let until = self
            .until
            .and_then(|until| until.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as u64);
        serde_json::json!({"count": self.count, "until": until}).to_string()
    }

    /// A saved pause; anything malformed, or ending further away than the longest pause, is ignored.
    fn decode(text: &str, now: SystemTime, longest: Duration) -> Self {
        let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let count = saved
            .get("count")
            .and_then(Value::as_u64)
            .map_or(0, |count| count.min(MAX_DECLINES as u64) as u32);
        let until = saved
            .get("until")
            .and_then(Value::as_u64)
            .map(|ms| UNIX_EPOCH + Duration::from_millis(ms))
            .filter(|until| *until <= now + longest);
        Self { count, until }
    }
}

/// The pause after the `count`-th decline in a row: `base`, doubling, at most [`DECLINE_PAUSE_MAX`] scaled like `base`.
pub fn decline_pause(base: Duration, count: u32) -> Duration {
    let cap = base * (DECLINE_PAUSE_MAX.as_secs() / DECLINE_PAUSE.as_secs()) as u32;
    base.saturating_mul(1u32 << count.saturating_sub(1).min(16))
        .min(cap)
}

/// Whether a pause ending at `until` still runs at `now`. A pause longer than `longest` from now (the clock was set
/// back after the decline) counts as over, so a rolled-back clock cannot stretch it (audit GO-D-1).
pub fn pause_running(until: SystemTime, now: SystemTime, longest: Duration) -> bool {
    until
        .duration_since(now)
        .is_ok_and(|left| !left.is_zero() && left <= longest)
}

/// What an authenticated request gets.
pub enum Authorization {
    Bearer(HeaderValue),
    /// No token for this origin: the UI gets 401 and nothing is sent.
    None,
}

/// A sign-in answer after [`Session::capture`]: the body for the UI and, when a token was stored, its origin and the
/// language of the notification.
pub struct Captured {
    pub body: Vec<u8>,
    pub stored_for: Option<(String, bool)>,
    /// A chat token was stored ("Connect chat"): its origin and the notification language.
    pub chat_stored_for: Option<(String, bool)>,
}

/// Refusal of "Connect chat" without a time session for the bound server.
pub const CHAT_NEEDS_SIGN_IN: &str = "sign in first";
/// Refusal of "Connect chat" while a chat token is stored.
pub const CHAT_ALREADY_CONNECTED: &str = "chat already connected: disconnect first";

/// The chat entry of a build without a keychain in tests: memory only (the real one in the app).
fn default_chat_store() -> Box<dyn TokenStore> {
    #[cfg(not(test))]
    {
        Box::new(Keychain::chat())
    }
    #[cfg(test)]
    {
        Box::new(tests::MemoryStore::default())
    }
}

const UNAVAILABLE: &str = "session state unavailable";

impl Session {
    pub fn new(store: Box<dyn TokenStore>) -> Self {
        Self::with_window(store, SIGN_IN_WINDOW)
    }

    pub fn with_window(store: Box<dyn TokenStore>, sign_in_window: Duration) -> Self {
        Self::with_timing(store, sign_in_window, DECLINE_PAUSE)
    }

    pub fn with_timing(
        store: Box<dyn TokenStore>,
        sign_in_window: Duration,
        decline_pause: Duration,
    ) -> Self {
        Self {
            store,
            chat_store: default_chat_store(),
            io: Mutex::new(()),
            state: Mutex::new(State::default()),
            sign_in_window,
            declines: Mutex::new(Declines::default()),
            decline_pause,
            declines_file: None,
            clock: Arc::new(SystemTime::now),
        }
    }

    /// Keeps the chat token in `store` (the app: [`Keychain::chat`], the default outside tests).
    pub fn with_chat_store(mut self, store: Box<dyn TokenStore>) -> Self {
        self.chat_store = store;
        self
    }

    /// Measures the pause with `clock` instead of the system clock (set it before [`Self::with_declines_file`]).
    #[cfg(test)]
    fn with_clock(mut self, clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    fn now(&self) -> SystemTime {
        (self.clock)()
    }

    /// Keeps the pause after a decline in `path` (read now, written on every change), so a restart does not end it.
    pub fn with_declines_file(mut self, path: PathBuf) -> Self {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let longest = decline_pause(self.decline_pause, MAX_DECLINES);
            *self
                .declines
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner) =
                Declines::decode(&text, self.now(), longest);
        }
        self.declines_file = Some(path);
        self
    }

    fn save_declines(&self, declines: &Declines) {
        if let Some(path) = &self.declines_file {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, declines.encode());
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, State>, String> {
        self.state.lock().map_err(|_| UNAVAILABLE.to_string())
    }

    fn io(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.io.lock().map_err(|_| UNAVAILABLE.to_string())
    }

    /// Reads the keychain once; the caller holds `io`. A keychain error is returned, never ignored.
    fn load_locked(&self) -> Result<(), String> {
        if self.lock()?.loaded {
            return Ok(());
        }
        let stored = self.store.read()?;
        let mut state = self.lock()?;
        state.stored = stored;
        state.loaded = true;
        Ok(())
    }

    /// The stored session, read from the keychain on first use (under `io` only).
    fn current(&self) -> Result<Option<Stored>, String> {
        {
            let state = self.lock()?;
            if state.loaded {
                return Ok(state.stored.clone());
            }
        }
        let _io = self.io()?;
        self.load_locked()?;
        Ok(self.lock()?.stored.clone())
    }

    /// Reads the chat entry once; the caller holds `io`.
    fn load_chat_locked(&self) -> Result<(), String> {
        if self.lock()?.chat_loaded {
            return Ok(());
        }
        let chat = self.chat_store.read()?;
        let mut state = self.lock()?;
        state.chat = chat;
        state.chat_loaded = true;
        Ok(())
    }

    /// The stored chat token, read from the keychain on first use.
    fn current_chat(&self) -> Result<Option<Stored>, String> {
        {
            let state = self.lock()?;
            if state.chat_loaded {
                return Ok(state.chat.clone());
            }
        }
        let _io = self.io()?;
        self.load_chat_locked()?;
        Ok(self.lock()?.chat.clone())
    }

    /// Whether a chat token is stored for the time token's origin (`chat_status`). Never the token.
    pub fn chat_connected(&self) -> Result<bool, String> {
        let time = self.current()?;
        let chat = self.current_chat()?;
        Ok(match (time, chat) {
            (Some(time), Some(chat)) => time.origin.is_some() && time.origin == chat.origin,
            _ => false,
        })
    }

    /// Starts "Connect chat" (BD-2): only with the time token stored for the bound origin, no chat token, and a person
    /// at the app. The next 2xx `chat` answer of `device/token` from that origin (within the window) is stored.
    pub fn begin_chat_connect(&self, present: bool, locale: Option<&str>) -> Result<(), String> {
        if !present {
            return Err(SIGN_IN_NOT_PRESENT.into());
        }
        let _io = self.io()?;
        self.load_locked()?;
        self.load_chat_locked()?;
        let mut state = self.lock()?;
        let Some(bound) = state.bound.clone() else {
            return Err(CHAT_NEEDS_SIGN_IN.into());
        };
        let owner = state
            .stored
            .as_ref()
            .and_then(|stored| stored.origin.clone());
        if owner.as_deref() != Some(bound.ascii_serialization().as_str()) {
            return Err(CHAT_NEEDS_SIGN_IN.into());
        }
        if state.chat.is_some() {
            return Err(CHAT_ALREADY_CONNECTED.into());
        }
        let spanish = spanish(locale);
        state.chat_connect = Some(Pending {
            origin: bound,
            at: Instant::now(),
            spanish,
        });
        Ok(())
    }

    /// "Disconnect chat": deletes the chat entry only (first), then forgets it. On failure nothing changes.
    pub fn disconnect_chat(&self) -> Result<(), String> {
        let _io = self.io.lock().unwrap_or_else(PoisonError::into_inner);
        self.io.clear_poison();
        self.chat_store.delete()?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.chat = None;
        state.chat_loaded = true;
        state.chat_connect = None;
        drop(state);
        self.state.clear_poison();
        Ok(())
    }

    /// The chat token for a request to `url` (the realtime client, realtime.rs): only a chat route of the chat token's
    /// own origin, which must also be the bound one.
    pub fn chat_bearer_for(&self, url: &url::Url) -> Result<Option<HeaderValue>, String> {
        if self.route(url)? != Route::Chat || self.bound_origin() != Some(url.origin()) {
            return Ok(None);
        }
        let origin = url.origin().ascii_serialization();
        match self.current_chat()? {
            Some(Stored {
                origin: Some(owner),
                token,
                ..
            }) if owner == origin => Ok(Some(bearer(&token)?)),
            _ => Ok(None),
        }
    }

    /// The route of `url` against the bound server's base path.
    pub fn route(&self, url: &url::Url) -> Result<Route, String> {
        Ok(route_of(url, &self.lock()?.base))
    }

    /// Whether `url` is the reaction route of the bound server's chat API ([`is_reaction_path`]).
    pub fn is_reaction_route(&self, url: &url::Url) -> Result<bool, String> {
        Ok(is_reaction_path(url, &self.lock()?.base))
    }

    /// Whether a token is stored (`secret_status`). A keychain that cannot be read is an error.
    pub fn signed_in(&self) -> Result<bool, String> {
        Ok(self.current()?.is_some())
    }

    pub fn bound_origin(&self) -> Option<url::Origin> {
        self.lock().ok().and_then(|state| state.bound.clone())
    }

    /// Binds `server` (start-up, or no session). While a token is stored, only its origin; a 0.5.1 token without one
    /// adopts this origin (trust on first use) and the entry is rewritten. While a chat token is stored, only the base
    /// path it was stored under (ZBZ-v-I1: the webview cannot move the chat-route anchor); a 0.10.0 chat entry without
    /// one adopts this base path the same way.
    pub fn bind(&self, server: &url::Url) -> Result<(), String> {
        let origin = server.origin();
        let serialised = origin.ascii_serialization();
        let base = base_path(server);
        let _io = self.io()?;
        self.load_locked()?;
        // An unreadable chat entry does not block the time binding: the chat token is then never used either
        // (`chat_bearer_for` reads it again and fails closed).
        let chat = match self.load_chat_locked() {
            Ok(()) => self.lock()?.chat.clone(),
            Err(_) => None,
        };
        match chat {
            Some(Stored {
                base: Some(stored_base),
                ..
            }) if stored_base != base => return Err(CHAT_BOUND_ELSEWHERE.into()),
            Some(Stored {
                origin: Some(owner),
                token,
                base: None,
            }) if owner == serialised => {
                let adopted = Stored {
                    origin: Some(owner),
                    token,
                    base: Some(base.clone()),
                };
                self.chat_store.write(&adopted)?;
                self.lock()?.chat = Some(adopted);
            }
            _ => {}
        }
        let stored = self.lock()?.stored.clone();
        match stored {
            Some(Stored {
                origin: Some(owner),
                ..
            }) if owner != serialised => return Err(SIGNED_IN_ELSEWHERE.into()),
            Some(Stored {
                origin: None,
                token,
                ..
            }) => {
                let adopted = Stored {
                    origin: Some(serialised),
                    token,
                    base: None,
                };
                self.store.write(&adopted)?;
                self.lock()?.stored = Some(adopted);
            }
            _ => {}
        }
        let mut state = self.lock()?;
        state.bound = Some(origin);
        state.base = base;
        Ok(())
    }

    /// Starts a sign-in to `server`: refused while a token is stored; then `confirm` (the native "Sign in to …?"
    /// dialog, no lock held while it is open) must say yes (GM-D-1); then binds the server and allows one capture.
    pub fn begin_sign_in(
        &self,
        server: &url::Url,
        locale: Option<&str>,
        present: bool,
        confirm: impl FnOnce() -> bool,
    ) -> Result<(), String> {
        if self.current()?.is_some() {
            return Err(ALREADY_SIGNED_IN.into());
        }
        // Nobody at the app: no dialog, and no pause either (GO-I3).
        if !present {
            return Err(SIGN_IN_NOT_PRESENT.into());
        }
        // Declined recently: no dialog until the pause ends (a script cannot re-raise it in a loop).
        {
            let declines = self.declines.lock().map_err(|_| UNAVAILABLE.to_string())?;
            let longest = decline_pause(self.decline_pause, MAX_DECLINES);
            if declines
                .until
                .is_some_and(|until| pause_running(until, self.now(), longest))
            {
                return Err(SIGN_IN_WAIT.into());
            }
        }
        let confirmed = confirm();
        {
            let mut declines = self.declines.lock().map_err(|_| UNAVAILABLE.to_string())?;
            if confirmed {
                *declines = Declines::default();
            } else {
                declines.count = (declines.count + 1).min(MAX_DECLINES);
                declines.until =
                    Some(self.now() + decline_pause(self.decline_pause, declines.count));
            }
            self.save_declines(&declines);
        }
        if !confirmed {
            return Err(SIGN_IN_DECLINED.into());
        }
        let _io = self.io()?;
        self.load_locked()?;
        let mut state = self.lock()?;
        if state.stored.is_some() {
            return Err(ALREADY_SIGNED_IN.into());
        }
        let origin = server.origin();
        state.bound = Some(origin.clone());
        state.base = base_path(server);
        state.sign_in = Some(Pending {
            origin,
            at: Instant::now(),
            spanish: spanish(locale),
        });
        Ok(())
    }

    /// The `Authorization` for a request to `url`: only the stored token's own origin gets it.
    pub fn authorization_for(&self, url: &url::Url) -> Result<Authorization, String> {
        // Chat routes get the chat token or nothing; the time token never goes there (R3). A route that only looks
        // like a chat route gets nothing at all (ZBZ-L1).
        match self.route(url)? {
            Route::Chat => {
                return Ok(match self.chat_bearer_for(url)? {
                    Some(value) => Authorization::Bearer(value),
                    None => Authorization::None,
                })
            }
            Route::Neither => return Ok(Authorization::None),
            Route::Time => {}
        }
        let origin = url.origin().ascii_serialization();
        match self.current()? {
            Some(Stored {
                origin: Some(owner),
                token,
                ..
            }) if owner == origin => Ok(Authorization::Bearer(bearer(&token)?)),
            _ => Ok(Authorization::None),
        }
    }

    /// A 2xx answer to a sign-in route of `url`'s origin: stores its token when the person started and confirmed that
    /// sign-in and no token is stored, and puts [`SESSION_HANDLE`] in its place. Otherwise nothing is stored and the
    /// token is scrubbed like any other answer. A non-object answer becomes `{}`.
    pub fn capture(&self, url: &url::Url, body: &[u8]) -> Result<Captured, String> {
        let Some(mut answer @ Value::Object(_)) = parse_json(body) else {
            return Ok(Captured {
                body: b"{}".to_vec(),
                stored_for: None,
                chat_stored_for: None,
            });
        };
        let token = answer
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string);
        let origin = url.origin();
        let family = Family::of(&answer);
        let mut stored_for = None;
        let mut chat_stored_for = None;
        if let (Some(token), Family::Chat) = (token.clone(), family) {
            chat_stored_for = self.capture_chat(&origin, token)?;
        }
        if let (Some(token), Family::Time) = (token, family) {
            let _io = self.io()?;
            self.load_locked()?;
            let pending = {
                let state = self.lock()?;
                state.sign_in.clone().filter(|pending| {
                    pending.origin == origin
                        && pending.at.elapsed() <= self.sign_in_window
                        && state.stored.is_none()
                })
            };
            if let Some(pending) = pending {
                let stored = Stored {
                    origin: Some(origin.ascii_serialization()),
                    token,
                    base: None,
                };
                self.store.write(&stored)?;
                let mut state = self.lock()?;
                state.stored = Some(stored);
                state.sign_in = None;
                stored_for = Some((origin.ascii_serialization(), pending.spanish));
            }
        }
        scrub_value(&mut answer);
        if stored_for.is_some() || chat_stored_for.is_some() {
            answer["token"] = Value::String(SESSION_HANDLE.into());
        }
        let body =
            serde_json::to_vec(&answer).map_err(|_| "invalid sign-in response".to_string())?;
        Ok(Captured {
            body,
            stored_for,
            chat_stored_for,
        })
    }

    /// A `chat` answer: stored in the chat entry when "Connect chat" was started for this origin (within the window),
    /// no chat token is stored, and the time token belongs to the same origin.
    fn capture_chat(
        &self,
        origin: &url::Origin,
        token: String,
    ) -> Result<Option<(String, bool)>, String> {
        let _io = self.io()?;
        self.load_locked()?;
        self.load_chat_locked()?;
        let pending = {
            let state = self.lock()?;
            let serialised = origin.ascii_serialization();
            let time_here = state
                .stored
                .as_ref()
                .is_some_and(|stored| stored.origin.as_deref() == Some(serialised.as_str()));
            state
                .chat_connect
                .clone()
                .filter(|pending| {
                    pending.origin == *origin
                        && pending.at.elapsed() <= self.sign_in_window
                        && state.chat.is_none()
                        && time_here
                })
                .map(|pending| (pending, state.base.clone()))
        };
        let Some((pending, base)) = pending else {
            return Ok(None);
        };
        let stored = Stored {
            origin: Some(origin.ascii_serialization()),
            token,
            base: Some(base),
        };
        self.chat_store.write(&stored)?;
        let mut state = self.lock()?;
        state.chat = Some(stored);
        state.chat_loaded = true;
        state.chat_connect = None;
        Ok(Some((origin.ascii_serialization(), pending.spanish)))
    }

    /// Signs out locally: deletes the keychain entry first; only then forgets the token, the binding and any pending
    /// sign-in. On failure nothing changes and the error is returned. A poisoned lock is recovered (and cleared), so
    /// sign-out always works (GM-D-4).
    pub fn sign_out(&self) -> Result<(), String> {
        let _io = self.io.lock().unwrap_or_else(PoisonError::into_inner);
        self.io.clear_poison();
        // The chat token first (BD-2): a time sign-out never leaves a chat token behind.
        self.chat_store.delete()?;
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.chat = None;
            state.chat_loaded = true;
            state.chat_connect = None;
        }
        self.store.delete()?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        *state = State {
            loaded: true,
            chat_loaded: true,
            ..State::default()
        };
        drop(state);
        self.state.clear_poison();
        Ok(())
    }
}

/// The path of a server URL without its trailing slash (`""` at the root).
fn base_path(server: &url::Url) -> String {
    server.path().trim_end_matches('/').to_string()
}

/// Runs keychain work (and the native dialog) off the async workers and the main thread (GM-D-4).
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "background task failed".to_string())?
}

/// The "signed in" OS notification, from Rust (best effort), after every stored sign-in (GM-D-1).
pub fn notify_signed_in(app: &tauri::AppHandle, origin: &str, spanish: bool) {
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = signed_in_notice(origin, spanish);
    let _ = app.notification().builder().title(title).body(body).show();
}

/// The "chat connected" OS notification, from Rust (best effort), after every stored chat token.
pub fn notify_chat_connected(app: &tauri::AppHandle, origin: &str, spanish: bool) {
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = chat_connected_notice(origin, spanish);
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Title and text of the "chat connected" notification.
pub fn chat_connected_notice(origin: &str, spanish: bool) -> (String, String) {
    if spanish {
        (
            "Chat conectado en Beacon Desktop".into(),
            format!("El chat de {origin} está conectado. Si no fuiste tú, desconecta el chat en Beacon Desktop y revoca este dispositivo en Beacon (Cuenta → Seguridad)."),
        )
    } else {
        (
            "Beacon Desktop chat connected".into(),
            format!("Chat on {origin} is connected. If this was not you, disconnect chat in Beacon Desktop and revoke this device in Beacon (Account → Security)."),
        )
    }
}

/// Whether a chat token is stored for the signed-in server. Never the token itself.
#[tauri::command]
pub async fn chat_status(
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
) -> Result<bool, String> {
    crate::only_from(&window, "main")?;
    let session = Arc::clone(&session);
    blocking(move || session.chat_connected()).await
}

/// Starts "Connect chat": the next `chat` answer of `device/token` from the bound server is stored (see the module
/// docs). Only for a person at the app (read here, in Rust).
#[tauri::command]
pub async fn chat_connect_begin(
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
    locale: Option<String>,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    let present = person_at_the_app(
        window.is_focused().unwrap_or(false),
        crate::read_idle_seconds(),
    );
    let session = Arc::clone(&session);
    blocking(move || session.begin_chat_connect(present, locale.as_deref())).await
}

/// "Disconnect chat": deletes the chat token only (the realtime stream stops with it, realtime.rs).
#[tauri::command]
pub async fn chat_disconnect(
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
    realtime: tauri::State<'_, Arc<crate::realtime::Realtime>>,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    realtime.stop();
    let session = Arc::clone(&session);
    blocking(move || session.disconnect_chat()).await
}

/// Whether a session token is stored (the UI then starts signed in). Never the token itself.
#[tauri::command]
pub async fn secret_status(
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
) -> Result<bool, String> {
    crate::only_from(&window, "main")?;
    let session = Arc::clone(&session);
    blocking(move || session.signed_in()).await
}

/// Starts a sign-in to `server` (before its requests): refused while signed in; asks the person in a native dialog
/// the webview cannot answer ("Sign in to <host>?", `locale` only picks its language); then binds the server, and the
/// next 2xx sign-in answer from it (within [`SIGN_IN_WINDOW`]) is stored in the keychain.
#[tauri::command]
pub async fn sign_in_begin(
    app: tauri::AppHandle,
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
    server: String,
    locale: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    crate::only_from(&window, "main")?;
    let url = crate::net::validate_url(&server)?;
    let session = Arc::clone(&session);
    let pins = crate::pinning::PinSet::shipped();
    let texts = confirm_texts(&url, locale.as_deref(), pins.official_host());
    // Only for a person at the app (GM-D2-1): read here, in Rust, never from the webview.
    let present = person_at_the_app(
        window.is_focused().unwrap_or(false),
        crate::read_idle_seconds(),
    );
    blocking(move || {
        session.begin_sign_in(&url, locale.as_deref(), present, || {
            let mut dialog = app
                .dialog()
                .message(texts.body.clone())
                .title(texts.title.clone())
                .kind(MessageDialogKind::Warning)
                // "Cancel" first: the default button (Enter) declines; only "Sign in" confirms.
                .buttons(MessageDialogButtons::YesNoCancelCustom(
                    texts.stay_out.clone(),
                    texts.sign_in.clone(),
                    texts.cancel.clone(),
                ));
            if let Some(main) = app.get_webview_window("main") {
                dialog = dialog.parent(&main);
            }
            texts.confirmed(&dialog.blocking_show_with_result())
        })
    })
    .await
}

/// Signs out locally: deletes the token, then unbinds the server (net.rs, FY-L1). A keychain that refuses the delete
/// keeps both, and the error is returned.
#[tauri::command]
pub async fn secret_delete(
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
    realtime: tauri::State<'_, Arc<crate::realtime::Realtime>>,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    realtime.stop();
    let session = Arc::clone(&session);
    blocking(move || session.sign_out()).await
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

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
                base: None,
            });
            store
        }

        pub fn legacy(token: &str) -> Self {
            let store = Self::default();
            *store.value.lock().unwrap() = Some(Stored {
                origin: None,
                token: token.into(),
                base: None,
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

    /// A session over `store` (sharing its value), without the pause after a decline (tested on its own).
    pub fn session(store: &MemoryStore) -> Arc<Session> {
        Arc::new(Session::with_timing(
            Box::new(store.clone()),
            SIGN_IN_WINDOW,
            Duration::ZERO,
        ))
    }

    /// `begin_sign_in` with the person pressing "Sign in".
    pub fn begin(session: &Session, server: &str) -> Result<(), String> {
        session.begin_sign_in(&url::Url::parse(server).unwrap(), Some("en"), true, || true)
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

    fn json(captured: Captured) -> Value {
        serde_json::from_slice(&captured.body).unwrap()
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
            base: None,
        };
        assert_eq!(Stored::decode(stored.encode()), stored);
        assert_eq!(
            Stored::decode("bare-0.5.1-token".into()),
            Stored {
                origin: None,
                token: "bare-0.5.1-token".into(),
                base: None,
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
        let mut asked = false;
        // Locked: no binding without knowing the token's origin, no sign-in (nor its dialog), no bearer.
        assert!(session.bind(&url(B)).is_err());
        assert!(session
            .begin_sign_in(&url(B), None, true, || {
                asked = true;
                true
            })
            .is_err());
        assert!(!asked);
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

    // GM-L1, GM-D-1 (device flow only)
    #[test]
    fn the_sign_in_route_is_matched_on_the_decoded_path() {
        let post = reqwest::Method::POST;
        for route in [
            "https://b.example/api/time-track/device/token",
            "https://b.example/beacon/api/time-track/device/token",
            "https://b.example/api/time-track/device/to%6Ben",
            "https://b.example/api/time-track/device%2Ftoken",
        ] {
            assert!(is_sign_in(&post, &url(route)), "{route}");
        }
        for not in [
            "https://b.example/api/time-track/login",
            "https://b.example/api/time-track/%6Cogin",
            "https://b.example/api/time-track/device/code",
            "https://b.example/api/time-track/me",
        ] {
            assert!(!is_sign_in(&post, &url(not)), "{not}");
        }
        assert!(!is_sign_in(
            &reqwest::Method::GET,
            &url("https://b.example/api/time-track/device/token")
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

    // GM-L2, GM-D-1
    #[test]
    fn only_a_confirmed_sign_in_is_captured_and_never_over_a_stored_token() {
        let login = url(&format!("{A}/api/time-track/device/token"));
        // No sign-in started: nothing stored, token scrubbed.
        let store = MemoryStore::default();
        let session = session(&store);
        session.bind(&url(A)).unwrap();
        let out = session.capture(&login, ANSWER).unwrap();
        assert!(out.stored_for.is_none());
        let out = json(out);
        assert_eq!(out["token"], Value::Null);
        assert_eq!(out["scopes"][0], "timer:read");
        assert_eq!(store.stored(), None);
        // Declined in the native dialog: refused, nothing bound for the sign-in, nothing captured.
        assert_eq!(
            session
                .begin_sign_in(&url(B), Some("es"), true, || false)
                .unwrap_err(),
            SIGN_IN_DECLINED
        );
        assert_eq!(session.bound_origin(), Some(url(A).origin()));
        let from_b = url(&format!("{B}/api/time-track/device/token"));
        assert!(session
            .capture(&from_b, ANSWER)
            .unwrap()
            .stored_for
            .is_none());
        // Confirmed for A: stored with A's origin, the handle in its place, a notification (Spanish), only once.
        session
            .begin_sign_in(&url(A), Some("es-ES"), true, || true)
            .unwrap();
        let out = session.capture(&login, ANSWER).unwrap();
        assert_eq!(out.stored_for, Some((A.to_string(), true)));
        assert_eq!(json(out)["token"], SESSION_HANDLE);
        assert_eq!(
            store.stored(),
            Some(Stored {
                origin: Some(A.into()),
                token: "fresh-token".into(),
                base: None,
            })
        );
        let other = br#"{"token":"attacker-token"}"#;
        assert_eq!(
            json(session.capture(&login, other).unwrap())["token"],
            Value::Null
        );
        assert_eq!(store.stored().unwrap().token, "fresh-token");
        // Signed in: no new sign-in (and no dialog) until sign-out.
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || panic!("no dialog while signed in"))
                .unwrap_err(),
            ALREADY_SIGNED_IN
        );
        session.sign_out().unwrap();
        begin(&session, A).unwrap();
        // A sign-in confirmed for A does not capture B's answer.
        assert_eq!(
            json(session.capture(&from_b, ANSWER).unwrap())["token"],
            Value::Null
        );
        assert_eq!(store.stored(), None);
        // Expired sign-in window.
        let late = Session::with_window(Box::new(store.clone()), Duration::ZERO);
        begin(&late, A).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(
            json(late.capture(&login, ANSWER).unwrap())["token"],
            Value::Null
        );
        assert_eq!(store.stored(), None);
        // Not an object: `{}`. A BOM is ignored.
        assert_eq!(
            session.capture(&login, br#"["fresh-token"]"#).unwrap().body,
            b"{}"
        );
        assert_eq!(
            session.capture(&login, b"token=fresh-token").unwrap().body,
            b"{}"
        );
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice(ANSWER);
        let out = session.capture(&login, &bom).unwrap();
        assert_eq!(out.stored_for, Some((A.to_string(), false)));
        assert_eq!(json(out)["token"], SESSION_HANDLE);
    }

    /// A session over a time store and a chat store (both in memory).
    fn chat_session(time: &MemoryStore, chat: &MemoryStore) -> Arc<Session> {
        Arc::new(
            Session::with_timing(Box::new(time.clone()), SIGN_IN_WINDOW, Duration::ZERO)
                .with_chat_store(Box::new(chat.clone())),
        )
    }

    const CHAT_ANSWER: &[u8] =
        br#"{"token":"chat-secret","expiresAt":"2027-01-01T00:00:00Z","scopes":["chat:read"],"scopeFamily":"chat"}"#;

    #[test]
    fn keychain_entries_are_separate_users_of_one_service() {
        assert_eq!(Keychain::time().user, "session-token");
        assert_eq!(Keychain::chat().user, "chat-token");
        assert_eq!(KEYCHAIN_SERVICE, "tech.nowo.time-track-desktop");
    }

    #[test]
    fn chat_routes_get_the_chat_token_only_and_other_routes_the_time_token_only() {
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        assert!(session.chat_connected().unwrap());
        for route in [
            "/api/chat/v1/me",
            "/api/chat/v1/conversations?cursor=x",
            "/api/%63hat/v1/me",
        ] {
            assert_eq!(
                bearer_of(&session, &format!("{A}{route}")).as_deref(),
                Some("Bearer chat-secret"),
                "{route}"
            );
        }
        for route in [
            "/api/time-track/me",
            "/api/time-track/v1/device/code",
            "/api/time-track/chat",
        ] {
            assert_eq!(
                bearer_of(&session, &format!("{A}{route}")).as_deref(),
                Some("Bearer time-secret"),
                "{route}"
            );
        }
        // ZBZ-L1: only the anchored prefix is a chat route; look-alikes get no token at all.
        for route in [
            "/api/time-track/v1/x/api/chat/v1/me",
            "/beacon/api/chat/v1/realtime",
            "/API/chat/v1/me",
            "/api//chat/v1/me",
            "/api/chat/me",
            "/api/chatty/x",
        ] {
            assert_eq!(bearer_of(&session, &format!("{A}{route}")), None, "{route}");
        }
        // Another origin gets neither.
        assert_eq!(bearer_of(&session, &format!("{B}/api/chat/v1/me")), None);
        // Without a chat token, a chat route gets nothing (never the time token).
        session.disconnect_chat().unwrap();
        assert_eq!(chat.stored(), None);
        assert!(!session.chat_connected().unwrap());
        assert_eq!(bearer_of(&session, &format!("{A}/api/chat/v1/me")), None);
        assert_eq!(
            bearer_of(&session, &format!("{A}/api/time-track/me")).as_deref(),
            Some("Bearer time-secret")
        );
        assert_eq!(time.stored().unwrap().token, "time-secret");
    }

    #[test]
    fn chat_routes_are_anchored_to_the_bound_base_path() {
        let based = |path: &str| url(&format!("{A}{path}"));
        assert_eq!(
            route_of(&based("/beacon/api/chat/v1/me"), "/beacon"),
            Route::Chat
        );
        assert_eq!(
            route_of(&based("/api/chat/v1/me"), "/beacon"),
            Route::Neither
        );
        assert_eq!(
            route_of(&based("/beacon/api/time-track/me"), "/beacon"),
            Route::Time
        );
        assert_eq!(
            route_of(&based("/beacon/x/api/chat/v1/me"), "/beacon"),
            Route::Neither
        );
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(&format!("{A}/beacon/"))).unwrap();
        assert_eq!(
            bearer_of(&session, &format!("{A}/beacon/api/chat/v1/me")).as_deref(),
            Some("Bearer chat-secret")
        );
        assert_eq!(bearer_of(&session, &format!("{A}/api/chat/v1/me")), None);
        assert_eq!(
            bearer_of(&session, &format!("{A}/beacon/api/time-track/me")).as_deref(),
            Some("Bearer time-secret")
        );
    }

    #[test]
    fn the_chat_token_keeps_the_base_path_it_was_stored_under() {
        // ZBZ-v-I1: a 0.10.0 chat entry (no base) adopts the first bind's base path, then a rebind elsewhere is refused.
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(&format!("{A}/beacon/"))).unwrap();
        assert_eq!(chat.stored().unwrap().base.as_deref(), Some("/beacon"));
        for elsewhere in ["/api/time-track/v1/x", "/", "/other"] {
            assert_eq!(
                session.bind(&url(&format!("{A}{elsewhere}"))).unwrap_err(),
                CHAT_BOUND_ELSEWHERE,
                "{elsewhere}"
            );
        }
        // Nothing moved: the chat token still goes to the stored base only.
        assert_eq!(
            bearer_of(&session, &format!("{A}/api/time-track/v1/x/api/chat/v1/me")).as_deref(),
            None
        );
        assert_eq!(
            bearer_of(&session, &format!("{A}/beacon/api/chat/v1/me")).as_deref(),
            Some("Bearer chat-secret")
        );
        // The same base again is fine (a restart binds it again).
        session.bind(&url(&format!("{A}/beacon"))).unwrap();
        // A restart reads the stored base: a webview that binds another path first is refused too.
        let restarted = chat_session(&time, &chat);
        assert_eq!(
            restarted.bind(&url(&format!("{A}/x"))).unwrap_err(),
            CHAT_BOUND_ELSEWHERE
        );
        assert!(Stored::decode(chat.stored().unwrap().encode())
            .base
            .is_some());
        // After "Disconnect chat" any base path of the time token's origin can be bound again.
        restarted.disconnect_chat().unwrap();
        restarted.bind(&url(&format!("{A}/x"))).unwrap();
    }

    #[test]
    fn a_chat_token_for_another_origin_is_never_used() {
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(B, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        assert!(!session.chat_connected().unwrap());
        assert_eq!(bearer_of(&session, &format!("{A}/api/chat/v1/me")), None);
        assert_eq!(
            session
                .chat_bearer_for(&url(&format!("{B}/api/chat/v1/me")))
                .unwrap(),
            None
        );
    }

    #[test]
    fn connect_chat_needs_a_time_session_for_the_bound_origin_and_a_person() {
        let (time, chat) = (MemoryStore::default(), MemoryStore::default());
        let session = chat_session(&time, &chat);
        assert_eq!(
            session.begin_chat_connect(true, None).unwrap_err(),
            CHAT_NEEDS_SIGN_IN
        );
        session.bind(&url(A)).unwrap();
        assert_eq!(
            session.begin_chat_connect(true, None).unwrap_err(),
            CHAT_NEEDS_SIGN_IN
        );
        let (time, chat) = (MemoryStore::with(A, "time-secret"), MemoryStore::default());
        let session = chat_session(&time, &chat);
        assert_eq!(
            session.begin_chat_connect(true, None).unwrap_err(),
            CHAT_NEEDS_SIGN_IN
        );
        session.bind(&url(A)).unwrap();
        assert_eq!(
            session.begin_chat_connect(false, None).unwrap_err(),
            SIGN_IN_NOT_PRESENT
        );
        session.begin_chat_connect(true, Some("es")).unwrap();
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        assert_eq!(
            session.begin_chat_connect(true, None).unwrap_err(),
            CHAT_ALREADY_CONNECTED
        );
    }

    #[test]
    fn a_chat_answer_is_stored_in_the_chat_entry_only_after_connect_chat() {
        let token_route = url(&format!("{A}/api/time-track/device/token"));
        let (time, chat) = (MemoryStore::with(A, "time-secret"), MemoryStore::default());
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        // Not started: scrubbed, nothing stored.
        let out = session.capture(&token_route, CHAT_ANSWER).unwrap();
        assert!(out.chat_stored_for.is_none() && out.stored_for.is_none());
        assert_eq!(json(out)["token"], Value::Null);
        assert_eq!(chat.stored(), None);
        // Started: stored in the chat entry with A's origin, the handle in its place, the time entry untouched.
        session.begin_chat_connect(true, Some("es-ES")).unwrap();
        // Another origin's answer is not captured.
        let from_b = url(&format!("{B}/api/time-track/device/token"));
        assert!(session
            .capture(&from_b, CHAT_ANSWER)
            .unwrap()
            .chat_stored_for
            .is_none());
        // A time answer during "Connect chat" never lands anywhere (a time token is stored already).
        let out = session.capture(&token_route, ANSWER).unwrap();
        assert!(out.stored_for.is_none() && out.chat_stored_for.is_none());
        let out = session.capture(&token_route, CHAT_ANSWER).unwrap();
        assert_eq!(out.chat_stored_for, Some((A.to_string(), true)));
        assert!(out.stored_for.is_none());
        let body = json(out);
        assert_eq!(body["token"], SESSION_HANDLE);
        assert_eq!(body["scopeFamily"], "chat");
        assert_eq!(
            chat.stored(),
            Some(Stored {
                origin: Some(A.into()),
                token: "chat-secret".into(),
                base: Some(String::new()),
            })
        );
        assert_eq!(time.stored().unwrap().token, "time-secret");
        // Only once: a second answer is scrubbed and does not replace it.
        let again = br#"{"token":"attacker","scopeFamily":"chat"}"#;
        assert_eq!(
            json(session.capture(&token_route, again).unwrap())["token"],
            Value::Null
        );
        assert_eq!(chat.stored().unwrap().token, "chat-secret");
    }

    #[test]
    fn a_chat_answer_never_becomes_the_time_token_and_unknown_families_are_dropped() {
        let token_route = url(&format!("{A}/api/time-track/device/token"));
        let (time, chat) = (MemoryStore::default(), MemoryStore::default());
        let session = chat_session(&time, &chat);
        begin(&session, A).unwrap();
        // A time sign-in is pending, but the answer is a chat token: not stored as the time token.
        let out = session.capture(&token_route, CHAT_ANSWER).unwrap();
        assert!(out.stored_for.is_none() && out.chat_stored_for.is_none());
        assert_eq!(time.stored(), None);
        assert_eq!(chat.stored(), None);
        for family in [r#""tasks""#, "1", r#"{"x":1}"#] {
            let answer = format!(r#"{{"token":"other-secret","scopeFamily":{family}}}"#);
            let out = session.capture(&token_route, answer.as_bytes()).unwrap();
            assert!(
                out.stored_for.is_none() && out.chat_stored_for.is_none(),
                "{family}"
            );
            assert_eq!(json(out)["token"], Value::Null);
        }
        assert_eq!(time.stored(), None);
        // An explicit `time` family is the time sign-in.
        let time_answer = br#"{"token":"fresh-token","scopeFamily":"time"}"#;
        assert_eq!(
            session
                .capture(&token_route, time_answer)
                .unwrap()
                .stored_for,
            Some((A.to_string(), false))
        );
        assert_eq!(time.stored().unwrap().token, "fresh-token");
    }

    #[test]
    fn an_expired_connect_chat_window_stores_nothing() {
        let token_route = url(&format!("{A}/api/time-track/device/token"));
        let (time, chat) = (MemoryStore::with(A, "time-secret"), MemoryStore::default());
        let session = Arc::new(
            Session::with_timing(Box::new(time.clone()), Duration::ZERO, Duration::ZERO)
                .with_chat_store(Box::new(chat.clone())),
        );
        session.bind(&url(A)).unwrap();
        session.begin_chat_connect(true, None).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert!(session
            .capture(&token_route, CHAT_ANSWER)
            .unwrap()
            .chat_stored_for
            .is_none());
        assert_eq!(chat.stored(), None);
    }

    #[test]
    fn sign_out_deletes_the_chat_token_first_and_both_entries() {
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        // The chat entry cannot be deleted: nothing changes, the error is returned.
        chat.fail_delete.store(true, Ordering::SeqCst);
        assert!(session.sign_out().is_err());
        assert_eq!(time.stored().unwrap().token, "time-secret");
        assert!(session.chat_connected().unwrap());
        chat.fail_delete.store(false, Ordering::SeqCst);
        session.sign_out().unwrap();
        assert_eq!((time.stored(), chat.stored()), (None, None));
        assert!(!session.chat_connected().unwrap());
        assert_eq!(bearer_of(&session, &format!("{A}/api/chat/v1/me")), None);
        // A locked chat keychain makes "Disconnect chat" fail and keeps the token.
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        chat.fail_delete.store(true, Ordering::SeqCst);
        assert!(session.disconnect_chat().is_err());
        assert_eq!(chat.stored().unwrap().token, "chat-secret");
    }

    #[test]
    fn a_locked_chat_keychain_never_blocks_the_time_routes() {
        let (time, chat) = (
            MemoryStore::with(A, "time-secret"),
            MemoryStore::with(A, "chat-secret"),
        );
        chat.fail_read.store(true, Ordering::SeqCst);
        let session = chat_session(&time, &chat);
        session.bind(&url(A)).unwrap();
        assert!(session.signed_in().unwrap());
        assert_eq!(
            bearer_of(&session, &format!("{A}/api/time-track/me")).as_deref(),
            Some("Bearer time-secret")
        );
        assert!(session.chat_connected().is_err());
        assert!(session
            .authorization_for(&url(&format!("{A}/api/chat/v1/me")))
            .is_err());
    }

    #[test]
    fn chat_connected_notice_names_the_host() {
        let (title, body) = chat_connected_notice("https://beacon.example", false);
        assert!(title.contains("chat"));
        assert!(body.contains("https://beacon.example"));
        let (title, body) = chat_connected_notice("https://beacon.example", true);
        assert!(title.contains("Chat"));
        assert!(body.contains("Cuenta"));
    }

    #[test]
    fn the_confirmation_and_the_notification_show_the_host_in_full() {
        let official = Some("beacon.nowo.tech");
        let texts = confirm_texts(
            &url("https://beacon.nowo.tech:8443/x"),
            Some("en-GB"),
            official,
        );
        assert_eq!(texts.title, "Sign in to beacon.nowo.tech?");
        assert!(texts.body.contains("https://beacon.nowo.tech:8443"));
        assert!(!texts.body.contains("This is not"), "{}", texts.body);
        assert_eq!(
            (
                texts.stay_out.as_str(),
                texts.sign_in.as_str(),
                texts.cancel.as_str()
            ),
            ("Cancel", "Sign in", "Not now")
        );
        let es = confirm_texts(&url("https://beacon.nowo.tech"), Some("es"), official);
        assert_eq!(es.title, "¿Iniciar sesión en beacon.nowo.tech?");
        assert_eq!(
            (es.stay_out.as_str(), es.sign_in.as_str()),
            ("Cancelar", "Iniciar sesión")
        );
        // A look-alike (IDN) host is shown as ASCII.
        let idn = confirm_texts(&url("https://bеacon.nowo.tech"), None, official);
        assert!(idn.title.contains("xn--"), "{}", idn.title);
        let (title, body) = signed_in_notice("https://beacon.nowo.tech", false);
        assert_eq!(title, "Beacon Desktop signed in");
        assert!(body.contains("https://beacon.nowo.tech") && body.contains("revoke"));
        assert!(signed_in_notice("https://b.example", true)
            .1
            .contains("revoca"));
    }

    // GM-D2-2
    #[test]
    fn another_host_than_the_official_one_is_named_as_such() {
        let official = PinSetHost::shipped();
        assert_eq!(official.as_deref(), Some("beacon.nowo.tech"));
        let official = official.as_deref();
        for host in [
            "https://beacon.nowo.tech.session-renew.example",
            "https://beacon-nowo.tech",
            "https://self-hosted.example",
        ] {
            let en = confirm_texts(&url(host), None, official);
            assert!(
                en.body.contains("This is not beacon.nowo.tech."),
                "{}",
                en.body
            );
            let es = confirm_texts(&url(host), Some("es"), official);
            assert!(
                es.body.contains("Este servidor no es beacon.nowo.tech."),
                "{}",
                es.body
            );
        }
        assert!(
            !confirm_texts(&url("https://BEACON.nowo.tech"), None, official)
                .body
                .contains("This is not")
        );
        // A build without pins says nothing.
        assert!(!confirm_texts(&url("https://x.example"), None, None)
            .body
            .contains("This is not"));
    }

    /// The official host of the shipped pin set.
    struct PinSetHost;

    impl PinSetHost {
        fn shipped() -> Option<String> {
            crate::pinning::PinSet::shipped()
                .official_host()
                .map(str::to_string)
        }
    }

    // GM-D2-1
    #[test]
    fn only_the_sign_in_button_confirms() {
        use tauri_plugin_dialog::MessageDialogResult;
        let texts = confirm_texts(&url(A), None, None);
        assert!(texts.confirmed(&MessageDialogResult::Custom("Sign in".into())));
        for declined in [
            MessageDialogResult::No,
            MessageDialogResult::Custom("Cancel".into()),
            MessageDialogResult::Custom("Not now".into()),
            MessageDialogResult::Custom("anything".into()),
            MessageDialogResult::Yes,
            MessageDialogResult::Ok,
            MessageDialogResult::Cancel,
        ] {
            assert!(!texts.confirmed(&declined), "{declined:?}");
        }
        // The default (first) button is never the confirming one.
        assert_ne!(texts.stay_out, texts.sign_in);
    }

    #[test]
    fn the_dialog_is_shown_only_to_a_person_at_the_app() {
        assert!(person_at_the_app(true, 0));
        assert!(person_at_the_app(true, RECENT_INPUT_SECS));
        assert!(!person_at_the_app(true, RECENT_INPUT_SECS + 1));
        assert!(!person_at_the_app(false, 0));
    }

    /// A wall clock the test moves by hand: the pause is checked at exact instants, never with real sleeps (a
    /// sleep on a loaded runner, e.g. GitHub's macOS VMs, can overshoot by tens of milliseconds).
    #[derive(Clone)]
    struct FakeClock(Arc<Mutex<SystemTime>>);

    impl FakeClock {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(
                UNIX_EPOCH + Duration::from_secs(1_800_000_000),
            )))
        }

        fn advance(&self, by: Duration) {
            *self.0.lock().unwrap() += by;
        }

        fn reader(&self) -> impl Fn() -> SystemTime + Send + Sync + 'static {
            let at = self.0.clone();
            move || *at.lock().unwrap()
        }
    }

    #[test]
    fn declines_pause_the_dialog_doubling_up_to_five_minutes() {
        let base = DECLINE_PAUSE;
        let pauses: Vec<u64> = (1..=8).map(|n| decline_pause(base, n).as_secs()).collect();
        assert_eq!(pauses, [10, 20, 40, 80, 160, 300, 300, 300]);
        assert_eq!(decline_pause(base, 1000), DECLINE_PAUSE_MAX);
        let store = MemoryStore::default();
        let clock = FakeClock::new();
        let session = Session::with_timing(Box::new(store.clone()), SIGN_IN_WINDOW, DECLINE_PAUSE)
            .with_clock(clock.reader());
        let mut shown = 0;
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || {
                    shown += 1;
                    false
                })
                .unwrap_err(),
            SIGN_IN_DECLINED
        );
        // Raised again at once (a script after `secret_delete`): refused, no dialog. Sign-out does not reset it.
        session.sign_out().unwrap();
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || {
                    shown += 1;
                    true
                })
                .unwrap_err(),
            SIGN_IN_WAIT
        );
        assert_eq!(shown, 1);
        // Still refused a moment before the 10 s end.
        clock.advance(Duration::from_millis(9_999));
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || panic!("no dialog"))
                .unwrap_err(),
            SIGN_IN_WAIT
        );
        clock.advance(Duration::from_millis(1));
        // Second decline: twice as long (20 s).
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || {
                    shown += 1;
                    false
                })
                .unwrap_err(),
            SIGN_IN_DECLINED
        );
        // Past the first pause's length, but not the second's.
        clock.advance(Duration::from_secs(15));
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || panic!("no dialog"))
                .unwrap_err(),
            SIGN_IN_WAIT
        );
        clock.advance(Duration::from_millis(4_999));
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || panic!("no dialog"))
                .unwrap_err(),
            SIGN_IN_WAIT
        );
        clock.advance(Duration::from_millis(1));
        // Confirmed once the 20 s are over: allowed, and the count starts again.
        session
            .begin_sign_in(&url(A), None, true, || {
                shown += 1;
                true
            })
            .unwrap();
        assert_eq!(shown, 3);
        assert_eq!(session.declines.lock().unwrap().count, 0);
    }

    // GO-I3
    #[test]
    fn nobody_at_the_app_is_refused_without_a_dialog_or_a_pause() {
        let store = MemoryStore::default();
        let session = Session::with_timing(
            Box::new(store.clone()),
            SIGN_IN_WINDOW,
            Duration::from_secs(60),
        );
        for _ in 0..5 {
            assert_eq!(
                session
                    .begin_sign_in(&url(A), None, false, || panic!("no dialog"))
                    .unwrap_err(),
                SIGN_IN_NOT_PRESENT
            );
        }
        assert_eq!(*session.declines.lock().unwrap(), Declines::default());
        // The person's own sign-in right after: shown, no wait.
        session.begin_sign_in(&url(A), None, true, || true).unwrap();
    }

    // GO-D-1
    #[test]
    fn a_clock_set_back_cannot_stretch_the_pause() {
        let now = SystemTime::now();
        let longest = DECLINE_PAUSE_MAX;
        assert!(pause_running(now + Duration::from_secs(10), now, longest));
        assert!(pause_running(now + longest, now, longest));
        assert!(!pause_running(
            now + longest + Duration::from_secs(1),
            now,
            longest
        ));
        assert!(!pause_running(now, now, longest));
        assert!(!pause_running(now - Duration::from_secs(1), now, longest));
        // A pause saved before the clock went back an hour: over, and the dialog shows again.
        let store = MemoryStore::default();
        let session = Session::with_timing(Box::new(store), SIGN_IN_WINDOW, DECLINE_PAUSE);
        session.declines.lock().unwrap().until = Some(now + Duration::from_secs(3600));
        session.begin_sign_in(&url(A), None, true, || true).unwrap();
        // Within the longest pause it still holds.
        let store = MemoryStore::default();
        let session = Session::with_timing(Box::new(store), SIGN_IN_WINDOW, DECLINE_PAUSE);
        session.declines.lock().unwrap().until = Some(now + Duration::from_secs(200));
        assert_eq!(
            session
                .begin_sign_in(&url(A), None, true, || panic!("no dialog"))
                .unwrap_err(),
            SIGN_IN_WAIT
        );
    }

    // GO-I2
    #[test]
    fn the_pause_after_a_decline_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!(
            "ttd-sign-in-pause-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = dir.join("sign-in-pause.json");
        let store = MemoryStore::default();
        let first = Session::with_timing(
            Box::new(store.clone()),
            SIGN_IN_WINDOW,
            Duration::from_secs(60),
        )
        .with_declines_file(file.clone());
        assert_eq!(
            first
                .begin_sign_in(&url(A), None, true, || false)
                .unwrap_err(),
            SIGN_IN_DECLINED
        );
        // Restart (process:allow-restart): the pause is still there.
        let again = Session::with_timing(
            Box::new(store.clone()),
            SIGN_IN_WINDOW,
            Duration::from_secs(60),
        )
        .with_declines_file(file.clone());
        assert_eq!(again.declines.lock().unwrap().count, 1);
        assert_eq!(
            again
                .begin_sign_in(&url(A), None, true, || panic!("no dialog"))
                .unwrap_err(),
            SIGN_IN_WAIT
        );
        // A tampered or far-future file is ignored; garbage too.
        let now = SystemTime::now();
        let longest = Duration::from_secs(300);
        let far = (now + Duration::from_secs(10 * 365 * 86_400))
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        assert_eq!(
            Declines::decode(&format!(r#"{{"count":9999,"until":{far}}}"#), now, longest),
            Declines {
                count: MAX_DECLINES,
                until: None
            }
        );
        assert_eq!(
            Declines::decode("not json", now, longest),
            Declines::default()
        );
        let saved = Declines {
            count: 2,
            until: Some(UNIX_EPOCH + Duration::from_millis(1_700_000_000_000)),
        };
        assert_eq!(Declines::decode(&saved.encode(), now, longest), saved);
        let _ = std::fs::remove_dir_all(dir);
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
            let session = session(&store);
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

    // GM-D-4
    #[test]
    fn sign_out_recovers_a_poisoned_lock() {
        let store = MemoryStore::with(A, "secret-token");
        let session = session(&store);
        session.bind(&url(A)).unwrap();
        let poisoner = session.clone();
        let _ = std::thread::spawn(move || {
            let _state = poisoner.state.lock().unwrap();
            let _io = poisoner.io.lock().unwrap();
            panic!("a keyring backend bug");
        })
        .join();
        assert!(session.state.is_poisoned());
        assert_eq!(
            session.signed_in().unwrap_err(),
            UNAVAILABLE,
            "fails closed"
        );
        session.sign_out().unwrap();
        assert_eq!(store.stored(), None);
        assert!(!session.signed_in().unwrap());
        assert_eq!(session.bound_origin(), None);
    }

    #[test]
    fn the_dialog_is_shown_without_holding_the_session() {
        let store = MemoryStore::default();
        let session = session(&store);
        let inner = session.clone();
        begin(&session, A).unwrap();
        session.sign_out().unwrap();
        session
            .begin_sign_in(&url(A), None, true, move || {
                // Other commands (status, the binding, sign-out) still answer while the dialog is open.
                assert!(!inner.signed_in().unwrap());
                assert!(inner.bound_origin().is_none());
                inner.sign_out().unwrap();
                true
            })
            .unwrap();
        assert_eq!(session.bound_origin(), Some(url(A).origin()));
    }

    #[tokio::test]
    async fn keychain_work_runs_off_the_async_workers() {
        let store = MemoryStore::with(A, "secret-token");
        let session = session(&store);
        let worker = std::thread::current().id();
        let (signed_in, thread) =
            blocking(move || Ok((session.signed_in()?, std::thread::current().id())))
                .await
                .unwrap();
        assert!(signed_in);
        assert_ne!(thread, worker);
    }

    // GM-I1, GM-D-3
    #[test]
    fn secret_fields_are_scrubbed_at_any_depth_and_in_any_case() {
        let body = br#"{"data":{"token":"t1","list":[{"access_token":"t2"},{"Refresh_Token":{"x":"t3"}}]},"accessToken":"t4","refreshToken":"t5","SessionToken":"t6","session-token":"t7","token":7,"ok":"token","tokenizer":"keep"}"#;
        let out = String::from_utf8(scrub(body.to_vec())).unwrap();
        for secret in ["t1", "t2", "t3", "t4", "t5", "t6", "t7"] {
            assert!(!out.contains(&format!("\"{secret}\"")), "{secret}: {out}");
        }
        assert!(!out.contains(":7"), "{out}");
        assert!(
            out.contains(r#""ok":"token""#),
            "values named token stay: {out}"
        );
        assert!(out.contains(r#""tokenizer":"keep""#), "{out}");
        // A BOM does not hide the JSON.
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice(br#"{"accessToken":"t8"}"#);
        assert!(!String::from_utf8_lossy(&scrub(bom)).contains("t8"));
        // Nothing to scrub, or not JSON (an export): byte for byte.
        let csv = b"date,token\n2026-01-01,abc".to_vec();
        assert_eq!(scrub(csv.clone()), csv);
        let plain = br#"{"identifier":"ana"}"#.to_vec();
        assert_eq!(scrub(plain.clone()), plain);
    }
}
