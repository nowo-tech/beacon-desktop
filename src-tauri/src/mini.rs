//! The mini timer (owner Q2, BD-3a): a small always-on-top window with the running task, its organization, the elapsed
//! time, Start / Stop and "Open Beacon Desktop".
//!
//! Like the "Still there?" prompt (prompt.rs), the main window keeps every decision (`src/shell/shell.ts`): it sends
//! the view (`mini_open` / `mini_update`, already translated) and gets the buttons back (`mini-action` events). The
//! mini window (`index.html?window=mini`) may call `mini_view` and `mini_action` only (capabilities/mini.json): no
//! keychain, network, tray, updater, opener, notification or window permission. There is exactly one; opening it again
//! shows and updates it. Closing it (its own close button, or `Esc`) tells the main window (`closed`).

use std::sync::Mutex;

use serde_json::Value;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Theme, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::prompt::{active_area, Area};

pub const LABEL: &str = "mini";
/// Logical size of the mini timer, fixed (three short lines and a row of two buttons).
pub const WIDTH: f64 = 312.0;
pub const HEIGHT: f64 = 132.0;
/// Gap to the work area's corner, logical pixels.
const MARGIN: f64 = 16.0;
/// Largest view accepted from the main window (serialised), so a bad caller cannot park megabytes in the state.
const MAX_VIEW_BYTES: usize = 8 * 1024;

/// Buttons the mini window may send (anything else is dropped). See `MINI_ACTIONS` in `src/ui/miniWindow.ts`.
const ACTIONS: &[&str] = &["start", "stop", "expand", "close"];

/// Latest view, for a mini window that is still loading (`mini_view`).
#[derive(Default)]
pub struct MiniState {
    view: Mutex<Option<Value>>,
}

/// A view the main window may send: a JSON object of bounded size.
pub fn valid_view(view: &Value) -> bool {
    view.is_object()
        && serde_json::to_vec(view)
            .map(|bytes| bytes.len() <= MAX_VIEW_BYTES)
            .unwrap_or(false)
}

/// The action, if it is one the main window understands (a bare known string).
pub fn valid_action(action: &Value) -> Option<&'static str> {
    let name = action.as_str()?;
    ACTIONS.iter().copied().find(|known| *known == name)
}

/// Top-left corner of a `width` × `height` window (physical pixels) in the top-right corner of `area`, `margin` away
/// from its edges, kept inside it.
pub fn top_right(area: Area, width: u32, height: u32, margin: u32) -> (i32, i32) {
    let x = area.x + area.width.saturating_sub(width.saturating_add(margin)) as i32;
    let y = area.y + margin.min(area.height.saturating_sub(height)) as i32;
    (x, y)
}

fn theme_of(view: &Value) -> Option<Theme> {
    match view.get("theme").and_then(Value::as_str) {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    }
}

fn store(app: &AppHandle, view: &Value) -> Result<(), String> {
    *app.state::<MiniState>()
        .view
        .lock()
        .map_err(|e| e.to_string())? = Some(view.clone());
    Ok(())
}

/// Opens the mini timer with `view` (top-right of the monitor under the pointer), or shows and updates the open one.
#[tauri::command]
pub fn mini_open(app: AppHandle, window: tauri::Window, view: Value) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    if !valid_view(&view) {
        return Err("invalid view".into());
    }
    store(&app, &view)?;
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_theme(theme_of(&view));
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return existing
            .emit_to(LABEL, "mini-view", view)
            .map_err(|e| e.to_string());
    }
    let title = view
        .get("windowTitle")
        .and_then(Value::as_str)
        .unwrap_or(crate::APP_DISPLAY_NAME)
        .chars()
        .take(80)
        .collect::<String>();
    let created = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("index.html?window=mini".into()),
    )
    .title(title)
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(true)
    .visible(false)
    .theme(theme_of(&view))
    // No links in this window: nothing loads but its own page, and no new windows.
    .on_navigation(crate::internal_navigation)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()
    .map_err(|e| e.to_string())?;
    let _ = created.set_size(LogicalSize::new(WIDTH, HEIGHT));
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
    let scale = created.scale_factor().unwrap_or(1.0);
    if let (Some(area), Ok(size)) = (active_area(&areas, cursor), created.outer_size()) {
        let (x, y) = top_right(area, size.width, size.height, (MARGIN * scale) as u32);
        let _ = created.set_position(PhysicalPosition::new(x, y));
    }
    let _ = created.show();
    let _ = created.set_focus();
    Ok(())
}

