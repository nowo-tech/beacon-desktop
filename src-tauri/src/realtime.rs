//! Chat realtime client (BD-2, design §3.3): Mercure over SSE against Beacon's hub, in Rust, so the hub URL and the
//! subscriber JWT never reach the webview.
//!
//! 1. `GET <server>/api/chat/v1/realtime` with the chat token (secret.rs, chat routes only) and the context header.
//!    `enabled: false`, a refusal or a network error → **polling mode** (the UI polls; SSE is tried again later).
//! 2. SSE to `hubUrl?topic=<topic>` with `Authorization: Bearer <JWT>` (header, never the query string). The hub must
//!    be on the bound Beacon origin (same scheme, host and port); the stream goes through the pinned TLS client, with
//!    no redirects.
//! 3. The JWT is refreshed ~2 minutes before `expiresAt`, and the stream reconnects with `Last-Event-ID`.
//! 4. **Events are hints, never data.** Only ids cross to the webview (`chat-hint`: kind, conversation and message
//!    uuids, message id, thread root, deleted flag); every other field of the hub payload (a body, a name, a
//!    reference) is dropped here, whatever the server's `realtime_events` profile. The UI then fetches through the
//!    client API, which applies the reader's permissions and the context (R2).
//! 5. Backoff with jitter on errors (5 s doubling up to 10 min), `Retry-After` honoured (capped at 30 min), and the
//!    mode is reported to the UI (`chat-realtime`: `live`, `polling`, `unauthorized`, `stopped`).
//!
//! Nothing is written to disk and nothing is logged. `chat_realtime_stop`, "Disconnect chat" and sign-out end the
//! stream (a generation counter: an old task stops at its next step).

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CACHE_CONTROL};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use crate::secret::{self, blocking, Session};

/// Path of the realtime ticket under the server URL (ChatKit 2.4 client API v1).
pub const TICKET_PATH: &str = "/api/chat/v1/realtime";
/// Refresh the subscriber JWT this long before it expires.
pub const REFRESH_BEFORE: Duration = Duration::from_secs(120);
/// Bounds of the refresh delay (a far or past `expiresAt` cannot keep a stale token or loop).
pub const REFRESH_MIN: Duration = Duration::from_secs(30);
pub const REFRESH_MAX: Duration = Duration::from_secs(15 * 60);
/// How long the hub may stay silent before the stream is considered dead (Mercure sends heartbeats).
pub const READ_TIMEOUT: Duration = Duration::from_secs(75);
/// Polling mode: try SSE again after this long (design §3.3 point 5).
pub const RETRY_SSE: Duration = Duration::from_secs(10 * 60);
/// Backoff on errors: first wait and cap.
pub const BACKOFF_FIRST: Duration = Duration::from_secs(5);
pub const BACKOFF_MAX: Duration = Duration::from_secs(10 * 60);
/// Longest `Retry-After` honoured (as the UI's `MAX_RETRY_AFTER_SECONDS`).
pub const RETRY_AFTER_MAX: Duration = Duration::from_secs(30 * 60);
/// Longest SSE line kept in memory (a hub that never sends a newline cannot grow the buffer).
pub const MAX_LINE: usize = 256 * 1024;

/// Hint kinds forwarded to the UI; any other event (`typing`, `status`, `prefs`, …) is dropped.
const HINT_KINDS: &[&str] = &[
    "message",
    "message_updated",
    "thread",
    "read",
    "unread",
    "conversation",
];

/// An ids-only hint for the UI (`chat-hint`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

