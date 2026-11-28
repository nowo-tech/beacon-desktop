//! Deep links (BD-3b): `beacon-desktop://chat/<conversation uuid>` and `beacon-desktop://tasks/<task id>`, with an
//! optional `?context=personal|org:<uuid>`, open the app on that conversation or task.
//!
//! A link is untrusted input (any web page or program can open one), so it only **navigates**: it is parsed here,
//! strictly, into `{kind, id, context}` (ids and a context key, never text), the main window is shown and the UI is
//! told. The UI checks the id against what the person may see (the API answers `404` otherwise) and switches context
//! through the normal flow (a running timer is asked about first). Nothing is written, sent or opened elsewhere.
//!
//! The OS hands links over through `tauri-plugin-deep-link` (macOS Apple events; Windows and Linux arguments, forwarded
//! by the single-instance plugin to the running app).
//!
//! One way in (audit BDA13-L1): a link is kept in [`Pending`] (the latest wins) and the UI gets a `deep-link` event
//! **without payload**; it takes the link with `deep_link_take`, at start-up and on each ping, so a link opens exactly
//! once whether or not the UI was listening. Sign-out forgets a link not taken yet ([`Pending::clear`]).
//!
//! Reloads (0.14.1): a link belongs to the page it was announced to. A link that came while a page of the main window
//! was loaded, and that page never took it (it was not ready: signed out, in the middle of a sign-in), is dropped when
//! the main window loads a page again ([`Pending::page_started`]), so a reload never opens a link from before it. A link
//! that came before the first page (the app was started by it) waits for that page, and belongs to it (BDA141-I1).
//!
//! Focus (BDA13-I1): links raise and focus the main window at most once per [`RAISE_EVERY`]; a burst of links (a page
//! opening many) is coalesced, and the latest one is what the UI takes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const SCHEME: &str = "beacon-desktop";
/// The longest link taken (anything longer is not one of ours).
const MAX_LEN: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeepLink {
    /// `chat` or `task`.
    pub kind: &'static str,
    pub id: String,
    /// `personal` or `org:<uuid>`; the UI ignores a context the person does not have.
    pub context: Option<String>,
}

pub(crate) fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn is_task_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn is_context(s: &str) -> bool {
    s == "personal" || s.strip_prefix("org:").is_some_and(is_uuid)
}

/// The link as `{kind, id, context}`, or `None` for anything that is not exactly one of the two shapes.
pub fn parse(raw: &str) -> Option<DeepLink> {
    // Dot segments would be resolved by the URL parser (`tasks/../x` → `x`): never one of ours.
    if raw.len() > MAX_LEN || raw.contains("/.") {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != SCHEME
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let (kind, id) = match (url.host_str()?, url.path()) {
        ("chat", path) => ("chat", path.strip_prefix('/')?.to_ascii_lowercase()),
        ("tasks", path) => ("task", path.strip_prefix('/')?.to_string()),
        _ => return None,
    };
    let valid = match kind {
        "chat" => is_uuid(&id),
        _ => is_task_id(&id),
    };
    if !valid || url.fragment().is_some() {
        return None;
    }
    let mut context = None;
    for (key, value) in url.query_pairs() {
        if key != "context" || context.is_some() || !is_context(&value) {
            return None;
        }
        context = Some(value.to_ascii_lowercase());
    }
    Some(DeepLink { kind, id, context })
}

/// Links raise the main window at most this often (BDA13-I1).
pub const RAISE_EVERY: Duration = Duration::from_secs(1);

/// Whether a link at `now` may raise the window, the last raise having been at `last`.
pub fn raise_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|at| now.saturating_duration_since(at) >= RAISE_EVERY)
}

/// The link not taken yet by the UI (the latest wins) with the page it was announced to, and when a link last raised
/// the window.
#[derive(Default)]
pub struct Pending {
    link: Mutex<Option<(DeepLink, u64)>>,
    raised: Mutex<Option<Instant>>,
    /// Page loads of the main window so far (0: none yet).
    page: AtomicU64,
}

impl Pending {
    /// Keeps `link` (replacing an older one not taken yet), for the page loaded now.
    pub fn put(&self, link: DeepLink) {
        if let Ok(mut slot) = self.link.lock() {
            *slot = Some((link, self.page.load(Ordering::SeqCst)));
        }
    }

    /// The link, once.
    pub fn take(&self) -> Option<DeepLink> {
        self.link
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
            .map(|(link, _)| link)
    }

    /// The main window starts loading a page (the first one, or a reload): a link announced to an earlier page and not
    /// taken by it is dropped; one that came before any page waits for the first page and is that page's.
    pub fn page_started(&self) {
        let now = self.page.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut slot) = self.link.lock() {
            if matches!(*slot, Some((_, at)) if at.max(1) < now) {
                *slot = None;
            }
        }
    }

    /// Sign-out: a link not taken yet never opens after the next sign-in.
    pub fn clear(&self) {
        let _ = self.take();
    }

    /// Whether this link may raise the window now (at most once per [`RAISE_EVERY`]); records the raise.
    pub fn may_raise(&self, now: Instant) -> bool {
        let Ok(mut last) = self.raised.lock() else {
            return false;
        };
        let due = raise_due(*last, now);
        if due {
            *last = Some(now);
        }
        due
    }
}