/// Updates the open mini timer (never opens it): the timer started, stopped, the theme or organization changed.
#[tauri::command]
pub fn mini_update(app: AppHandle, window: tauri::Window, view: Value) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    if !valid_view(&view) {
        return Err("invalid view".into());
    }
    store(&app, &view)?;
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_theme(theme_of(&view));
        existing
            .emit_to(LABEL, "mini-view", view)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Closes the mini timer (the main window's toggle, or sign-out).
#[tauri::command]
pub fn mini_close(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::only_from(&window, "main")?;
    if let Ok(mut view) = app.state::<MiniState>().view.lock() {
        *view = None;
    }
    if let Some(mini) = app.get_webview_window(LABEL) {
        mini.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The view for the mini window (asked once it has loaded; updates follow as `mini-view` events).
#[tauri::command]
pub fn mini_view(app: AppHandle, window: tauri::Window) -> Option<Value> {
    if window.label() != LABEL {
        return None;
    }
    app.state::<MiniState>()
        .view
        .lock()
        .ok()
        .and_then(|view| view.clone())
}

/// A button of the mini window, passed to the main window (which decides). "Open Beacon Desktop" also brings the main
/// window forward from here, so it works while the main window is hidden in the tray.
#[tauri::command]
pub fn mini_action(app: AppHandle, window: tauri::Window, action: Value) -> Result<(), String> {
    crate::only_from(&window, LABEL)?;
    let Some(action) = valid_action(&action) else {
        return Err("not allowed".into());
    };
    if action == "expand" {
        crate::show_main(&app);
    }
    app.emit_to("main", "mini-action", action)
        .map_err(|e| e.to_string())
}

/// The mini window went away (its own close button): the main window updates its toggle.
pub fn closed(app: &AppHandle) {
    if let Ok(mut view) = app.state::<MiniState>().view.lock() {
        *view = None;
    }
    let _ = app.emit_to("main", "mini-action", "closed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SCREEN: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn sits_in_the_top_right_corner_inside_the_work_area() {
        assert_eq!(top_right(SCREEN, 312, 132, 16), (1920 - 312 - 16, 16));
        // A second monitor to the left, at 150 %.
        let left = Area {
            x: -2880,
            y: 0,
            width: 2880,
            height: 1560,
        };
        assert_eq!(top_right(left, 468, 198, 24), (-468 - 24, 24));
        // Smaller than the window: pinned to the area's corner, never off screen.
        let tiny = Area {
            x: 100,
            y: 50,
            width: 200,
            height: 100,
        };
        assert_eq!(top_right(tiny, 312, 132, 16), (100, 50));
    }

    #[test]
    fn only_known_actions_reach_the_main_window() {
        for action in ["start", "stop", "expand", "close"] {
            assert_eq!(valid_action(&json!(action)), Some(action));
        }
        for bad in [
            json!("closed"),
            json!("quit"),
            json!({ "action": "stop" }),
            json!(5),
            json!(null),
        ] {
            assert_eq!(valid_action(&bad), None, "{bad}");
        }
    }

    #[test]
    fn views_are_bounded_objects() {
        assert!(valid_view(
            &json!({ "running": true, "task": "Fix invoice rounding bug", "theme": "dark" })
        ));
        assert!(!valid_view(&json!("view")));
        assert!(!valid_view(&json!([1, 2])));
        assert!(!valid_view(&json!({ "task": "x".repeat(MAX_VIEW_BYTES) })));
    }

    #[test]
    fn theme_follows_the_view() {
        assert_eq!(theme_of(&json!({ "theme": "dark" })), Some(Theme::Dark));
        assert_eq!(theme_of(&json!({ "theme": "light" })), Some(Theme::Light));
        assert_eq!(theme_of(&json!({ "theme": "system" })), None);
    }
}
