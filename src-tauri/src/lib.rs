//! TimeTrack desktop shell: tray, global shortcut, OS keychain, local idle time and the Beacon updater.
//!
//! Privacy by design: nothing here observes the user's activity beyond the OS "seconds since last input" counter,
//! which never leaves the device (the UI only asks the user what to do with an idle period).

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};
use tauri_plugin_http::reqwest;
use tauri_plugin_updater::UpdaterExt;

const KEYCHAIN_SERVICE: &str = "tech.nowo.time-track-desktop";
const KEYCHAIN_USER: &str = "session-token";
const TRAY_ID: &str = "main";
const SHORTCUT: &str = "CommandOrControl+Alt+T";

struct TrayItems {
    status: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}

fn keychain() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

/// Session token from the OS keychain (Keychain / Credential Manager / Secret Service). `None` when absent.
#[tauri::command]
fn secret_get() -> Result<Option<String>, String> {
    match keychain()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(token: String) -> Result<(), String> {
    keychain()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete() -> Result<(), String> {
    match keychain()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Seconds since the last keyboard / mouse input, read locally from the OS. Never sent anywhere.
/// Returns 0 when the platform cannot tell (e.g. some Wayland sessions): idle detection then never triggers.
#[tauri::command]
fn idle_seconds() -> u64 {
    user_idle::UserIdle::get_time()
        .map(|idle| idle.as_seconds())
        .unwrap_or(0)
}

/// Updates the tray tooltip / title (macOS, Linux) and the "Stop timer" item.
#[tauri::command]
fn set_tray_status(app: AppHandle, text: String, running: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(&text)).map_err(|e| e.to_string())?;
        tray.set_title(if running { Some(text.as_str()) } else { None })
            .map_err(|e| e.to_string())?;
    }
    if let Some(items) = app.try_state::<TrayItems>() {
        items.status.set_text(&text).map_err(|e| e.to_string())?;
        items.stop.set_enabled(running).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum UpdateCheck {
    UpToDate,
    Unauthorized,
    Available {
        version: String,
        notes: Option<String>,
        min_supported_version: Option<String>,
    },
    Error {
        message: String,
    },
}

fn updater_target() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

fn updater_endpoint(server: &str) -> String {
    format!(
        "{}/api/time-track/updates/desktop/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",
        server.trim_end_matches('/')
    )
}

fn parse_update(body: &str) -> UpdateCheck {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(json) => UpdateCheck::Available {
            version: json["version"].as_str().unwrap_or_default().to_string(),
            notes: json["notes"].as_str().map(str::to_string),
            min_supported_version: json["min_supported_version"].as_str().map(str::to_string),
        },
        Err(e) => UpdateCheck::Error {
            message: e.to_string(),
        },
    }
}

/// Beacon's updater route (`time_track_client_updater`). 204 = up to date, 401 = sign in again (not an error),
/// 200 = `{version, notes, pub_date, url, signature, min_supported_version?}`.
#[tauri::command]
async fn check_update(app: AppHandle, server: String, token: String) -> UpdateCheck {
    let url = updater_endpoint(&server)
        .replace("{{target}}", updater_target())
        .replace("{{arch}}", std::env::consts::ARCH)
        .replace(
            "{{current_version}}",
            &app.package_info().version.to_string(),
        );
    let response = match reqwest::Client::new()
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => {
            return UpdateCheck::Error {
                message: e.to_string(),
            }
        }
    };
    match response.status().as_u16() {
        204 => UpdateCheck::UpToDate,
        401 => UpdateCheck::Unauthorized,
        200 => match response.text().await {
            Ok(body) => parse_update(&body),
            Err(e) => UpdateCheck::Error {
                message: e.to_string(),
            },
        },
        status => UpdateCheck::Error {
            message: format!("HTTP {status}"),
        },
    }
}

/// Downloads, verifies (minisign public key of the build) and installs the update, then restarts.
/// The Bearer token is set at runtime through the updater builder headers.
#[tauri::command]
async fn install_update(app: AppHandle, server: String, token: String) -> Result<(), String> {
    let endpoint = url::Url::parse(&updater_endpoint(&server)).map_err(|e| e.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = update {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "TimeTrack", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open TimeTrack", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop timer", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &stop, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("TimeTrack")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "stop" => {
                let _ = app.emit("tray-stop", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems { status, stop });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Registered but never enabled by default: the user opts in from Settings.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit("shortcut", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            build_tray(app)?;
            if let Err(e) = app.global_shortcut().register(SHORTCUT) {
                eprintln!("global shortcut {SHORTCUT} unavailable: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the tray timer running; "Quit" is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            idle_seconds,
            set_tray_status,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running TimeTrack");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_keeps_tauri_placeholders() {
        assert_eq!(
            updater_endpoint("https://beacon.example.com/"),
            "https://beacon.example.com/api/time-track/updates/desktop/{{target}}/{{arch}}/{{current_version}}"
        );
    }

    #[test]
    fn target_uses_tauri_names() {
        assert!(["linux", "windows", "darwin"].contains(&updater_target()));
    }

    #[test]
    fn parses_update_with_min_supported_version() {
        let json = serde_json::to_value(parse_update(
            r#"{"version":"0.2.0","notes":"n","min_supported_version":"0.2.0","url":"u","signature":"s"}"#,
        ))
        .unwrap();
        assert_eq!(json["status"], "available");
        assert_eq!(json["version"], "0.2.0");
        assert_eq!(json["min_supported_version"], "0.2.0");
        assert_eq!(
            serde_json::to_value(parse_update("nope")).unwrap()["status"],
            "error"
        );
        assert_eq!(
            serde_json::to_value(UpdateCheck::Unauthorized).unwrap()["status"],
            "unauthorized"
        );
    }
}