/// Handles one link from the OS: parsed, kept, the window shown (rate limited), the UI pinged. Anything else is
/// dropped silently.
pub fn open(app: &AppHandle, raw: &str) {
    let Some(link) = parse(raw) else {
        return;
    };
    let Some(pending) = app.try_state::<Pending>() else {
        return;
    };
    pending.put(link);
    if pending.may_raise(Instant::now()) {
        crate::show_main(app);
    }
    // No payload: the UI takes the link with `deep_link_take` (one way in).
    let _ = app.emit_to("main", "deep-link", ());
}

/// The latest link, taken once (at start-up and on each `deep-link` ping).
#[tauri::command]
pub fn deep_link_take(
    window: tauri::Window,
    pending: tauri::State<'_, Pending>,
) -> Result<Option<DeepLink>, String> {
    crate::only_from(&window, "main")?;
    Ok(pending.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str = "0c000000-0000-4000-8000-000000000001";

    fn link(id: &str) -> DeepLink {
        DeepLink {
            kind: "task",
            id: id.into(),
            context: None,
        }
    }

    #[test]
    fn a_link_is_taken_once_the_latest_wins_and_sign_out_forgets_it() {
        let pending = Pending::default();
        assert_eq!(pending.take(), None);
        pending.put(link("t-1"));
        pending.put(link("t-2"));
        assert_eq!(pending.take(), Some(link("t-2")));
        // Handled once: a later take (a sign-in, a reload) finds nothing (BDA13-L1).
        assert_eq!(pending.take(), None);
        pending.put(link("t-3"));
        pending.clear();
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn a_reload_never_opens_a_link_from_before_it() {
        let pending = Pending::default();
        // The app was started by a link: it waits for the first page, which takes it.
        pending.put(link("t-1"));
        pending.page_started();
        assert_eq!(pending.take(), Some(link("t-1")));
        // A link announced to that page, which was not ready (signed out) and never took it: a reload drops it.
        pending.put(link("t-2"));
        pending.page_started();
        assert_eq!(pending.take(), None);
        // A link that comes while the reloaded page loads is that page's: taken once, then nothing.
        pending.put(link("t-3"));
        assert_eq!(pending.take(), Some(link("t-3")));
        pending.page_started();
        assert_eq!(pending.take(), None);
        // Reloads in a row with a link in between: only the page it was announced to may take it.
        pending.put(link("t-4"));
        pending.page_started();
        pending.page_started();
        assert_eq!(pending.take(), None);
        // A link that started the app and was not taken by the first page (signed out) does not survive a reload.
        let cold = Pending::default();
        cold.put(link("t-5"));
        cold.page_started();
        cold.page_started();
        assert_eq!(cold.take(), None);
    }

    #[test]
    fn links_raise_the_window_at_most_once_a_second() {
        let start = Instant::now();
        assert!(raise_due(None, start));
        assert!(!raise_due(Some(start), start + Duration::from_millis(999)));
        assert!(raise_due(Some(start), start + RAISE_EVERY));
        // A clock going backwards never raises again and again.
        assert!(!raise_due(Some(start + RAISE_EVERY), start));
        let pending = Pending::default();
        assert!(pending.may_raise(start));
        assert!(!pending.may_raise(start + Duration::from_millis(10)));
        assert!(!pending.may_raise(start + Duration::from_millis(990)));
        assert!(pending.may_raise(start + Duration::from_millis(1000)));
    }

    #[test]
    fn only_the_two_shapes_are_links() {
        assert_eq!(
            parse(&format!("beacon-desktop://chat/{C}")),
            Some(DeepLink {
                kind: "chat",
                id: C.into(),
                context: None
            })
        );
        assert_eq!(
            parse(&format!(
                "beacon-desktop://chat/{}?context=org:{C}",
                C.to_uppercase()
            )),
            Some(DeepLink {
                kind: "chat",
                id: C.into(),
                context: Some(format!("org:{C}"))
            })
        );
        assert_eq!(
            parse("beacon-desktop://tasks/t-141?context=personal"),
            Some(DeepLink {
                kind: "task",
                id: "t-141".into(),
                context: Some("personal".into())
            })
        );
        for bad in [
            "https://beacon.example/chat/x".to_string(),
            "beacon-desktop://chat/not-a-uuid".into(),
            format!("beacon-desktop://chat/{C}/extra"),
            format!("beacon-desktop://chat/{C}#frag"),
            format!("beacon-desktop://chat/{C}?context=evil"),
            format!("beacon-desktop://chat/{C}?context=personal&context=personal"),
            format!("beacon-desktop://chat/{C}?send=hello"),
            format!("beacon-desktop://user:pw@chat/{C}"),
            format!("beacon-desktop://chat:8080/{C}"),
            "beacon-desktop://tasks/../x".into(),
            "beacon-desktop://tasks/-x".into(),
            "beacon-desktop://tasks/".into(),
            "beacon-desktop://settings/x".into(),
            "beacon-desktop:chat".into(),
            format!("beacon-desktop://tasks/{}", "a".repeat(600)),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }
}
