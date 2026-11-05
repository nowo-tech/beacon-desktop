//! Friendly messages as native OS notifications: a short localized title, the line as body and the mascot pose.
//!
//! - **Windows**: a toast under the app's AppUserModelID, the pose as the square app logo (bottom right, in the
//!   Action Center like any other app). NSIS installs register `tech.nowo.timetrack` on the Start-menu shortcut; the
//!   MSIX (Store) package's AUMID is `<package family name>!TimeTrack`, derived from the install folder.
//! - **macOS**: Notification Center, the pose as the content image (the app icon is the sender's).
//! - **Linux**: the Desktop Notifications service (GNOME, KDE, …), the pose through the `image-path` hint.
//!
//! A click on the notification brings the main window forward. The pictures are compiled in (`pose_art.rs`) and
//! written once to the app's cache folder, since every OS API wants a file.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::pose_art::POSE_ART;

/// What the UI sends (`notify_friendly`). Texts come already translated; lengths are capped before display.
#[derive(Debug, Clone, Deserialize)]
pub struct FriendlyNote {
    pub title: String,
    pub body: String,
    pub pose: Option<String>,
}

const TITLE_MAX: usize = 80;
const BODY_MAX: usize = 300;

fn cap(text: &str, max: usize) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    let trimmed = clean.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// The compiled-in picture of a pose id, or `None` for an unknown id (never a path from the UI).
pub fn pose_png(id: &str) -> Option<&'static [u8]> {
    POSE_ART
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, bytes)| *bytes)
}