fn uuid_field(event: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    event
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 36
                && value.chars().enumerate().all(|(i, c)| {
                    if matches!(i, 8 | 13 | 18 | 23) {
                        c == '-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                })
        })
        .map(str::to_ascii_lowercase)
}

/// The ids of one hub event (`data:` JSON with `type`), or `None` for anything that is not a known hint.
pub fn hint_of(data: &str) -> Option<Hint> {
    let Value::Object(event) = serde_json::from_str::<Value>(data).ok()? else {
        return None;
    };
    let kind = event.get("type").and_then(Value::as_str)?;
    if !HINT_KINDS.contains(&kind) {
        return None;
    }
    Some(Hint {
        kind: kind.to_string(),
        conversation_uuid: uuid_field(&event, "conversationUuid"),
        message_uuid: uuid_field(&event, "messageUuid"),
        message_id: event.get("messageId").and_then(Value::as_u64),
        root_uuid: uuid_field(&event, "rootUuid").or_else(|| uuid_field(&event, "threadRootUuid")),
        deleted: event.get("deleted").and_then(Value::as_bool),
    })
}

/// One server-sent event.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SseEvent {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

/// An incremental `text/event-stream` parser (WHATWG HTML §9.2): `\n`, `\r\n` and `\r` line ends, comments, `data`
/// lines joined with `\n`, `id` kept for `Last-Event-ID` (never with a NUL).
#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
    event: Option<String>,
    id: Option<String>,
    has_data: bool,
    /// The previous byte was `\r` (a following `\n` is the same line end).
    after_cr: bool,
}

impl SseParser {
    /// Feeds bytes; returns the events they completed. Errors when a line grows past [`MAX_LINE`].
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, String> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.after_cr && byte == b'\n' {
                self.after_cr = false;
                continue;
            }
            self.after_cr = byte == b'\r';
            if byte == b'\n' || byte == b'\r' {
                let line = std::mem::take(&mut self.line);
                if let Some(event) = self.line_end(&String::from_utf8_lossy(&line)) {
                    events.push(event);
                }
            } else {
                if self.line.len() >= MAX_LINE {
                    return Err("event stream line too long".into());
                }
                self.line.push(byte);
            }
        }
        Ok(events)
    }

    fn line_end(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let event = self.has_data.then(|| SseEvent {
                id: self.id.clone(),
                event: self.event.take(),
                data: self.data.join("\n"),
            });
            self.data.clear();
            self.has_data = false;
            self.event = None;
            return event;
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => {
                self.data.push(value.to_string());
                self.has_data = true;
            }
            "event" => self.event = Some(value.to_string()),
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            _ => {}
        }
        None
    }

    /// The last event id seen (`Last-Event-ID` of the next connection).
    pub fn last_id(&self) -> Option<&str> {
        self.id.as_deref().filter(|id| !id.is_empty())
    }
}

/// `GET realtime`'s answer. The subscriber JWT stays here; `Debug` never prints it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub hub_url: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub expires_at: Option<Value>,
}

impl std::fmt::Debug for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ticket")
            .field("enabled", &self.enabled)
            .field("hub_url", &self.hub_url)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix seconds of an RFC 3339 date-time (`2026-11-25T10:15:00Z`, fractions, `±hh:mm`) or of a number (seconds).
pub fn unix_seconds(value: &Value) -> Option<i64> {
    if let Some(seconds) = value.as_i64() {
        return Some(seconds);
    }
    let text = value.as_str()?;
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
    {
        return None;
    }
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.chars().take_while(char::is_ascii_digit).count();
        rest = &fraction[digits..];
    }
    let offset = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) => {
            let hours: i64 = rest[1..3].parse().ok()?;
            let minutes: i64 = rest[4..6].parse().ok()?;
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (hours * 3600 + minutes * 60)
        }
        _ => return None,
    };
    Some(
        days_from_civil(year, month as u32, day as u32) * 86_400
            + hour * 3600
            + minute * 60
            + second
            - offset,
    )
}

/// When to refresh a JWT expiring at `expires_at` (Unix seconds), seen at `now`: [`REFRESH_BEFORE`] earlier, within
/// [`REFRESH_MIN`]..[`REFRESH_MAX`]. Unknown expiry: 13 minutes (the hub's tokens live 15).
pub fn refresh_delay(expires_at: Option<i64>, now: i64) -> Duration {
    let wanted = match expires_at {
        Some(at) => at - now - REFRESH_BEFORE.as_secs() as i64,
        None => 13 * 60,
    };
    Duration::from_secs(wanted.max(0) as u64).clamp(REFRESH_MIN, REFRESH_MAX)
}

