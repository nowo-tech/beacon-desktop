//! The "Still there?" prompt as its own small window: always on top, centred on the monitor the person is using,
//! shown even while the main window is hidden in the tray.
//!
//! The main window keeps every decision (`src/ui/app.ts`): it sends the prompt's content (`prompt_open`, already
//! translated) and gets the answers back (`prompt-answer` events). The prompt window (`index.html?window=prompt`)
//! only draws that content and reports which button was pressed. There is exactly one: opening it again updates it.
//! Its close button is refused (the question needs an answer, Esc does not dismiss it either); the main window closes
//! it once it is answered.

use std::sync::Mutex;

use serde_json::Value;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Theme, UserAttentionType,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const LABEL: &str = "prompt";
/// Logical size of the prompt window, fixed (not resizable; the content scrolls if a long translation needs more).
pub const WIDTH: f64 = 440.0;
pub const HEIGHT: f64 = 560.0;

/// Answers the prompt window may send (anything else is dropped). See `PromptAction` in `src/ui/prompt.ts`.
const ACTIONS: &[&str] = &[
    "here",
    "meeting-open",
    "meeting-cancel",
    "meeting-save",
    "discard",
    "pause",
    "resume-now",
    "gap-keep",
    "gap-reassign",
    "gap-discard",
    "reassign-open",
    "reassign-cancel",
    "reassign-search",
    "reassign-save",
    "resume",
    "not-now",
    "escape",
];

/// Latest content, for a prompt window that is still loading (`prompt_view`).
#[derive(Default)]
pub struct PromptState {
    view: Mutex<Option<Value>>,
}

/// A rectangle in physical pixels (a monitor's work area).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Area {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x as f64
            && y >= self.y as f64
            && x < self.x as f64 + self.width as f64
            && y < self.y as f64 + self.height as f64
    }
}

/// The monitor under the pointer (the one the person is using), else the first one (primary first in the list).
pub fn active_area(areas: &[Area], cursor: Option<(f64, f64)>) -> Option<Area> {
    cursor
        .and_then(|(x, y)| areas.iter().find(|area| area.contains(x, y)))
        .or_else(|| areas.first())
        .copied()
}

/// Top-left corner that centres a `width` × `height` window (physical pixels) in `area`, kept inside it.
pub fn centred(area: Area, width: u32, height: u32) -> (i32, i32) {
    let x = area.x + (area.width.saturating_sub(width) / 2) as i32;
    let y = area.y + (area.height.saturating_sub(height) / 2) as i32;
    (x, y)
}

/// The answer, if it is one the main window understands: `{ action, note?, taskId?, query? }` with bounded strings
/// (`query`: the task search of "Reassign", which the main window runs).
pub fn valid_answer(answer: &Value) -> bool {
    let Some(object) = answer.as_object() else {
        return false;
    };
    let action_ok = object
        .get("action")
        .and_then(Value::as_str)
        .is_some_and(|action| ACTIONS.contains(&action));
    let short = |key: &str, max: usize| {
        object.get(key).is_none_or(|value| {
            value.is_null() || value.as_str().is_some_and(|s| s.chars().count() <= max)
        })
    };
    action_ok
        && short("note", 500)
        && short("taskId", 200)
        && short("query", 200)
        && object
            .keys()
            .all(|key| matches!(key.as_str(), "action" | "note" | "taskId" | "query"))
}

fn theme_of(view: &Value) -> Option<Theme> {
    match view.get("theme").and_then(Value::as_str) {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    }
}

/// Puts the prompt in front: centred on the active monitor, focused, and flagged (taskbar flash on Windows, Dock
/// bounce on macOS) in case the OS refuses to give it the focus (Windows focus-stealing prevention).
fn bring_forward(app: &AppHandle, window: &WebviewWindow) {
    let areas: Vec<Area> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let work = monitor.work_area();
            Area {
                x: work.position.x,
                y: work.position.y,
                width: work.size.width,
                height: work.size.height,
            }
        })
        .collect();
    let cursor = app.cursor_position().ok().map(|p| (p.x, p.y));
    if let (Some(area), Ok(size)) = (active_area(&areas, cursor), window.outer_size()) {
        let (x, y) = centred(area, size.width, size.height);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    } else {
        let _ = window.center();
    }
    let _ = window.unminimize();
    let _ = window.show();
    // Re-asserting "always on top" lifts it over a full-screen or other topmost window on Windows.
    let _ = window.set_always_on_top(false);
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));
}

/// Opens the prompt window with `view`, or updates the open one (without moving it or stealing the focus again).
#[tauri::command]
pub fn prompt_open(app: AppHandle, window: tauri::Window, view: Value) -> Result<(), String> {
    if window.label() != "main" {
        return Err("not allowed".into());
    }
    *app.state::<PromptState>()
        .view
        .lock()
        .map_err(|e| e.to_string())? = Some(view.clone());
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_theme(theme_of(&view));
        return existing
            .emit_to(LABEL, "prompt-view", view)
            .map_err(|e| e.to_string());
    }
    let title = view
        .get("windowTitle")
        .and_then(Value::as_str)
        .unwrap_or("TimeTrack")
        .chars()
        .take(80)
        .collect::<String>();
    let created = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("index.html?window=prompt".into()),
    )
    .title(title)
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(false)
    .focused(true)
    .visible(false)
    .theme(theme_of(&view))
    // No links in this window: nothing loads but its own page, and no new windows.
    .on_navigation(crate::internal_navigation)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()
    .map_err(|e| e.to_string())?;
    let _ = created.set_size(LogicalSize::new(WIDTH, HEIGHT));
    bring_forward(&app, &created);
    Ok(())
}

