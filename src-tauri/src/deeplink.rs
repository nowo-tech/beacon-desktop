//! Deep links (BD-3b): `beacon-desktop://chat/<conversation uuid>` and `beacon-desktop://tasks/<task id>`, with an
//! optional `?context=personal|org:<uuid>`, open the app on that conversation or task.
//!
//! A link is untrusted input (any web page or program can open one), so it only **navigates**: it is parsed here,
//! strictly, into `{kind, id, context}` (ids and a context key, never text), the main window is shown and the UI is
//! told. The UI checks the id against what the person may see (the API answers `404` otherwise) and switches context
//! through the normal flow (a running timer is asked about first). Nothing is written, sent or opened elsewhere.
//!
//! The OS hands links over through `tauri-plugin-deep-link` (macOS Apple events; Windows and Linux arguments, forwarded
//! by the single-instance plugin to the running app). A link that arrives before the UI listens is kept and taken
//! once with `deep_link_take`.

use std::sync::Mutex;

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

fn is_uuid(s: &str) -> bool {
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

fn is_context(s: &str) -> bool {
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

/// A link that arrived before the UI took it.
#[derive(Default)]
pub struct Pending(Mutex<Option<DeepLink>>);

/// Handles one link from the OS: parsed, kept, the window shown, the UI told. Anything else is dropped silently.
pub fn open(app: &AppHandle, raw: &str) {
    let Some(link) = parse(raw) else {
        return;
    };
    if let Some(pending) = app.try_state::<Pending>() {
        if let Ok(mut slot) = pending.0.lock() {
            *slot = Some(link.clone());
        }
    }
    crate::show_main(app);
    let _ = app.emit_to("main", "deep-link", link);
}

/// The link that arrived before the UI listened (taken once).
#[tauri::command]
pub fn deep_link_take(
    window: tauri::Window,
    pending: tauri::State<'_, Pending>,
) -> Result<Option<DeepLink>, String> {
    crate::only_from(&window, "main")?;
    Ok(pending.0.lock().map_err(|e| e.to_string())?.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str = "0c000000-0000-4000-8000-000000000001";

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