/// Exponential backoff with jitter (the factor comes from the caller, 0.0..1.0, so tests are deterministic).
#[derive(Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    pub fn next(&mut self, jitter: f64) -> Duration {
        let base = BACKOFF_FIRST
            .saturating_mul(1u32 << self.failures.min(10))
            .min(BACKOFF_MAX);
        self.failures = self.failures.saturating_add(1);
        // ±20 %, never past the cap.
        base.mul_f64(0.8 + 0.4 * jitter.clamp(0.0, 1.0))
            .min(BACKOFF_MAX)
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

/// The hub URL of a ticket, checked: a valid URL on the bound server's origin (scheme, host, port), no credentials;
/// `topic` added as a query parameter.
pub fn hub_url(hub: &str, topic: &str, server: &url::Url) -> Result<url::Url, String> {
    let mut url = crate::net::validate_url(hub)?;
    if url.origin() != server.origin() {
        return Err("realtime hub outside the signed-in Beacon server".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("invalid realtime hub".into());
    }
    if topic.is_empty() || topic.len() > 512 {
        return Err("invalid realtime topic".into());
    }
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("topic", topic);
    Ok(url)
}

/// A context key as ChatKit accepts it (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`).
pub fn valid_context(context: &str) -> bool {
    let mut chars = context.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && context.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// Where hints and the mode go (the app: Tauri events to the main window; tests: a list).
pub trait Sink: Send + Sync {
    fn hint(&self, hint: Hint);
    fn mode(&self, mode: &str);
}

/// The running stream's generation: starting or stopping bumps it, and an older task ends at its next step.
pub struct Realtime {
    generation: watch::Sender<u64>,
    /// The JWT is never kept here: only the last event id (resumes the stream after a refresh).
    last_event_id: Mutex<Option<String>>,
}

impl Default for Realtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Realtime {
    pub fn new() -> Self {
        Self {
            generation: watch::channel(0).0,
            last_event_id: Mutex::new(None),
        }
    }

    /// A new generation (a new stream); returns it and a receiver to watch for the next one.
    pub fn begin(&self) -> (u64, watch::Receiver<u64>) {
        let mut next = 0;
        self.generation.send_modify(|value| {
            *value += 1;
            next = *value;
        });
        if let Ok(mut last) = self.last_event_id.lock() {
            *last = None;
        }
        (next, self.generation.subscribe())
    }

    /// Ends the running stream (if any).
    pub fn stop(&self) {
        self.generation.send_modify(|value| *value += 1);
    }
}

/// What a step of the loop ended with.
enum Step {
    /// The stream ended for a JWT refresh: reconnect at once.
    Refresh,
    /// Polling mode for this long.
    Wait(Duration),
    /// Stop for good (stopped, disconnected, unauthorized).
    Done,
}

fn jitter() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    f64::from(nanos % 1000) / 1000.0
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let seconds: u64 = headers
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds).min(RETRY_AFTER_MAX))
}

/// Waits `delay`, or less when the generation moves on (then `false`).
async fn wait(delay: Duration, generation: u64, rx: &mut watch::Receiver<u64>) -> bool {
    let mut stop = rx.clone();
    let moved = tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        _ = stop.wait_for(|value| *value != generation) => true,
    };
    !moved && *rx.borrow() == generation
}