/// The content of the prompt for its window (asked once it has loaded; updates follow as `prompt-view` events).
#[tauri::command]
pub fn prompt_view(app: AppHandle, window: tauri::Window) -> Option<Value> {
    if window.label() != LABEL {
        return None;
    }
    app.state::<PromptState>()
        .view
        .lock()
        .ok()
        .and_then(|view| view.clone())
}

/// An answer from the prompt window, passed to the main window (which decides and then closes the prompt).
#[tauri::command]
pub fn prompt_answer(app: AppHandle, window: tauri::Window, answer: Value) -> Result<(), String> {
    if window.label() != LABEL || !valid_answer(&answer) {
        return Err("not allowed".into());
    }
    app.emit_to("main", "prompt-answer", answer)
        .map_err(|e| e.to_string())
}

/// Brings the open prompt forward again ("Show the question" in the main window).
#[tauri::command]
pub fn prompt_focus(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    if let Some(prompt) = app.get_webview_window(LABEL) {
        bring_forward(&app, &prompt);
    }
    Ok(())
}

/// "Open TimeTrack" in the prompt window: brings the main window forward (the prompt stays until it is answered).
#[tauri::command]
pub fn prompt_show_main(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::only_from(&window, LABEL)?;
    crate::show_main(&app);
    Ok(())
}

/// Closes the prompt (answered, or nothing to ask any more).
#[tauri::command]
pub fn prompt_close(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("not allowed".into());
    }
    if let Ok(mut view) = app.state::<PromptState>().view.lock() {
        *view = None;
    }
    if let Some(prompt) = app.get_webview_window(LABEL) {
        prompt.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LEFT: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    /// A 4K monitor to the right, scaled 150 % (physical pixels), with the taskbar at the bottom.
    const RIGHT: Area = Area {
        x: 1920,
        y: 0,
        width: 3840,
        height: 2088,
    };

    #[test]
    fn picks_the_monitor_under_the_pointer() {
        let areas = [LEFT, RIGHT];
        assert_eq!(active_area(&areas, Some((2500.0, 900.0))), Some(RIGHT));
        assert_eq!(active_area(&areas, Some((10.0, 10.0))), Some(LEFT));
        // Pointer unknown (Wayland) or on no work area (the taskbar): the first monitor.
        assert_eq!(active_area(&areas, None), Some(LEFT));
        assert_eq!(active_area(&areas, Some((100.0, 1070.0))), Some(LEFT));
        assert_eq!(active_area(&[], Some((1.0, 1.0))), None);
    }

    #[test]
    fn centres_inside_the_work_area() {
        assert_eq!(centred(LEFT, 440, 560), (740, 240));
        // 440 × 560 logical at 150 %.
        assert_eq!(centred(RIGHT, 660, 840), (1920 + 1590, 624));
        // Bigger than the area: pinned to its corner, never off screen.
        assert_eq!(
            centred(
                Area {
                    x: -1280,
                    y: 0,
                    width: 400,
                    height: 300
                },
                660,
                840
            ),
            (-1280, 0)
        );
    }

    #[test]
    fn only_known_answers_reach_the_main_window() {
        assert!(valid_answer(&json!({ "action": "here" })));
        assert!(valid_answer(
            &json!({ "action": "meeting-save", "note": "Sprint review", "taskId": "T-1" })
        ));
        assert!(valid_answer(
            &json!({ "action": "gap-reassign", "taskId": "T-2", "note": null })
        ));
        assert!(valid_answer(
            &json!({ "action": "reassign-search", "query": "sprint" })
        ));
        assert!(valid_answer(
            &json!({ "action": "reassign-save", "taskId": "T-9" })
        ));
        assert!(!valid_answer(
            &json!({ "action": "reassign-search", "query": "q".repeat(201) })
        ));
        assert!(!valid_answer(&json!({ "action": "quit" })));
        assert!(!valid_answer(&json!({ "action": "here", "extra": 1 })));
        assert!(!valid_answer(
            &json!({ "action": "here", "note": "x".repeat(501) })
        ));
        assert!(!valid_answer(&json!({ "action": "here", "taskId": 5 })));
        assert!(!valid_answer(&json!("here")));
    }

    #[test]
    fn theme_follows_the_view() {
        assert_eq!(theme_of(&json!({ "theme": "dark" })), Some(Theme::Dark));
        assert_eq!(theme_of(&json!({ "theme": "light" })), Some(Theme::Light));
        assert_eq!(theme_of(&json!({ "theme": null })), None);
    }
}