/// `<cache>/notification-art/pose-<id>.png`, written when missing or of another size (an update changed the art).
fn pose_file(cache: &Path, id: &str) -> Option<PathBuf> {
    let bytes = pose_png(id)?;
    let dir = cache.join("notification-art");
    let path = dir.join(format!("pose-{id}.png"));
    let current = std::fs::metadata(&path).map(|m| m.len()).ok();
    if current != Some(bytes.len() as u64) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, bytes).ok()?;
    }
    Some(path)
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Package family name of an MSIX install, from its folder `…\WindowsApps\<Name>_<Version>_<Arch>_<Resource>_<PublisherId>\`.
pub fn package_family_name(exe: &Path) -> Option<String> {
    let mut components = exe
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string());
    components.find(|c| c.eq_ignore_ascii_case("WindowsApps"))?;
    let full = components.next()?;
    let parts: Vec<&str> = full.split('_').collect();
    if parts.len() != 5 || parts[0].is_empty() || parts[4].is_empty() {
        return None;
    }
    Some(format!("{}_{}", parts[0], parts[4]))
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The `Application Id` of the MSIX manifest (scripts/store/msix-manifest.mjs).
pub const MSIX_APP_ID: &str = "TimeTrack";

#[cfg_attr(not(windows), allow(dead_code))]
/// AppUserModelID of the toasts: the package's for an MSIX install, else the bundle identifier the NSIS installer
/// puts on the Start-menu shortcut. `None` for a development build (`target\debug`, `target\release`): Windows then
/// shows the toast under PowerShell, as the notification plugin does.
pub fn windows_aumid(exe: &Path, identifier: &str) -> Option<String> {
    if let Some(family) = package_family_name(exe) {
        return Some(format!("{family}!{MSIX_APP_ID}"));
    }
    let dir = exe.parent()?.to_string_lossy().replace('/', "\\");
    let dev = dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release");
    (!dev).then(|| identifier.to_string())
}

/// Where the pictures are written. An MSIX install writes them to its package's own `LocalCache` (a real path the
/// toast host can read, unlike the virtualised `%LOCALAPPDATA%` of a packaged app); anything else to the app cache.
fn art_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(windows)]
    if let (Ok(exe), Some(local)) = (
        tauri::utils::platform::current_exe(),
        std::env::var_os("LOCALAPPDATA"),
    ) {
        if let Some(family) = package_family_name(&exe) {
            return Some(msix_cache(Path::new(&local), &family));
        }
    }
    app.path().app_cache_dir().ok()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn msix_cache(local_app_data: &Path, family: &str) -> PathBuf {
    local_app_data
        .join("Packages")
        .join(family)
        .join("LocalCache")
}

/// Plain text for a Linux notification body: servers that advertise `body-markup` (GNOME, KDE, …) would otherwise
/// render `<b>`, `<a>` or `<img>` from it.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg_attr(windows, allow(dead_code))]
/// Whether what the notification server reported is a click on the notification itself.
pub fn is_click(response: &notify_rust::NotificationResponse) -> bool {
    matches!(response, notify_rust::NotificationResponse::Default)
        || matches!(response, notify_rust::NotificationResponse::Action(action) if action == "default")
}

/// Shows the notification; errors (no notification service, toasts turned off) go back to the UI, which then shows
/// the message inside the app and says so in Settings.
pub fn show(app: &AppHandle, note: &FriendlyNote) -> Result<(), String> {
    let title = cap(&note.title, TITLE_MAX);
    let body = cap(&note.body, BODY_MAX);
    if body.is_empty() {
        return Err("empty notification".into());
    }
    let image = match (&note.pose, art_dir(app)) {
        (Some(id), Some(cache)) => pose_file(&cache, id),
        _ => None,
    };
    platform::show(app, &title, &body, image.as_deref())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use tauri_winrt_notification::{IconCrop, Toast};

    pub fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        image: Option<&Path>,
    ) -> Result<(), String> {
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let aumid = windows_aumid(&exe, &app.config().identifier)
            .unwrap_or_else(|| Toast::POWERSHELL_APP_ID.to_string());
        let mut toast = Toast::new(&aumid).title(title).text1(body);
        if let Some(path) = image {
            toast = toast.icon(path, IconCrop::Square, "");
        }
        let handle = app.clone();
        toast
            .on_activated(move |_| {
                crate::show_main(&handle);
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        image: Option<&Path>,
    ) -> Result<(), String> {
        #[cfg(not(target_os = "macos"))]
        let body = &escape_markup(body);
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(title)
            .body(body)
            .appname(app.config().product_name.as_deref().unwrap_or("TimeTrack"))
            .auto_icon();
        if let Some(path) = image {
            notification.image_path(&path.to_string_lossy());
        }
        #[cfg(target_os = "macos")]
        {
            static APPLICATION: std::sync::Once = std::sync::Once::new();
            let identifier = app.config().identifier.clone();
            APPLICATION.call_once(|| {
                let _ = notify_rust::set_application(if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    &identifier
                });
            });
        }
        // The Desktop Notifications Specification reports a click on the notification itself as the action
        // `default`, and only for a notification that offers it.
        #[cfg(not(target_os = "macos"))]
        notification.action("default", "");
        #[cfg(not(target_os = "macos"))]
        let handle = notification.show().map_err(|e| e.to_string())?;
        let app = app.clone();
        // Waiting keeps the connection open (GNOME closes a notification whose sender went away) and reports the
        // click; on macOS this is also where the notification is sent.
        std::thread::Builder::new()
            .name("notification".into())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                let handle = match notification.show() {
                    Ok(handle) => handle,
                    Err(_) => return,
                };
                let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                    if is_click(response) {
                        crate::show_main(&app);
                    }
                });
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_pose_has_a_square_png_and_nothing_else_does() {
        let listed: Vec<String> =
            serde_json::from_str(include_str!("../../src/ui/pose-art.json")).unwrap();
        assert_eq!(listed.len(), POSE_ART.len());
        for id in &listed {
            let png = pose_png(id).unwrap_or_else(|| panic!("{id}"));
            assert_eq!(&png[1..4], b"PNG", "{id}");
            // IHDR width and height (big endian at 16..24): 96 × 96.
            assert_eq!(&png[16..24], &[0, 0, 0, 96, 0, 0, 0, 96], "{id}");
        }
        for id in ["", "../etc/passwd", "beach", "PEEK", "peek.png"] {
            assert!(pose_png(id).is_none(), "{id}");
        }
    }

    #[test]
    fn pose_files_are_written_once_into_the_cache() {
        let cache = std::env::temp_dir().join(format!("ttd-notify-{}", std::process::id()));
        let path = pose_file(&cache, "coffee").expect("written");
        assert!(path.ends_with("notification-art/pose-coffee.png"));
        assert_eq!(std::fs::read(&path).unwrap(), pose_png("coffee").unwrap());
        // A stale file (other art) is replaced.
        std::fs::write(&path, b"old").unwrap();
        pose_file(&cache, "coffee").unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap().len(),
            pose_png("coffee").unwrap().len()
        );
        assert!(pose_file(&cache, "nope").is_none());
        std::fs::remove_dir_all(&cache).unwrap();
    }

    #[test]
    fn texts_are_capped_and_cleaned() {
        assert_eq!(cap("  Coffee time \n", 80), "Coffee time");
        let long = "x".repeat(400);
        let capped = cap(&long, BODY_MAX);
        assert_eq!(capped.chars().count(), BODY_MAX);
        assert!(capped.ends_with('…'));
        assert_eq!(cap("a\u{7}b", 10), "ab");
    }

    #[test]
    fn msix_installs_use_the_package_aumid_and_nsis_the_identifier() {
        let msix = Path::new(
            r"C:\Program Files\WindowsApps\NowoTech.TimeTrack_0.5.0.0_x64__8wekyb3d8bbwe\TimeTrack.exe",
        );
        // Built on Linux, Windows paths have no separators for `Path`: the same logic on the `/` form.
        let msix_unix = Path::new(
            "/Program Files/WindowsApps/NowoTech.TimeTrack_0.5.0.0_x64__8wekyb3d8bbwe/TimeTrack.exe",
        );
        let parsed = package_family_name(msix_unix);
        assert_eq!(parsed.as_deref(), Some("NowoTech.TimeTrack_8wekyb3d8bbwe"));
        assert_eq!(
            windows_aumid(msix_unix, "tech.nowo.timetrack").as_deref(),
            Some("NowoTech.TimeTrack_8wekyb3d8bbwe!TimeTrack")
        );
        if cfg!(windows) {
            assert_eq!(package_family_name(msix), parsed);
        }
        let nsis = Path::new("/Users/ana/AppData/Local/TimeTrack/time-track-desktop.exe");
        assert_eq!(
            windows_aumid(nsis, "tech.nowo.timetrack").as_deref(),
            Some("tech.nowo.timetrack")
        );
        let dev =
            Path::new("/src/time-track-desktop/src-tauri/target/debug/time-track-desktop.exe");
        assert_eq!(windows_aumid(dev, "tech.nowo.timetrack"), None);
        assert_eq!(
            package_family_name(Path::new("/x/WindowsApps/not-a-package/a.exe")),
            None
        );
        assert_eq!(package_family_name(Path::new("/x/WindowsApps")), None);
        assert!(
            msix_cache(Path::new("/L"), "NowoTech.TimeTrack_8wekyb3d8bbwe")
                .ends_with("Packages/NowoTech.TimeTrack_8wekyb3d8bbwe/LocalCache")
        );
    }

    #[test]
    fn linux_bodies_are_plain_text() {
        assert_eq!(
            escape_markup("Tom & Jerry <b>bold</b> <img src=x>"),
            "Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt; &lt;img src=x&gt;"
        );
        assert_eq!(escape_markup("¿Un café?"), "¿Un café?");
    }

    #[test]
    fn only_a_click_on_the_notification_counts() {
        use notify_rust::{CloseReason, NotificationResponse};
        assert!(is_click(&NotificationResponse::Default));
        assert!(is_click(&NotificationResponse::Action("default".into())));
        assert!(!is_click(&NotificationResponse::Action("other".into())));
        assert!(!is_click(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
    }
}