/// Fetches a ticket: `None` when there is no chat token for this server (nothing is sent).
async fn ticket(
    client: &reqwest::Client,
    session: &Arc<Session>,
    server: &url::Url,
    context: &str,
) -> Result<Result<Ticket, Step>, String> {
    let base = server.as_str().trim_end_matches('/');
    let url = crate::net::validate_url(&format!("{base}{TICKET_PATH}"))?;
    let (owner, target) = (Arc::clone(session), url.clone());
    let Some(bearer) = blocking(move || owner.chat_bearer_for(&target)).await? else {
        return Ok(Err(Step::Done));
    };
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer);
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-beacon-context",
        HeaderValue::from_str(context).map_err(|_| "invalid context")?,
    );
    let mut response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(crate::net::describe_error)?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Ok(Err(Step::Done));
    }
    if status.as_u16() == 429 {
        return Ok(Err(Step::Wait(
            retry_after(response.headers()).unwrap_or(BACKOFF_FIRST * 12),
        )));
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(crate::net::describe_error)? {
        if body.len() + chunk.len() > 64 * 1024 {
            return Err("response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<Ticket>(&body)
        .map(Ok)
        .map_err(|_| "invalid realtime answer".to_string())
}

/// Streams the hub until a refresh is due, the generation moves on, or an error.
#[allow(clippy::too_many_arguments)]
async fn stream(
    client: &reqwest::Client,
    realtime: &Realtime,
    hub: url::Url,
    jwt: &str,
    refresh_in: Duration,
    sink: &dyn Sink,
    generation: u64,
    rx: &mut watch::Receiver<u64>,
) -> Result<Step, String> {
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, secret::bearer(jwt)?);
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let last = realtime
        .last_event_id
        .lock()
        .ok()
        .and_then(|last| last.clone());
    if let Some(value) = last.and_then(|id| HeaderValue::from_str(&id).ok()) {
        headers.insert("last-event-id", value);
    }
    let mut response = client
        .get(hub)
        .headers(headers)
        .send()
        .await
        .map_err(crate::net::describe_error)?;
    let status = response.status();
    if status.as_u16() == 429 {
        return Ok(Step::Wait(
            retry_after(response.headers()).unwrap_or(BACKOFF_FIRST * 12),
        ));
    }
    let event_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"));
    if !status.is_success() || !event_stream {
        return Err(format!("hub answered HTTP {}", status.as_u16()));
    }
    if *rx.borrow() != generation {
        return Ok(Step::Done);
    }
    sink.mode("live");
    let mut parser = SseParser::default();
    let refresh = tokio::time::sleep(refresh_in);
    tokio::pin!(refresh);
    let mut stop = rx.clone();
    loop {
        tokio::select! {
            _ = &mut refresh => return Ok(Step::Refresh),
            _ = stop.wait_for(|value| *value != generation) => return Ok(Step::Done),
            chunk = tokio::time::timeout(READ_TIMEOUT, response.chunk()) => {
                let chunk = chunk.map_err(|_| "realtime hub silent".to_string())?.map_err(crate::net::describe_error)?;
                let Some(chunk) = chunk else {
                    return Err("realtime stream closed".into());
                };
                for event in parser.push(&chunk)? {
                    if let Some(hint) = hint_of(&event.data) {
                        if *rx.borrow() != generation {
                            return Ok(Step::Done);
                        }
                        sink.hint(hint);
                    }
                }
                if let (Some(id), Ok(mut last)) = (parser.last_id(), realtime.last_event_id.lock()) {
                    *last = Some(id.to_string());
                }
            }
        }
    }
}

/// The stream loop of one generation (see the module docs).
#[allow(clippy::too_many_arguments)]
pub async fn run(
    client: reqwest::Client,
    realtime: Arc<Realtime>,
    session: Arc<Session>,
    server: url::Url,
    context: String,
    sink: Arc<dyn Sink>,
    generation: u64,
    mut rx: watch::Receiver<u64>,
) {
    let mut backoff = Backoff::default();
    loop {
        if *rx.borrow() != generation {
            return;
        }
        let step = match ticket(&client, &session, &server, &context).await {
            Ok(Err(step)) => step,
            Err(_) => Step::Wait(backoff.next(jitter())),
            Ok(Ok(ticket)) => match (
                ticket.enabled,
                ticket.hub_url.as_deref(),
                ticket.token.as_deref(),
                ticket.topic.as_deref(),
            ) {
                (true, Some(hub), Some(jwt), Some(topic)) if !jwt.is_empty() => {
                    match hub_url(hub, topic, &server) {
                        Ok(hub) => {
                            let refresh_in = refresh_delay(
                                ticket.expires_at.as_ref().and_then(unix_seconds),
                                now_secs(),
                            );
                            match stream(
                                &client,
                                &realtime,
                                hub,
                                jwt,
                                refresh_in,
                                sink.as_ref(),
                                generation,
                                &mut rx,
                            )
                            .await
                            {
                                Ok(Step::Refresh) => {
                                    backoff.reset();
                                    Step::Refresh
                                }
                                Ok(step) => step,
                                Err(_) => Step::Wait(backoff.next(jitter())),
                            }
                        }
                        // A hub elsewhere is never contacted: poll, and ask again later.
                        Err(_) => Step::Wait(RETRY_SSE),
                    }
                }
                // The hub is off (or the answer incomplete): bounded polling, SSE again later.
                _ => Step::Wait(RETRY_SSE),
            },
        };
        match step {
            Step::Refresh => continue,
            Step::Done => {
                if *rx.borrow() == generation {
                    sink.mode("unauthorized");
                }
                return;
            }
            Step::Wait(delay) => {
                if *rx.borrow() != generation {
                    return;
                }
                sink.mode("polling");
                if !wait(delay, generation, &mut rx).await {
                    return;
                }
            }
        }
    }
}

/// The client of the stream: the app's pinned TLS configuration, no redirects, no overall timeout (a stream is
/// long-lived), [`READ_TIMEOUT`] between reads.
pub fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(crate::pinning::shipped_client_config())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(READ_TIMEOUT)
        .user_agent(concat!("TimeTrack-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Tauri events to the main window.
struct AppSink(tauri::AppHandle);

impl Sink for AppSink {
    fn hint(&self, hint: Hint) {
        use tauri::Emitter;
        let _ = self.0.emit_to("main", "chat-hint", hint);
    }

    fn mode(&self, mode: &str) {
        use tauri::Emitter;
        let _ = self.0.emit_to("main", "chat-realtime", mode);
    }
}

/// Starts (or restarts) the realtime stream for the bound server and `context`. Only the bound origin; the chat token
/// is read in Rust.
#[tauri::command]
pub async fn chat_realtime_start(
    app: tauri::AppHandle,
    window: tauri::Window,
    session: tauri::State<'_, Arc<Session>>,
    realtime: tauri::State<'_, Arc<Realtime>>,
    server: String,
    context: String,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    let server = crate::net::validate_url(&server)?;
    crate::net::require_origin(session.bound_origin().as_ref(), &server)?;
    if !valid_context(&context) {
        return Err("invalid context".into());
    }
    let client = stream_client()?;
    let (generation, rx) = realtime.begin();
    let sink: Arc<dyn Sink> = Arc::new(AppSink(app));
    tauri::async_runtime::spawn(run(
        client,
        Arc::clone(&realtime),
        Arc::clone(&session),
        server,
        context,
        sink,
        generation,
        rx,
    ));
    Ok(())
}

/// Stops the realtime stream (the chat view is closed or the app leaves chat).
#[tauri::command]
pub fn chat_realtime_stop(
    window: tauri::Window,
    realtime: tauri::State<'_, Arc<Realtime>>,
) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    realtime.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::tests::MemoryStore;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const CONV: &str = "0b9f6f7e-3c55-4a8e-9a54-7f0a1c2d3e4f";
    const MSG: &str = "1c2d3e4f-0b9f-4a8e-9a54-7f0a6f7e3c55";

    #[test]
    fn hints_carry_ids_only() {
        let data = format!(
            r#"{{"type":"message","conversationUuid":"{CONV}","messageUuid":"{MSG}","messageId":42,"deleted":false,"body":"secret text","author":{{"name":"Ana"}},"threadRootUuid":"{MSG}"}}"#
        );
        let hint = hint_of(&data).unwrap();
        assert_eq!(
            hint,
            Hint {
                kind: "message".into(),
                conversation_uuid: Some(CONV.into()),
                message_uuid: Some(MSG.into()),
                message_id: Some(42),
                root_uuid: Some(MSG.into()),
                deleted: Some(false),
            }
        );
        let json = serde_json::to_string(&hint).unwrap();
        assert!(
            !json.contains("secret text") && !json.contains("Ana"),
            "{json}"
        );
        // Unknown kinds, non-objects, malformed uuids.
        assert_eq!(hint_of(r#"{"type":"typing","conversationUuid":"x"}"#), None);
        assert_eq!(hint_of(r#"{"type":"status"}"#), None);
        assert_eq!(hint_of("[1]"), None);
        assert_eq!(hint_of("not json"), None);
        let odd =
            hint_of(r#"{"type":"read","conversationUuid":"../../etc/passwd","messageId":-1}"#)
                .unwrap();
        assert_eq!(odd.conversation_uuid, None);
        assert_eq!(odd.message_id, None);
        let upper = hint_of(&format!(
            r#"{{"type":"thread","conversationUuid":"{}","rootUuid":"{MSG}"}}"#,
            CONV.to_uppercase()
        ))
        .unwrap();
        assert_eq!(upper.conversation_uuid.as_deref(), Some(CONV));
        assert_eq!(upper.root_uuid.as_deref(), Some(MSG));
    }

    #[test]
    fn sse_parser_handles_line_ends_comments_and_ids() {
        let mut parser = SseParser::default();
        let events = parser
            .push(b": heartbeat\n\nid: 7\nevent: update\ndata: {\"a\":1}\ndata: x\r\n\r\nid: 8\rdata:no-space\r\r")
            .unwrap();
        assert_eq!(
            events,
            vec![
                SseEvent {
                    id: Some("7".into()),
                    event: Some("update".into()),
                    data: "{\"a\":1}\nx".into()
                },
                SseEvent {
                    id: Some("8".into()),
                    event: None,
                    data: "no-space".into()
                },
            ]
        );
        assert_eq!(parser.last_id(), Some("8"));
        // Split across chunks, including a \r\n split between two chunks.
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: he").unwrap().is_empty());
        assert!(parser.push(b"llo\r").unwrap().is_empty());
        let events = parser.push(b"\n\n").unwrap();
        assert_eq!(events[0].data, "hello");
        // An id with NUL is ignored; an event without data is not dispatched.
        let mut parser = SseParser::default();
        assert!(parser.push(b"id: a\0b\nevent: x\n\n").unwrap().is_empty());
        assert_eq!(parser.last_id(), None);
        // A line that never ends cannot grow the buffer.
        let mut parser = SseParser::default();
        assert!(parser.push(&vec![b'a'; MAX_LINE + 1]).is_err());
    }

    #[test]
    fn expiry_parsing_and_refresh_window() {
        assert_eq!(unix_seconds(&Value::from("1970-01-01T00:00:00Z")), Some(0));
        assert_eq!(
            unix_seconds(&Value::from("2026-11-25T10:15:00Z")),
            Some(1_795_601_700)
        );
        assert_eq!(
            unix_seconds(&Value::from("2026-11-25T11:15:00.123+01:00")),
            Some(1_795_601_700)
        );
        assert_eq!(
            unix_seconds(&Value::from("2026-11-25T09:15:00-01:00")),
            Some(1_795_601_700)
        );
        assert_eq!(
            unix_seconds(&Value::from(1_795_601_700)),
            Some(1_795_601_700)
        );
        for bad in [
            "",
            "yesterday",
            "2026-13-01T00:00:00Z",
            "2026-11-25T10:15:00",
            "2026-11-25T10:15:00+0100",
        ] {
            assert_eq!(unix_seconds(&Value::from(bad)), None, "{bad}");
        }
        let now = 1_000_000;
        assert_eq!(
            refresh_delay(Some(now + 900), now),
            Duration::from_secs(780)
        );
        assert_eq!(refresh_delay(Some(now + 60), now), REFRESH_MIN);
        assert_eq!(refresh_delay(Some(now - 60), now), REFRESH_MIN);
        assert_eq!(refresh_delay(Some(now + 86_400), now), REFRESH_MAX);
        assert_eq!(refresh_delay(None, now), Duration::from_secs(780));
    }

    #[test]
    fn backoff_doubles_with_jitter_and_caps() {
        let mut backoff = Backoff::default();
        assert_eq!(backoff.next(0.5), Duration::from_secs(5));
        assert_eq!(backoff.next(0.5), Duration::from_secs(10));
        assert_eq!(backoff.next(0.0), Duration::from_secs(16));
        for _ in 0..20 {
            assert!(backoff.next(1.0) <= BACKOFF_MAX);
        }
        backoff.reset();
        assert_eq!(backoff.next(1.0), Duration::from_secs(6));
    }

    #[test]
    fn the_hub_must_be_on_the_bound_origin() {
        let server = url::Url::parse("https://beacon.example/").unwrap();
        let hub = hub_url(
            "https://beacon.example/.well-known/mercure#x",
            "/nowo-chat/users/abc",
            &server,
        )
        .unwrap();
        assert_eq!(
            hub.as_str(),
            "https://beacon.example/.well-known/mercure?topic=%2Fnowo-chat%2Fusers%2Fabc"
        );
        for other in [
            "https://evil.example/.well-known/mercure",
            "https://hub.beacon.example/.well-known/mercure",
            "https://beacon.example:8443/.well-known/mercure",
            "http://beacon.example/.well-known/mercure",
            "https://user:pw@beacon.example/.well-known/mercure",
            "javascript:alert(1)",
        ] {
            assert!(hub_url(other, "t", &server).is_err(), "{other}");
        }
        assert!(hub_url("https://beacon.example/hub", "", &server).is_err());
    }

    #[test]
    fn context_keys_follow_chatkit() {
        for good in [
            "personal",
            "org:0b9f6f7e-3c55-4a8e-9a54-7f0a1c2d3e4f",
            "a",
            "A.b_c-d",
        ] {
            assert!(valid_context(good), "{good}");
        }
        for bad in ["", ":org", "org uuid", "org/x", "ñ", &"a".repeat(129)] {
            assert!(!valid_context(bad), "{bad}");
        }
    }

    #[test]
    fn ticket_debug_never_prints_the_jwt() {
        let ticket: Ticket = serde_json::from_str(
            r#"{"enabled":true,"hubUrl":"https://b/h","token":"jwt-secret","topic":"t"}"#,
        )
        .unwrap();
        assert!(!format!("{ticket:?}").contains("jwt-secret"));
    }

    fn test_client() -> reqwest::Client {
        crate::net::build_client(crate::pinning::shipped_client_config()).unwrap()
    }

    #[derive(Default)]
    struct Collect {
        hints: Mutex<Vec<Hint>>,
        modes: Mutex<Vec<String>>,
    }

    impl Sink for Collect {
        fn hint(&self, hint: Hint) {
            self.hints.lock().unwrap().push(hint);
        }
        fn mode(&self, mode: &str) {
            self.modes.lock().unwrap().push(mode.into());
        }
    }

    /// A one-shot local HTTP server: answers each request with the next canned response and records the requests.
    async fn serve(responses: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap();
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).to_string());
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.flush().await.unwrap();
                // Keep the stream open a moment so the client reads it, then close.
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        });
        (base, seen)
    }

    fn ok_json(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    fn chat_session(base: &str) -> Arc<Session> {
        let time = MemoryStore::with(base, "time-token");
        let chat = MemoryStore::with(base, "chat-token");
        let session = Arc::new(
            Session::with_timing(Box::new(time), secret::SIGN_IN_WINDOW, Duration::ZERO)
                .with_chat_store(Box::new(chat)),
        );
        session.bind(&url::Url::parse(base).unwrap()).unwrap();
        session
    }

    #[tokio::test]
    async fn streams_ids_only_hints_with_the_jwt_in_the_header() {
        // The ticket names the hub on the same origin; the hub sends one event and closes.
        let event = format!(
            r#"{{"type":"message","conversationUuid":"{CONV}","messageUuid":"{MSG}","messageId":9,"body":"hidden"}}"#
        );
        let sse = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n: hi\n\nid: ev-1\ndata: {event}\n\n"
        );
        // The ticket body needs the server's own address: bind first, then fill it in.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let ticket = format!(
            r#"{{"enabled":true,"hubUrl":"{base}/.well-known/mercure","token":"jwt-1","topic":"/nowo-chat/users/u1","expiresAt":"2099-01-01T00:00:00Z"}}"#
        );
        let (served, seen) = serve_at(&base, vec![ok_json(&ticket), sse]).await;
        assert_eq!(served, base);
        let session = chat_session(&base);
        let realtime = Arc::new(Realtime::new());
        let (generation, rx) = realtime.begin();
        let sink = Arc::new(Collect::default());
        let client = test_client();
        let task = tokio::spawn(run(
            client,
            Arc::clone(&realtime),
            session,
            url::Url::parse(&base).unwrap(),
            "org:0b9f6f7e-3c55-4a8e-9a54-7f0a1c2d3e4f".into(),
            sink.clone(),
            generation,
            rx,
        ));
        for _ in 0..50 {
            if !sink.hints.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        realtime.stop();
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        let hints = sink.hints.lock().unwrap().clone();
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].message_id, Some(9));
        assert!(sink.modes.lock().unwrap().contains(&"live".to_string()));
        assert_eq!(
            realtime.last_event_id.lock().unwrap().as_deref(),
            Some("ev-1")
        );
        let requests = seen.lock().unwrap().clone();
        let ticket_request = requests[0].to_ascii_lowercase();
        assert!(
            ticket_request.starts_with("get /api/chat/v1/realtime "),
            "{ticket_request}"
        );
        assert!(ticket_request.contains("authorization: bearer chat-token"));
        assert!(!ticket_request.contains("time-token"));
        assert!(
            ticket_request.contains("x-beacon-context: org:0b9f6f7e-3c55-4a8e-9a54-7f0a1c2d3e4f")
        );
        let hub_request = requests[1].to_ascii_lowercase();
        assert!(
            hub_request.starts_with("get /.well-known/mercure?topic=%2fnowo-chat%2fusers%2fu1 "),
            "{hub_request}"
        );
        assert!(hub_request.contains("authorization: bearer jwt-1"));
        assert!(hub_request.contains("accept: text/event-stream"));
        // Never in the query string (access logs).
        assert!(!hub_request.lines().next().unwrap().contains("jwt"));
    }

    /// `serve` on a given base address (re-binding the port just released).
    async fn serve_at(base: &str, responses: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
        let address = base.trim_start_matches("http://").to_string();
        let listener = tokio::net::TcpListener::bind(&address).await.unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            for response in responses {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });
        (base.to_string(), seen)
    }

    #[tokio::test]
    async fn a_disabled_hub_or_a_foreign_hub_means_polling_and_no_jwt_leaves() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let foreign = r#"{"enabled":true,"hubUrl":"https://evil.example/.well-known/mercure","token":"jwt-x","topic":"t"}"#;
        let (_, seen) = serve_at(&base, vec![ok_json(foreign)]).await;
        let session = chat_session(&base);
        let realtime = Arc::new(Realtime::new());
        let (generation, rx) = realtime.begin();
        let sink = Arc::new(Collect::default());
        let task = tokio::spawn(run(
            test_client(),
            Arc::clone(&realtime),
            session,
            url::Url::parse(&base).unwrap(),
            "personal".into(),
            sink.clone(),
            generation,
            rx,
        ));
        for _ in 0..50 {
            if !sink.modes.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        realtime.stop();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sink.modes.lock().unwrap().as_slice(), ["polling"]);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn without_a_chat_token_nothing_is_sent() {
        let (base, seen) = serve(vec![]).await;
        let time = MemoryStore::with(&base, "time-token");
        let session = Arc::new(Session::with_timing(
            Box::new(time),
            secret::SIGN_IN_WINDOW,
            Duration::ZERO,
        ));
        session.bind(&url::Url::parse(&base).unwrap()).unwrap();
        let realtime = Arc::new(Realtime::new());
        let (generation, rx) = realtime.begin();
        let sink = Arc::new(Collect::default());
        run(
            test_client(),
            realtime,
            session,
            url::Url::parse(&base).unwrap(),
            "personal".into(),
            sink.clone(),
            generation,
            rx,
        )
        .await;
        assert_eq!(sink.modes.lock().unwrap().as_slice(), ["unauthorized"]);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_stale_generation_stops_without_reporting() {
        let realtime = Realtime::new();
        let (generation, mut rx) = realtime.begin();
        realtime.stop();
        assert!(!wait(Duration::from_secs(60), generation, &mut rx).await);
        let (next, mut rx) = realtime.begin();
        assert!(next > generation);
        assert!(wait(Duration::from_millis(1), next, &mut rx).await);
    }
}
