//! "Open Beacon in" (Settings): every link the app opens goes through `open_external`, which uses the system default
//! browser (the opener plugin, no `with`) or the browser the person chose on this computer.
//!
//! - Installed browsers are detected from the OS (`list_browsers`): Windows `StartMenuInternet` and `App Paths` in the
//!   registry, macOS LaunchServices https handlers, Linux `.desktop` entries handling `x-scheme-handler/https` in the
//!   XDG data dirs (Flatpak and Snap exports included). The parsers below take their input through small traits, so
//!   the tests feed them fixtures.
//! - The choice lives on this side (`BrowserState`, `browser.json` in the app's config folder), never in the webview:
//!   `set_browser` takes the system default or the id of a detected browser, `pick_browser` opens the native file
//!   dialog here and keeps what the person picked there, and `open_external` takes only the URL (audit GC-L1). Script
//!   in the window can never name an executable.
//! - A chosen browser is launched with an argv array (never a shell); the URL is the only argument that comes from the
//!   UI and it is checked here again (https, or http to this computer for a development Beacon; no credentials, no
//!   quote / backtick / dollar / backslash / control characters).
//! - A custom browser must be an absolute path to an existing regular file: an `.exe` on Windows (not a Windows system
//!   binary), an `.app` bundle on macOS (opened with `open -a <app> <url>`), an executable file on Linux; shells,
//!   interpreters and launchers (`sh`, `env`, `python3`, `cmd.exe`, `powershell.exe`, …) are refused, also behind a
//!   symbolic link.
//! - Linux `.desktop` entries whose `Exec` wraps the URL in a shell (`sh -c "browser %u"`, which the Desktop Entry spec
//!   forbids anyway: field codes must not be quoted) are not offered (audit GC-I1).
//! - A chosen browser that no longer exists (or fails to start) falls back to the system default; the UI says so.

// The parsers of every OS are compiled (and tested) on all of them; each build only calls its own.
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// One argument of a browser's command line: literal text or the URL (with text around it, `--url=%u`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Arg {
    Lit(String),
    Url { prefix: String, suffix: String },
}

impl Arg {
    fn url() -> Self {
        Arg::Url {
            prefix: String::new(),
            suffix: String::new(),
        }
    }
}

/// An installed (or custom) browser as the UI sees it; `argv` stays on this side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Browser {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub argv: Vec<Arg>,
}

impl Browser {
    /// The command line for `url` (first element: the program).
    pub fn command(&self, url: &str) -> Vec<String> {
        self.argv
            .iter()
            .map(|arg| match arg {
                Arg::Lit(text) => text.clone(),
                Arg::Url { prefix, suffix } => format!("{prefix}{url}{suffix}"),
            })
            .collect()
    }
}

/// The "Open Beacon in" setting of this computer, kept on this side (`BrowserState`) and shown to the UI as is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Choice {
    System,
    Detected { id: String, name: String },
    Custom { path: String, name: String },
}

/// What the UI may ask `set_browser` for: the system default or a detected browser, by id. A custom browser is only
/// ever chosen in the native file dialog (`pick_browser`), so no path comes from the webview.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Request {
    System,
    Detected { id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// What the file system says about a path (real one, or a fixture in the tests).
pub trait Fs {
    fn is_file(&self, path: &str) -> bool;
    fn is_dir(&self, path: &str) -> bool;
    /// A regular file with an execute bit (Unix); on Windows any regular file.
    fn is_executable(&self, path: &str) -> bool {
        self.is_file(path)
    }
    /// The path with every symbolic link resolved (`None` when it cannot be resolved).
    fn resolve(&self, path: &str) -> Option<String> {
        Some(path.to_string())
    }
}

pub struct RealFs;

impl Fs for RealFs {
    fn is_file(&self, path: &str) -> bool {
        std::path::Path::new(path).is_file()
    }
    fn is_dir(&self, path: &str) -> bool {
        std::path::Path::new(path).is_dir()
    }
    fn is_executable(&self, path: &str) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.is_file() && meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            meta.is_file()
        }
    }
    fn resolve(&self, path: &str) -> Option<String> {
        std::fs::canonicalize(path)
            .ok()
            .and_then(|p| p.to_str().map(str::to_string))
    }
}

// ---- URL -------------------------------------------------------------------------------------------------------------

const LOOPBACK: &[&str] = &["localhost", "127.0.0.1", "[::1]"];

/// The URL as it will be passed to a browser: https (or http to this computer, for a development Beacon), with a host,
/// no credentials and none of the characters a misbehaving launcher could interpret.
pub fn check_url(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "not a URL".to_string())?;
    let host = url.host_str().unwrap_or("");
    let allowed = match url.scheme() {
        "https" => !host.is_empty(),
        "http" => LOOPBACK.contains(&host),
        _ => false,
    };
    if !allowed || !url.username().is_empty() || url.password().is_some() {
        return Err("only https links are opened".into());
    }
    let text = url.to_string();
    if text
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '$' | '\\'))
    {
        return Err("unexpected characters in the link".into());
    }
    Ok(text)
}

// ---- custom browser --------------------------------------------------------------------------------------------------

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn stem(path: &str) -> String {
    let name = base_name(path.trim_end_matches(['/', '\\']));
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[..dot].to_string(),
        _ => name.to_string(),
    }
}

fn is_absolute(path: &str, os: Os) -> bool {
    match os {
        // `C:\…` or `C:/…` (no UNC / network paths, no relative drive paths).
        Os::Windows => {
            let bytes = path.as_bytes();
            bytes.len() > 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/')
        }
        Os::Mac | Os::Linux => path.starts_with('/'),
    }
}

/// Programs that are never a browser: shells, interpreters, privilege / process launchers and system tools that run
/// what they are given. Compared with the file name without its extension, lower case (`python3.12` → `python3`).
const NOT_BROWSERS: &[&str] = &[
    "sh",
    "bash",
    "dash",
    "zsh",
    "ksh",
    "mksh",
    "csh",
    "tcsh",
    "fish",
    "ash",
    "busybox",
    "toybox",
    "env",
    "sudo",
    "doas",
    "pkexec",
    "su",
    "runuser",
    "nohup",
    "setsid",
    "xargs",
    "timeout",
    "nice",
    "stdbuf",
    "flatpak-spawn",
    "systemd-run",
    "awk",
    "gawk",
    "mawk",
    "sed",
    "osascript",
    "open",
    "xdg-open",
    "gio",
    "kioclient",
    "kioclient5",
    "exo-open",
    "gnome-open",
    "cmd",
    "command",
    "powershell",
    "powershell_ise",
    "pwsh",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "regsvr32",
    "regedit",
    "reg",
    "msiexec",
    "wsl",
    "wslhost",
    "conhost",
    "explorer",
    "schtasks",
    "sc",
    "certutil",
    "bitsadmin",
    "curl",
    "wget",
    "forfiles",
    "hh",
    "installutil",
    "msbuild",
    "wmic",
    "start",
];
/// Interpreter families, matched as a prefix (`python3`, `perl5.36`, `ruby3.2`, `node20`, …).
const INTERPRETERS: &[&str] = &[
    "python",
    "pypy",
    "perl",
    "ruby",
    "php",
    "lua",
    "node",
    "deno",
    "bun",
    "tclsh",
    "wish",
    "java",
    "jshell",
    "guile",
    "racket",
    "rscript",
    "julia",
    "osascript",
];

fn not_a_browser(path: &str) -> bool {
    let name = stem(path).to_ascii_lowercase();
    NOT_BROWSERS.contains(&name.as_str()) || INTERPRETERS.iter().any(|p| name.starts_with(p))
}

/// `C:\Windows\…` (any drive): system binaries are not offered as a custom browser.
fn in_windows_dir(path: &str) -> bool {
    let lower = path.to_ascii_lowercase().replace('/', "\\");
    // `canonicalize` on Windows answers with the verbatim prefix (`\\?\C:\…`).
    let lower = lower.strip_prefix("\\\\?\\").unwrap_or(&lower);
    lower
        .get(1..)
        .is_some_and(|rest| rest.starts_with(":\\windows\\"))
}

/// A browser picked by hand: an absolute path to an existing `.exe` (Windows, outside `C:\Windows`), `.app` bundle
/// (macOS) or executable file (Linux), never a shell, interpreter or launcher (also checked on the resolved path, so a
/// link named `brave` that points to `/bin/sh` is refused).
pub fn custom_browser(path: &str, os: Os, fs: &dyn Fs) -> Result<Browser, String> {
    if path.contains('\0') || path.contains("..") || !is_absolute(path, os) {
        return Err("the browser must be an absolute path".into());
    }
    let resolved = fs.resolve(path);
    if not_a_browser(path) || resolved.as_deref().is_some_and(not_a_browser) {
        return Err("this program is not a browser".into());
    }
    if os == Os::Windows
        && (in_windows_dir(path) || resolved.as_deref().is_some_and(in_windows_dir))
    {
        return Err("choose a browser outside the Windows folder".into());
    }
    let lower = path.to_ascii_lowercase();
    let app = path.trim_end_matches('/');
    let argv = match os {
        Os::Windows if lower.ends_with(".exe") && fs.is_file(path) => {
            vec![Arg::Lit(path.into()), Arg::url()]
        }
        Os::Mac
            if lower.trim_end_matches('/').ends_with(".app")
                && fs.is_dir(path)
                && fs.is_file(&format!("{app}/Contents/Info.plist")) =>
        {
            vec![
                Arg::Lit("/usr/bin/open".into()),
                Arg::Lit("-a".into()),
                Arg::Lit(path.into()),
                Arg::url(),
            ]
        }
        Os::Linux if fs.is_executable(path) => vec![Arg::Lit(path.into()), Arg::url()],
        Os::Windows => return Err("choose the browser's .exe file".into()),
        Os::Mac => return Err("choose the browser's .app".into()),
        Os::Linux => return Err("choose the browser's program (an executable file)".into()),
    };
    Ok(Browser {
        id: "custom".into(),
        name: stem(path),
        argv,
    })
}

// ---- Windows: registry -----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

/// Read-only view of the registry (string values only).
pub trait Registry {
    fn subkeys(&self, hive: Hive, path: &str) -> Vec<String>;
    fn value(&self, hive: Hive, path: &str, name: &str) -> Option<String>;
}

const START_MENU_INTERNET: &[&str] = &[
    r"SOFTWARE\Clients\StartMenuInternet",
    r"SOFTWARE\WOW6432Node\Clients\StartMenuInternet",
];
const APP_PATHS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
/// Browsers looked up in `App Paths` when they did not register under `StartMenuInternet`.
const KNOWN_EXES: &[(&str, &str)] = &[
    ("brave.exe", "Brave"),
    ("chrome.exe", "Google Chrome"),
    ("chromium.exe", "Chromium"),
    ("firefox.exe", "Firefox"),
    ("msedge.exe", "Microsoft Edge"),
    ("opera.exe", "Opera"),
    ("vivaldi.exe", "Vivaldi"),
];

/// `%ProgramFiles%\…` → the variable's value (unknown variables are kept).
pub fn expand_env(text: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match env(name) {
                    Some(value) => out.push_str(&value),
                    None => out.push_str(&rest[start..start + end + 2]),
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The executable of a `shell\open\command` value: `"C:\…\brave.exe" --single-argument %1` → `C:\…\brave.exe`.
pub fn exe_from_command(command: &str) -> Option<String> {
    let command = command.trim();
    let exe = if let Some(quoted) = command.strip_prefix('"') {
        &quoted[..quoted.find('"')?]
    } else {
        let lower = command.to_ascii_lowercase();
        &command[..lower.find(".exe")? + 4]
    };
    let exe = exe.trim();
    (exe.to_ascii_lowercase().ends_with(".exe") && is_absolute(exe, Os::Windows))
        .then(|| exe.to_string())
}

pub fn windows_browsers(
    registry: &dyn Registry,
    fs: &dyn Fs,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<Browser> {
    let mut found: Vec<Browser> = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut add = |id: String, name: String, exe: String, found: &mut Vec<Browser>| {
        let exe = expand_env(&exe, env);
        if !fs.is_file(&exe)
            || !seen_paths.insert(exe.to_ascii_lowercase())
            || found.iter().any(|b| b.id == id)
        {
            return;
        }
        found.push(Browser {
            id,
            name,
            argv: vec![Arg::Lit(exe), Arg::url()],
        });
    };
    for hive in [Hive::CurrentUser, Hive::LocalMachine] {
        for root in START_MENU_INTERNET {
            for key in registry.subkeys(hive, root) {
                let path = format!(r"{root}\{key}");
                let Some(exe) = registry
                    .value(hive, &format!(r"{path}\shell\open\command"), "")
                    .and_then(|command| exe_from_command(&command))
                else {
                    continue;
                };
                let name = registry
                    .value(hive, &path, "")
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| key.clone());
                add(
                    format!("win:{}", key.to_ascii_lowercase()),
                    name,
                    exe,
                    &mut found,
                );
            }
        }
    }
    for hive in [Hive::CurrentUser, Hive::LocalMachine] {
        for (exe_name, label) in KNOWN_EXES {
            if let Some(exe) = registry.value(hive, &format!(r"{APP_PATHS}\{exe_name}"), "") {
                let exe = exe.trim().trim_matches('"').to_string();
                if is_absolute(&expand_env(&exe, env), Os::Windows) {
                    add(
                        format!("app:{exe_name}"),
                        label.to_string(),
                        exe,
                        &mut found,
                    );
                }
            }
        }
    }
    sorted(found)
}

#[cfg(windows)]
pub struct RealRegistry;

#[cfg(windows)]
impl Registry for RealRegistry {
    fn subkeys(&self, hive: Hive, path: &str) -> Vec<String> {
        use winreg::enums::KEY_READ;
        root_key(hive)
            .open_subkey_with_flags(path, KEY_READ)
            .map(|key| key.enum_keys().filter_map(Result::ok).collect())
            .unwrap_or_default()
    }
    fn value(&self, hive: Hive, path: &str, name: &str) -> Option<String> {
        use winreg::enums::KEY_READ;
        root_key(hive)
            .open_subkey_with_flags(path, KEY_READ)
            .ok()?
            .get_value::<String, _>(name)
            .ok()
    }
}

#[cfg(windows)]
fn root_key(hive: Hive) -> winreg::RegKey {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    winreg::RegKey::predef(match hive {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
    })
}

// ---- macOS: LaunchServices -------------------------------------------------------------------------------------------

/// The https handlers LaunchServices knows (bundle ids) and where each app is.
pub trait LaunchServices {
    fn https_handlers(&self) -> Vec<String>;
    fn app_path(&self, bundle_id: &str) -> Option<String>;
}

pub fn macos_browsers(services: &dyn LaunchServices, fs: &dyn Fs) -> Vec<Browser> {
    let mut found: Vec<Browser> = Vec::new();
    for bundle_id in services.https_handlers() {
        let id = format!("mac:{}", bundle_id.to_ascii_lowercase());
        if found.iter().any(|b| b.id == id) {
            continue;
        }
        let Some(path) = services.app_path(&bundle_id) else {
            continue;
        };
        if !path
            .trim_end_matches('/')
            .to_ascii_lowercase()
            .ends_with(".app")
            || !fs.is_dir(&path)
        {
            continue;
        }
        found.push(Browser {
            id,
            name: stem(&path),
            argv: vec![
                Arg::Lit("/usr/bin/open".into()),
                Arg::Lit("-a".into()),
                Arg::Lit(path),
                Arg::url(),
            ],
        });
    }
    sorted(found)
}

#[cfg(target_os = "macos")]
pub mod mac {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::error::CFErrorRef;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::CFURL;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyAllHandlersForURLScheme(scheme: CFStringRef) -> CFArrayRef;
        fn LSCopyApplicationURLsForBundleIdentifier(
            bundle_id: CFStringRef,
            error: *mut CFErrorRef,
        ) -> CFArrayRef;
    }

    pub struct RealLaunchServices;

    impl super::LaunchServices for RealLaunchServices {
        fn https_handlers(&self) -> Vec<String> {
            let scheme = CFString::from_static_string("https");
            // SAFETY: a valid CFString in, a +1 CFArray of CFString (or NULL) out, released by the wrapper.
            let raw = unsafe { LSCopyAllHandlersForURLScheme(scheme.as_concrete_TypeRef()) };
            if raw.is_null() {
                return Vec::new();
            }
            let handlers: CFArray<CFString> = unsafe { CFArray::wrap_under_create_rule(raw) };
            handlers.iter().map(|id| id.to_string()).collect()
        }

        fn app_path(&self, bundle_id: &str) -> Option<String> {
            let id = CFString::new(bundle_id);
            // SAFETY: as above; the error out-parameter is optional (NULL).
            let raw = unsafe {
                LSCopyApplicationURLsForBundleIdentifier(
                    id.as_concrete_TypeRef(),
                    std::ptr::null_mut(),
                )
            };
            if raw.is_null() {
                return None;
            }
            let urls: CFArray<CFURL> = unsafe { CFArray::wrap_under_create_rule(raw) };
            let first = urls.iter().next()?.to_path()?;
            Some(first.to_string_lossy().into_owned())
        }
    }
}

// ---- Linux: .desktop entries -----------------------------------------------------------------------------------------

/// `.desktop` files in XDG precedence order: (desktop id, contents).
pub trait DesktopFiles {
    fn entries(&self) -> Vec<(String, String)>;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DesktopEntry {
    pub name: String,
    pub exec: String,
    pub mime_types: Vec<String>,
    pub application: bool,
    pub hidden: bool,
}

/// The `[Desktop Entry]` group of a `.desktop` file (unlocalised keys only).
pub fn parse_desktop(contents: &str) -> DesktopEntry {
    let mut entry = DesktopEntry::default();
    let mut in_group = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Name" => entry.name = value.to_string(),
            "Exec" => entry.exec = value.to_string(),
            "MimeType" => {
                entry.mime_types = value
                    .split(';')
                    .filter(|m| !m.is_empty())
                    .map(str::to_string)
                    .collect()
            }
            "Type" => entry.application = value == "Application",
            "Hidden" => entry.hidden = value == "true",
            _ => {}
        }
    }
    entry
}

/// The `Exec` key as argv (Desktop Entry spec: string escapes, double quotes, field codes). `%u %U %f %F` become the
/// URL, `%c` the name, `%%` a percent sign, the other codes are dropped; without a URL code the URL is appended.
pub fn parse_exec(exec: &str, name: &str) -> Option<Vec<Arg>> {
    // 1. Escapes of a string value.
    let mut unescaped = String::new();
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('s') => unescaped.push(' '),
                Some('n') => unescaped.push('\n'),
                Some('t') => unescaped.push('\t'),
                Some('r') => unescaped.push('\r'),
                Some('\\') => unescaped.push('\\'),
                Some(other) => {
                    unescaped.push('\\');
                    unescaped.push(other);
                }
                None => unescaped.push('\\'),
            }
        } else {
            unescaped.push(c);
        }
    }
    // 2. Words, with double-quoted arguments.
    let mut words: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    let mut chars = unescaped.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\n' | '\r' => {
                if let Some(word) = current.take() {
                    words.push(word);
                }
            }
            '"' => {
                let word = current.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            escaped @ ('"' | '`' | '$' | '\\') => word.push(escaped),
                            other => {
                                word.push('\\');
                                word.push(other);
                            }
                        },
                        other => word.push(other),
                    }
                }
            }
            other => current.get_or_insert_with(String::new).push(other),
        }
    }
    if let Some(word) = current.take() {
        words.push(word);
    }
    // 3. Field codes.
    let mut argv = Vec::new();
    let mut has_url = false;
    for word in words {
        if matches!(
            word.as_str(),
            "%i" | "%k" | "%d" | "%D" | "%n" | "%N" | "%v" | "%m"
        ) {
            continue;
        }
        let mut text = String::new();
        let mut url_at: Option<usize> = None;
        let mut chars = word.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                text.push(c);
                continue;
            }
            match chars.next() {
                Some('%') => text.push('%'),
                Some('u' | 'U' | 'f' | 'F') if url_at.is_none() && !has_url => {
                    url_at = Some(text.len())
                }
                Some('c') => text.push_str(name),
                _ => {}
            }
        }
        match url_at {
            Some(at) => {
                has_url = true;
                argv.push(Arg::Url {
                    prefix: text[..at].to_string(),
                    suffix: text[at..].to_string(),
                });
            }
            None if !text.is_empty() => argv.push(Arg::Lit(text)),
            None => {}
        }
    }
    match argv.first() {
        Some(Arg::Lit(_)) => {}
        _ => return None,
    }
    if !has_url {
        argv.push(Arg::url());
    }
    Some(argv)
}

/// Shells, by file name without extension.
const SHELLS: &[&str] = &[
    "sh", "bash", "dash", "zsh", "ksh", "mksh", "csh", "tcsh", "fish", "ash", "busybox",
];

/// An `Exec` that hands the URL to a shell: a shell with `-c` (`sh -c "browser %u"`, `env A=b bash -lc …`), or the URL
/// inside a word with spaces around it (a command string). The Desktop Entry spec forbids field codes inside quoted
/// arguments, and `check_url` keeps quotes, `$`, backticks and spaces out, but not `;`, `|`, `&` or parentheses, so
/// such an entry is not offered at all (audit GC-I1).
pub fn shell_wrapped(argv: &[Arg]) -> bool {
    let with_c = argv.iter().any(|arg| {
        matches!(arg, Arg::Lit(text) if text.starts_with('-') && !text.starts_with("--") && text.contains('c'))
    });
    let shell = argv
        .iter()
        .any(|arg| matches!(arg, Arg::Lit(text) if SHELLS.contains(&stem(text).to_ascii_lowercase().as_str())));
    let url_in_command = argv.iter().any(|arg| {
        matches!(arg, Arg::Url { prefix, suffix } if prefix.contains(char::is_whitespace) || suffix.contains(char::is_whitespace))
    });
    (shell && with_c) || url_in_command
}

pub fn linux_browsers(files: &dyn DesktopFiles) -> Vec<Browser> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for (id, contents) in files.entries() {
        // The first file with an id wins (a user's copy, even a hidden one, replaces the system one).
        if !seen.insert(id.clone()) {
            continue;
        }
        let entry = parse_desktop(&contents);
        if !entry.application
            || entry.hidden
            || !entry
                .mime_types
                .iter()
                .any(|m| m == "x-scheme-handler/https")
        {
            continue;
        }
        let name = if entry.name.is_empty() {
            id.trim_end_matches(".desktop").to_string()
        } else {
            entry.name.clone()
        };
        if let Some(argv) = parse_exec(&entry.exec, &name).filter(|argv| !shell_wrapped(argv)) {
            found.push(Browser {
                id: format!("desktop:{id}"),
                name,
                argv,
            });
        }
    }
    sorted(found)
}

/// XDG data dirs (user first), plus the Flatpak and Snap export dirs when a session did not list them.
pub fn xdg_application_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let home = env("HOME").filter(|h| h.starts_with('/'));
    let data_home = env("XDG_DATA_HOME")
        .filter(|d| d.starts_with('/'))
        .or_else(|| home.as_ref().map(|h| format!("{h}/.local/share")));
    let data_dirs = env("XDG_DATA_DIRS")
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    let mut dirs: Vec<String> = data_home.into_iter().collect();
    dirs.extend(
        data_dirs
            .split(':')
            .filter(|d| d.starts_with('/'))
            .map(str::to_string),
    );
    if let Some(home) = &home {
        dirs.push(format!("{home}/.local/share/flatpak/exports/share"));
    }
    dirs.push("/var/lib/flatpak/exports/share".into());
    dirs.push("/var/lib/snapd/desktop".into());
    let mut seen = HashSet::new();
    dirs.into_iter()
        .map(|d| format!("{}/applications", d.trim_end_matches('/')))
        .filter(|d| seen.insert(d.clone()))
        .collect()
}

pub struct RealDesktopFiles(pub Vec<String>);

impl DesktopFiles for RealDesktopFiles {
    fn entries(&self) -> Vec<(String, String)> {
        fn walk(
            dir: &std::path::Path,
            prefix: &str,
            depth: usize,
            out: &mut Vec<(String, String)>,
        ) {
            let Ok(read) = std::fs::read_dir(dir) else {
                return;
            };
            let mut items: Vec<_> = read.filter_map(Result::ok).collect();
            items.sort_by_key(|item| item.file_name());
            for item in items {
                let name = item.file_name().to_string_lossy().into_owned();
                let path = item.path();
                if path.is_dir() && depth < 3 {
                    walk(&path, &format!("{prefix}{name}-"), depth + 1, out);
                } else if name.ends_with(".desktop")
                    && item
                        .metadata()
                        .map(|m| m.is_file() && m.len() < 256 * 1024)
                        .unwrap_or(false)
                {
                    if let Ok(contents) = std::fs::read_to_string(&path) {
                        out.push((format!("{prefix}{name}"), contents));
                    }
                }
            }
        }
        let mut out = Vec::new();
        for dir in &self.0 {
            walk(std::path::Path::new(dir), "", 0, &mut out);
        }
        out
    }
}

// ---- choosing and opening --------------------------------------------------------------------------------------------

fn sorted(mut browsers: Vec<Browser>) -> Vec<Browser> {
    browsers.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    browsers
}

/// The browsers installed on this computer.
pub fn detect() -> Vec<Browser> {
    let env = |name: &str| std::env::var(name).ok();
    #[cfg(windows)]
    {
        windows_browsers(&RealRegistry, &RealFs, &env)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = env;
        macos_browsers(&mac::RealLaunchServices, &RealFs)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        linux_browsers(&RealDesktopFiles(xdg_application_dirs(&env)))
    }
}

/// How a link is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// The system default browser (opener plugin, no `with`).
    System,
    /// The chosen browser with this command line.
    Launch(Vec<String>),
    /// The chosen browser is gone: the system default, and the UI says so.
    Fallback,
}

pub fn plan(
    choice: &Choice,
    url: &str,
    detected: impl FnOnce() -> Vec<Browser>,
    custom: impl FnOnce(&str) -> Result<Browser, String>,
) -> Plan {
    let browser = match choice {
        Choice::System => return Plan::System,
        Choice::Detected { id, .. } => detected().into_iter().find(|b| &b.id == id),
        Choice::Custom { path, .. } => custom(path).ok(),
    };
    match browser {
        Some(browser) => Plan::Launch(browser.command(url)),
        None => Plan::Fallback,
    }
}

fn spawn(argv: &[String]) -> std::io::Result<()> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| std::io::Error::other("empty command"))?;
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    // Reap it when it exits (browsers hand the URL to a running instance and return).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn open_default(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The stored choice, as read back from `browser.json`: anything malformed, oversized or of an unknown kind is the
/// system default (a custom path is checked again by `custom_browser` before each launch).
pub fn parse_stored(text: &str) -> Choice {
    let ok = |value: &str, max: usize| !value.trim().is_empty() && value.len() <= max;
    match serde_json::from_str::<Choice>(text) {
        Ok(Choice::Detected { id, name }) if ok(&id, 500) && ok(&name, 200) => {
            Choice::Detected { id, name }
        }
        Ok(Choice::Custom { path, name }) if ok(&path, 4096) && ok(&name, 200) => {
            Choice::Custom { path, name }
        }
        _ => Choice::System,
    }
}

/// `set_browser`: the system default, or a browser detected on this computer right now (by id).
pub fn resolve_request(
    request: &Request,
    detected: impl FnOnce() -> Vec<Browser>,
) -> Result<Choice, String> {
    match request {
        Request::System => Ok(Choice::System),
        Request::Detected { id } => detected()
            .into_iter()
            .find(|b| &b.id == id)
            .map(|b| Choice::Detected {
                id: b.id,
                name: b.name,
            })
            .ok_or_else(|| "this browser is not installed".to_string()),
    }
}

/// "Open Beacon in", owned by this side: read from `browser.json` (app config folder) at start, changed only by
/// `set_browser` / `pick_browser`, read by `open_external`.
pub struct BrowserState {
    choice: Mutex<Choice>,
    file: Option<PathBuf>,
}

impl BrowserState {
    pub fn load(file: Option<PathBuf>) -> Self {
        let choice = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|text| parse_stored(&text))
            .unwrap_or(Choice::System);
        Self {
            choice: Mutex::new(choice),
            file,
        }
    }

    pub fn get(&self) -> Choice {
        self.choice
            .lock()
            .map(|c| c.clone())
            .unwrap_or(Choice::System)
    }

    pub fn set(&self, choice: Choice) -> Result<Choice, String> {
        if let Some(file) = &self.file {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let json = serde_json::to_string(&choice).map_err(|e| e.to_string())?;
            let tmp = file.with_extension("json.tmp");
            std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, file).map_err(|e| e.to_string())?;
        }
        *self
            .choice
            .lock()
            .map_err(|_| "browser setting unavailable")? = choice.clone();
        Ok(choice)
    }
}

/// Registered in `setup`: the choice stored in the app's config folder.
pub fn manage(app: &AppHandle) {
    let file = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("browser.json"));
    app.manage(BrowserState::load(file));
}

/// Opens `url` in the browser chosen in Settings (read here, never passed by the webview): `"opened"`, or `"fallback"`
/// when the chosen one is gone and the system default was used instead.
#[tauri::command]
pub async fn open_external(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<String, String> {
    crate::only_from(&window, "main")?;
    let url = check_url(&url)?;
    let choice = state.get();
    let outcome = match plan(&choice, &url, detect, |path| {
        custom_browser(path, Os::current(), &RealFs)
    }) {
        Plan::System => {
            open_default(&app, &url)?;
            "opened"
        }
        Plan::Launch(argv) => match spawn(&argv) {
            Ok(()) => "opened",
            Err(_) => {
                open_default(&app, &url)?;
                "fallback"
            }
        },
        Plan::Fallback => {
            open_default(&app, &url)?;
            "fallback"
        }
    };
    Ok(outcome.into())
}

#[tauri::command]
pub async fn list_browsers(window: tauri::Window) -> Result<Vec<Browser>, String> {
    crate::only_from(&window, "main")?;
    Ok(detect())
}

/// The current "Open Beacon in" choice (for Settings and the fallback notice).
#[tauri::command]
pub fn get_browser(
    window: tauri::Window,
    state: tauri::State<'_, BrowserState>,
) -> Result<Choice, String> {
    crate::only_from(&window, "main")?;
    Ok(state.get())
}

/// Settings → Open Beacon in: the system default or a detected browser (by id, looked up again here).
#[tauri::command]
pub async fn set_browser(
    window: tauri::Window,
    state: tauri::State<'_, BrowserState>,
    choice: Request,
) -> Result<Choice, String> {
    crate::only_from(&window, "main")?;
    state.set(resolve_request(&choice, detect)?)
}

/// Settings → Open Beacon in → Custom…: the native file dialog, opened here; the picked file is checked
/// (`custom_browser`) and kept. `None` when the person cancelled; an error when the file is not a browser.
#[tauri::command]
pub async fn pick_browser(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, BrowserState>,
) -> Result<Option<Choice>, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::only_from(&window, "main")?;
    let os = Os::current();
    let mut dialog = app.dialog().file();
    if let Some(main) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&main);
    }
    dialog = match os {
        Os::Windows => dialog.add_filter("Browser", &["exe"]),
        Os::Mac => dialog.add_filter("Browser", &["app"]),
        Os::Linux => dialog,
    };
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .ok_or_else(|| "choose a file on this computer".to_string())?;
    let browser = custom_browser(&path, os, &RealFs)?;
    state
        .set(Choice::Custom {
            path,
            name: browser.name,
        })
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeFs {
        files: Vec<&'static str>,
        dirs: Vec<&'static str>,
        /// Files without an execute bit.
        noexec: Vec<&'static str>,
        /// Symbolic links (path → target).
        links: Vec<(&'static str, &'static str)>,
    }

    impl Fs for FakeFs {
        fn is_file(&self, path: &str) -> bool {
            self.files.contains(&path)
        }
        fn is_dir(&self, path: &str) -> bool {
            self.dirs.contains(&path)
        }
        fn is_executable(&self, path: &str) -> bool {
            self.is_file(path) && !self.noexec.contains(&path)
        }
        fn resolve(&self, path: &str) -> Option<String> {
            Some(
                self.links
                    .iter()
                    .find(|(link, _)| *link == path)
                    .map_or(path, |(_, target)| *target)
                    .to_string(),
            )
        }
    }

    fn fs(files: &[&'static str], dirs: &[&'static str]) -> FakeFs {
        FakeFs {
            files: files.to_vec(),
            dirs: dirs.to_vec(),
            noexec: Vec::new(),
            links: Vec::new(),
        }
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn urls_must_be_https_or_local_http() {
        assert_eq!(
            check_url("https://beacon.example.com/dashboard").unwrap(),
            "https://beacon.example.com/dashboard"
        );
        assert!(check_url("http://localhost:8000/device").is_ok());
        assert!(check_url("http://127.0.0.1:8000/").is_ok());
        assert!(check_url("http://[::1]:8000/").is_ok());
        for bad in [
            "http://beacon.example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://beacon.example.com/",
            "https://user:pass@beacon.example.com/",
            "https://user@beacon.example.com/",
            "-https://beacon.example.com",
            "https://beacon.example.com/$(touch x)",
            "https://beacon.example.com/a'b",
            "not a url",
            "",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        // Spaces, double quotes and backticks are percent-encoded by the parser, not refused.
        assert_eq!(
            check_url("https://b.example.com/a\"b`c").unwrap(),
            "https://b.example.com/a%22b%60c"
        );
        assert_eq!(
            check_url("https://b.example.com/a b").unwrap(),
            "https://b.example.com/a%20b"
        );
    }

    #[test]
    fn custom_browser_rules_per_os() {
        let files = fs(
            &[
                r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                "/usr/bin/brave-browser",
                r"C:\tools\run.bat",
                "/Applications/Brave Browser.app/Contents/Info.plist",
            ],
            &["/Applications/Brave Browser.app", "/Applications/Empty.app"],
        );
        let win = custom_browser(
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            Os::Windows,
            &files,
        )
        .unwrap();
        assert_eq!(win.name, "brave");
        assert_eq!(
            win.command("https://b.example.com/"),
            vec![
                r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                "https://b.example.com/"
            ]
        );
        let mac = custom_browser("/Applications/Brave Browser.app", Os::Mac, &files).unwrap();
        assert_eq!(mac.name, "Brave Browser");
        assert_eq!(
            mac.command("https://b.example.com/"),
            vec![
                "/usr/bin/open",
                "-a",
                "/Applications/Brave Browser.app",
                "https://b.example.com/"
            ]
        );
        let linux = custom_browser("/usr/bin/brave-browser", Os::Linux, &files).unwrap();
        assert_eq!(
            linux.command("https://b.example.com/"),
            vec!["/usr/bin/brave-browser", "https://b.example.com/"]
        );
        // Refused: relative, UNC, non-.exe, missing, parent segments, a bare binary on macOS.
        assert!(custom_browser("brave.exe", Os::Windows, &files).is_err());
        assert!(custom_browser(r"\\server\share\brave.exe", Os::Windows, &files).is_err());
        assert!(custom_browser(r"C:\tools\run.bat", Os::Windows, &files).is_err());
        assert!(custom_browser(r"C:\missing\brave.exe", Os::Windows, &files).is_err());
        assert!(custom_browser("/usr/bin/../bin/brave-browser", Os::Linux, &files).is_err());
        assert!(custom_browser("usr/bin/brave-browser", Os::Linux, &files).is_err());
        assert!(custom_browser("/usr/bin/missing", Os::Linux, &files).is_err());
        assert!(custom_browser("/usr/bin/brave-browser", Os::Mac, &files).is_err());
        assert!(custom_browser("/Applications/Missing.app", Os::Mac, &files).is_err());
        // A directory named .app without a bundle inside is not an app.
        assert!(custom_browser("/Applications/Empty.app", Os::Mac, &files).is_err());
    }

    #[test]
    fn custom_browser_refuses_shells_interpreters_system_tools_and_non_executables() {
        let mut files = fs(
            &[
                "/bin/sh",
                "/usr/bin/bash",
                "/usr/bin/env",
                "/usr/bin/python3.12",
                "/usr/bin/perl",
                "/usr/bin/xdg-open",
                "/home/ana/bin/brave",
                "/home/ana/notes.txt",
                "/opt/brave/brave",
                r"C:\Windows\System32\cmd.exe",
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                r"C:\Windows\System32\calc.exe",
                r"D:\tools\pwsh.exe",
                r"C:\Program Files\Mozilla Firefox\firefox.exe",
            ],
            &[],
        );
        files.noexec = vec!["/home/ana/notes.txt"];
        // A link named like a browser that points to a shell.
        files.links = vec![("/home/ana/bin/brave", "/usr/bin/bash")];
        for path in [
            "/bin/sh",
            "/usr/bin/bash",
            "/usr/bin/env",
            "/usr/bin/python3.12",
            "/usr/bin/perl",
            "/usr/bin/xdg-open",
            "/home/ana/bin/brave",
            "/home/ana/notes.txt",
        ] {
            assert!(custom_browser(path, Os::Linux, &files).is_err(), "{path}");
        }
        assert!(custom_browser("/opt/brave/brave", Os::Linux, &files).is_ok());
        for path in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\calc.exe",
            r"D:\tools\pwsh.exe",
        ] {
            assert!(custom_browser(path, Os::Windows, &files).is_err(), "{path}");
        }
        assert!(custom_browser(
            r"C:\Program Files\Mozilla Firefox\firefox.exe",
            Os::Windows,
            &files
        )
        .is_ok());
        assert!(in_windows_dir(r"\\?\C:\Windows\System32\cmd.exe"));
        assert!(in_windows_dir("c:/windows/notepad.exe"));
        assert!(!in_windows_dir(
            r"C:\Program Files\Windows Media Player\wmplayer.exe"
        ));
        assert!(!in_windows_dir("/windows/x"));
    }

    #[test]
    fn the_real_fs_needs_an_execute_bit_and_resolves_links() {
        let root = std::env::temp_dir().join(format!("ttd-exec-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let plain = root.join("plain");
        std::fs::write(&plain, "x").unwrap();
        let real = RealFs;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let plain = plain.to_str().unwrap();
            assert!(!real.is_executable(plain));
            std::fs::set_permissions(plain, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(real.is_executable(plain));
            let link = root.join("brave");
            std::os::unix::fs::symlink("/bin/sh", &link).unwrap();
            let resolved = real.resolve(link.to_str().unwrap()).unwrap();
            assert_ne!(stem(&resolved), "brave");
            assert!(custom_browser(link.to_str().unwrap(), Os::Linux, &real).is_err());
        }
        #[cfg(not(unix))]
        assert!(real.is_executable(plain.to_str().unwrap()));
        assert!(!real.is_executable(root.to_str().unwrap()));
        assert!(real.resolve("/nonexistent/browser").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[derive(Default)]
    struct FakeRegistry {
        keys: HashMap<(Hive, String), Vec<String>>,
        values: HashMap<(Hive, String), String>,
    }

    impl FakeRegistry {
        fn browser(
            mut self,
            hive: Hive,
            root: &str,
            key: &str,
            name: Option<&str>,
            command: &str,
        ) -> Self {
            self.keys
                .entry((hive, root.to_string()))
                .or_default()
                .push(key.to_string());
            if let Some(name) = name {
                self.values
                    .insert((hive, format!(r"{root}\{key}")), name.to_string());
            }
            self.values.insert(
                (hive, format!(r"{root}\{key}\shell\open\command")),
                command.to_string(),
            );
            self
        }
        fn app_path(mut self, hive: Hive, exe: &str, path: &str) -> Self {
            self.values
                .insert((hive, format!(r"{APP_PATHS}\{exe}")), path.to_string());
            self
        }
    }

    impl Registry for FakeRegistry {
        fn subkeys(&self, hive: Hive, path: &str) -> Vec<String> {
            self.keys
                .get(&(hive, path.to_string()))
                .cloned()
                .unwrap_or_default()
        }
        fn value(&self, hive: Hive, path: &str, name: &str) -> Option<String> {
            assert_eq!(name, "");
            self.values.get(&(hive, path.to_string())).cloned()
        }
    }

    const BRAVE: &str = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe";
    const CHROME: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
    const FIREFOX: &str = r"C:\Program Files\Mozilla Firefox\firefox.exe";
    const EDGE: &str = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
    const VIVALDI: &str = r"C:\Users\ana\AppData\Local\Vivaldi\Application\vivaldi.exe";
    const OPERA: &str = r"C:\Users\ana\AppData\Local\Programs\Opera\opera.exe";
    const CHROMIUM: &str = r"C:\Users\ana\AppData\Local\Chromium\Application\chrome.exe";

    #[test]
    fn windows_registry_lists_start_menu_and_app_paths_browsers() {
        let smi = START_MENU_INTERNET[0];
        let wow = START_MENU_INTERNET[1];
        let registry = FakeRegistry::default()
            .browser(
                Hive::CurrentUser,
                smi,
                "Brave",
                Some("Brave"),
                &format!("\"{BRAVE}\""),
            )
            .browser(
                Hive::LocalMachine,
                smi,
                "Google Chrome",
                Some("Google Chrome"),
                &format!("\"{CHROME}\""),
            )
            .browser(
                Hive::LocalMachine,
                smi,
                "FIREFOX.EXE",
                Some("Mozilla Firefox"),
                &format!("\"{FIREFOX}\" -osint -url \"%1\""),
            )
            .browser(
                Hive::LocalMachine,
                wow,
                "Microsoft Edge",
                None,
                &format!("\"{EDGE}\" --single-argument %1"),
            )
            .browser(
                Hive::CurrentUser,
                smi,
                "Vivaldi.ABC",
                Some("Vivaldi"),
                &format!("{VIVALDI} -- %1"),
            )
            .browser(
                Hive::CurrentUser,
                smi,
                "OperaStable",
                Some("Opera Stable"),
                &format!("\"{OPERA}\""),
            )
            // The same Brave registered again for all users: listed once.
            .browser(
                Hive::LocalMachine,
                smi,
                "Brave",
                Some("Brave"),
                &format!("\"{BRAVE}\""),
            )
            // Uninstalled (file gone) and broken entries are skipped.
            .browser(
                Hive::LocalMachine,
                smi,
                "Old",
                Some("Old browser"),
                r#""C:\gone\old.exe""#,
            )
            .browser(Hive::LocalMachine, smi, "Broken", None, "rundll32 url.dll")
            .browser(Hive::LocalMachine, smi, "Relative", None, "relative.exe %1")
            // Chromium has no StartMenuInternet entry, only App Paths (with an environment variable).
            .app_path(
                Hive::CurrentUser,
                "chromium.exe",
                r"%LOCALAPPDATA%\Chromium\Application\chrome.exe",
            )
            // Already listed through StartMenuInternet: not twice.
            .app_path(Hive::LocalMachine, "brave.exe", &format!("\"{BRAVE}\""))
            .app_path(Hive::LocalMachine, "firefox.exe", FIREFOX);
        let files = fs(
            &[BRAVE, CHROME, FIREFOX, EDGE, VIVALDI, OPERA, CHROMIUM],
            &[],
        );
        let env = |name: &str| {
            (name == "LOCALAPPDATA").then(|| r"C:\Users\ana\AppData\Local".to_string())
        };
        let browsers = windows_browsers(&registry, &files, &env);
        let names: Vec<_> = browsers
            .iter()
            .map(|b| (b.id.as_str(), b.name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("win:brave", "Brave"),
                ("app:chromium.exe", "Chromium"),
                ("win:google chrome", "Google Chrome"),
                ("win:microsoft edge", "Microsoft Edge"),
                ("win:firefox.exe", "Mozilla Firefox"),
                ("win:operastable", "Opera Stable"),
                ("win:vivaldi.abc", "Vivaldi"),
            ]
        );
        assert_eq!(
            browsers[0].command("https://b.example.com/"),
            vec![BRAVE, "https://b.example.com/"]
        );
        assert_eq!(browsers[1].command("https://b.example.com/")[0], CHROMIUM);
        assert!(windows_browsers(&FakeRegistry::default(), &files, &no_env).is_empty());
    }

    #[test]
    fn windows_command_and_environment_parsing() {
        assert_eq!(
            exe_from_command(r#""C:\a b\x.exe" --flag "%1""#).as_deref(),
            Some(r"C:\a b\x.exe")
        );
        assert_eq!(
            exe_from_command(r"C:\a\X.EXE -- %1").as_deref(),
            Some(r"C:\a\X.EXE")
        );
        assert_eq!(exe_from_command(r#""C:\a\x.exe"#), None);
        assert_eq!(exe_from_command(r#""x.exe""#), None);
        assert_eq!(exe_from_command(r"C:\a\x.bat"), None);
        let env = |name: &str| (name == "ProgramFiles").then(|| r"C:\Program Files".to_string());
        assert_eq!(
            expand_env(r"%ProgramFiles%\B\b.exe", &env),
            r"C:\Program Files\B\b.exe"
        );
        assert_eq!(expand_env(r"%Unknown%\b.exe", &env), r"%Unknown%\b.exe");
        assert_eq!(expand_env("100% sure", &env), "100% sure");
        assert_eq!(expand_env("%%", &env), "%%");
    }

    struct FakeLaunchServices(Vec<(&'static str, Option<&'static str>)>);

    impl LaunchServices for FakeLaunchServices {
        fn https_handlers(&self) -> Vec<String> {
            self.0.iter().map(|(id, _)| id.to_string()).collect()
        }
        fn app_path(&self, bundle_id: &str) -> Option<String> {
            self.0
                .iter()
                .find(|(id, _)| *id == bundle_id)
                .and_then(|(_, path)| path.map(str::to_string))
        }
    }

    #[test]
    fn macos_handlers_become_app_bundles() {
        let services = FakeLaunchServices(vec![
            ("com.brave.Browser", Some("/Applications/Brave Browser.app")),
            ("com.apple.Safari", Some("/Applications/Safari.app")),
            ("org.mozilla.firefox", Some("/Applications/Firefox.app")),
            ("com.google.Chrome", Some("/Applications/Google Chrome.app")),
            (
                "com.microsoft.edgemac",
                Some("/Applications/Microsoft Edge.app"),
            ),
            ("com.vivaldi.Vivaldi", Some("/Applications/Vivaldi.app")),
            ("com.operasoftware.Opera", Some("/Applications/Opera.app")),
            (
                "org.chromium.Chromium",
                Some("/Users/ana/Applications/Chromium.app/"),
            ),
            ("com.brave.Browser", Some("/Applications/Brave Browser.app")),
            ("com.example.gone", None),
            ("com.example.tool", Some("/usr/local/bin/tool")),
        ]);
        let files = fs(
            &[],
            &[
                "/Applications/Brave Browser.app",
                "/Applications/Safari.app",
                "/Applications/Firefox.app",
                "/Applications/Google Chrome.app",
                "/Applications/Microsoft Edge.app",
                "/Applications/Vivaldi.app",
                "/Applications/Opera.app",
                "/Users/ana/Applications/Chromium.app/",
                "/usr/local/bin/tool",
            ],
        );
        let browsers = macos_browsers(&services, &files);
        let names: Vec<_> = browsers.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Brave Browser",
                "Chromium",
                "Firefox",
                "Google Chrome",
                "Microsoft Edge",
                "Opera",
                "Safari",
                "Vivaldi"
            ]
        );
        assert_eq!(browsers[0].id, "mac:com.brave.browser");
        assert_eq!(
            browsers[0].command("https://b.example.com/"),
            vec![
                "/usr/bin/open",
                "-a",
                "/Applications/Brave Browser.app",
                "https://b.example.com/"
            ]
        );
    }

    struct FakeDesktop(Vec<(&'static str, &'static str)>);

    impl DesktopFiles for FakeDesktop {
        fn entries(&self) -> Vec<(String, String)> {
            self.0
                .iter()
                .map(|(id, c)| (id.to_string(), c.to_string()))
                .collect()
        }
    }

    const BRAVE_DEB: &str = "[Desktop Entry]\nVersion=1.0\nName=Brave Web Browser\nName[es]=Navegador Brave\nExec=/usr/bin/brave-browser-stable %U\nType=Application\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n\n[Desktop Action new-window]\nName=New Window\nExec=/usr/bin/brave-browser-stable\n";
    const BRAVE_FLATPAK: &str = "[Desktop Entry]\nName=Brave\nExec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=brave --file-forwarding com.brave.Browser @@u %U @@\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const BRAVE_SNAP: &str = "[Desktop Entry]\nName=Brave Web Browser\nExec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/brave_brave.desktop /snap/bin/brave %U\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const FIREFOX_DESKTOP: &str = "[Desktop Entry]\nName=Firefox\nExec=firefox --name \"Fire fox\" %u\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const CHROMIUM_SNAP: &str = "[Desktop Entry]\nName=Chromium\nExec=chromium %U\nType=Application\nMimeType=x-scheme-handler/https\n";
    const EDGE_DESKTOP: &str = "[Desktop Entry]\nName=Microsoft Edge\nExec=/usr/bin/microsoft-edge-stable %U\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const VIVALDI_DESKTOP: &str = "[Desktop Entry]\nName=Vivaldi\nExec=/usr/bin/vivaldi-stable --app-url=%u\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const OPERA_FLATPAK: &str = "[Desktop Entry]\nName=Opera\nExec=/usr/bin/flatpak run com.opera.Opera\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const EDITOR: &str = "[Desktop Entry]\nName=Text Editor\nExec=gedit %U\nType=Application\nMimeType=text/plain;\n";
    const HIDDEN_CHROME: &str = "[Desktop Entry]\nName=Google Chrome\nExec=/usr/bin/google-chrome-stable %U\nType=Application\nHidden=true\nMimeType=x-scheme-handler/https;\n";
    const CHROME_DESKTOP: &str = "[Desktop Entry]\nName=Google Chrome\nExec=/usr/bin/google-chrome-stable %U\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const LINK: &str = "[Desktop Entry]\nName=Docs\nType=Link\nURL=https://example.com\nMimeType=x-scheme-handler/https;\n";
    const BROKEN: &str = "[Desktop Entry]\nName=Broken\nExec=\"unterminated %U\nType=Application\nMimeType=x-scheme-handler/https;\n";
    // The URL inside a shell command string (GC-I1): never offered.
    const SHELL_WRAPPED: &str = "[Desktop Entry]\nName=Wrapped\nExec=sh -c \"browser %u\"\nType=Application\nMimeType=x-scheme-handler/https;\n";
    const SHELL_ENV: &str = "[Desktop Entry]\nName=Wrapped too\nExec=env A=b /bin/bash -lc \"exec browser \\\"$1\\\"\" _ %u\nType=Application\nMimeType=x-scheme-handler/https;\n";

    #[test]
    fn exec_lines_that_hand_the_url_to_a_shell_are_refused() {
        let wrapped = |exec: &str| shell_wrapped(&parse_exec(exec, "X").unwrap());
        assert!(wrapped(r#"sh -c "browser %u""#));
        assert!(wrapped(r#"/bin/bash -c "exec /opt/b/brave %u""#));
        assert!(wrapped(r#"env A=b /usr/bin/dash -ec 'x' _ %u"#));
        assert!(wrapped(r#"/opt/run "--open %u now""#));
        assert!(!wrapped("/usr/bin/brave-browser-stable %U"));
        assert!(!wrapped("firefox --name \"Fire fox\" %u"));
        assert!(!wrapped(
            "env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/brave_brave.desktop /snap/bin/brave %U"
        ));
        assert!(!wrapped("/usr/bin/chromium --class=Chromium --url=%u"));
    }

    #[test]
    fn linux_desktop_entries_with_https_handlers() {
        let files = FakeDesktop(vec![
            // User dir first: hides the system Chrome.
            ("google-chrome.desktop", HIDDEN_CHROME),
            ("brave-browser.desktop", BRAVE_DEB),
            ("com.brave.Browser.desktop", BRAVE_FLATPAK),
            ("brave_brave.desktop", BRAVE_SNAP),
            ("firefox.desktop", FIREFOX_DESKTOP),
            ("chromium_chromium.desktop", CHROMIUM_SNAP),
            ("microsoft-edge.desktop", EDGE_DESKTOP),
            ("vivaldi-stable.desktop", VIVALDI_DESKTOP),
            ("com.opera.Opera.desktop", OPERA_FLATPAK),
            ("org.gnome.gedit.desktop", EDITOR),
            ("google-chrome.desktop", CHROME_DESKTOP),
            ("docs.desktop", LINK),
            ("broken.desktop", BROKEN),
            ("wrapped.desktop", SHELL_WRAPPED),
            ("wrapped-env.desktop", SHELL_ENV),
        ]);
        let browsers = linux_browsers(&files);
        let ids: Vec<_> = browsers
            .iter()
            .map(|b| (b.id.as_str(), b.name.as_str()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("desktop:com.brave.Browser.desktop", "Brave"),
                ("desktop:brave-browser.desktop", "Brave Web Browser"),
                ("desktop:brave_brave.desktop", "Brave Web Browser"),
                ("desktop:chromium_chromium.desktop", "Chromium"),
                ("desktop:firefox.desktop", "Firefox"),
                ("desktop:microsoft-edge.desktop", "Microsoft Edge"),
                ("desktop:com.opera.Opera.desktop", "Opera"),
                ("desktop:vivaldi-stable.desktop", "Vivaldi"),
            ]
        );
        let url = "https://b.example.com/x";
        let command = |id: &str| browsers.iter().find(|b| b.id == id).unwrap().command(url);
        assert_eq!(
            command("desktop:brave-browser.desktop"),
            vec!["/usr/bin/brave-browser-stable", url]
        );
        assert_eq!(
            command("desktop:com.brave.Browser.desktop"),
            vec![
                "/usr/bin/flatpak",
                "run",
                "--branch=stable",
                "--arch=x86_64",
                "--command=brave",
                "--file-forwarding",
                "com.brave.Browser",
                "@@u",
                url,
                "@@"
            ]
        );
        assert_eq!(
            command("desktop:brave_brave.desktop"),
            vec![
                "env",
                "BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/brave_brave.desktop",
                "/snap/bin/brave",
                url
            ]
        );
        assert_eq!(
            command("desktop:firefox.desktop"),
            vec!["firefox", "--name", "Fire fox", url]
        );
        assert_eq!(
            command("desktop:vivaldi-stable.desktop"),
            vec![
                "/usr/bin/vivaldi-stable",
                "--app-url=https://b.example.com/x"
            ]
        );
        // No URL field code: the URL is appended.
        assert_eq!(
            command("desktop:com.opera.Opera.desktop"),
            vec!["/usr/bin/flatpak", "run", "com.opera.Opera", url]
        );
    }

    #[test]
    fn exec_field_codes_and_escapes() {
        let lit = |s: &str| Arg::Lit(s.to_string());
        assert_eq!(
            parse_exec("app %i %k %c %% %U", "My App"),
            Some(vec![lit("app"), lit("My App"), lit("%"), Arg::url()])
        );
        assert_eq!(
            parse_exec(r#""/opt/My Browser/run" "a \"q\" \$x \\ \`" %u"#, "B"),
            Some(vec![
                lit("/opt/My Browser/run"),
                lit(r#"a "q" $x \ `"#),
                Arg::url()
            ])
        );
        assert_eq!(
            parse_exec(r#""my\sapp" my\sx %u"#, "B"),
            Some(vec![lit("my app"), lit("my"), lit("x"), Arg::url()])
        );
        // Only the first URL code is used.
        assert_eq!(
            parse_exec("app %u %U", "B"),
            Some(vec![lit("app"), Arg::url()])
        );
        assert_eq!(parse_exec("%u", "B"), None);
        assert_eq!(parse_exec("", "B"), None);
        assert_eq!(parse_exec("\"open", "B"), None);
        assert_eq!(parse_exec("app \"x\\", "B"), None);
        assert_eq!(
            parse_exec(r#"app "\n" \q"#, "B"),
            Some(vec![lit("app"), lit("\n"), lit(r"\q"), Arg::url()])
        );
        assert_eq!(
            parse_exec("app\\", "B"),
            Some(vec![lit("app\\"), Arg::url()])
        );
        let entry = parse_desktop("# comment\n[Other]\nName=No\n[Desktop Entry]\n# c\nName=Yes\nbogus line\nType=Application\n");
        assert_eq!(entry.name, "Yes");
        assert!(entry.application);
        // An entry without a name uses its id.
        let unnamed = FakeDesktop(vec![(
            "x-www.desktop",
            "[Desktop Entry]\nExec=xb %u\nType=Application\nMimeType=x-scheme-handler/https;\n",
        )]);
        assert_eq!(linux_browsers(&unnamed)[0].name, "x-www");
    }

    #[test]
    fn xdg_dirs_include_flatpak_and_snap() {
        let env = |name: &str| match name {
            "HOME" => Some("/home/ana".to_string()),
            "XDG_DATA_DIRS" => {
                Some("/usr/share:relative:/var/lib/flatpak/exports/share/".to_string())
            }
            _ => None,
        };
        assert_eq!(
            xdg_application_dirs(&env),
            vec![
                "/home/ana/.local/share/applications",
                "/usr/share/applications",
                "/var/lib/flatpak/exports/share/applications",
                "/home/ana/.local/share/flatpak/exports/share/applications",
                "/var/lib/snapd/desktop/applications",
            ]
        );
        let defaults = xdg_application_dirs(&no_env);
        assert_eq!(defaults[0], "/usr/local/share/applications");
        assert!(defaults.contains(&"/usr/share/applications".to_string()));
        let custom = |name: &str| (name == "XDG_DATA_HOME").then(|| "/data".to_string());
        assert_eq!(xdg_application_dirs(&custom)[0], "/data/applications");
    }

    #[test]
    fn real_desktop_files_walk_subdirectories() {
        let root = std::env::temp_dir().join(format!("ttd-browser-test-{}", std::process::id()));
        let apps = root.join("applications");
        std::fs::create_dir_all(apps.join("kde")).unwrap();
        std::fs::write(apps.join("brave-browser.desktop"), BRAVE_DEB).unwrap();
        std::fs::write(apps.join("kde").join("konqueror.desktop"), FIREFOX_DESKTOP).unwrap();
        std::fs::write(apps.join("notes.txt"), "x").unwrap();
        let files = RealDesktopFiles(vec![
            apps.to_string_lossy().into_owned(),
            "/nonexistent/applications".into(),
        ]);
        let ids: Vec<_> = files.entries().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec!["brave-browser.desktop", "kde-konqueror.desktop"]);
        std::fs::remove_dir_all(root).unwrap();
        let real = RealFs;
        assert!(real.is_dir("/") && !real.is_file("/"));
    }

    #[test]
    fn plan_uses_the_system_default_or_falls_back() {
        let brave = Browser {
            id: "desktop:brave-browser.desktop".into(),
            name: "Brave".into(),
            argv: vec![Arg::Lit("/usr/bin/brave".into()), Arg::url()],
        };
        let url = "https://b.example.com/";
        let never = || -> Vec<Browser> { panic!("no detection for the system default") };
        let no_custom = |_: &str| -> Result<Browser, String> { panic!("no custom browser") };
        // System default (e.g. Brave set as the OS default): the opener with no override, never another browser.
        assert_eq!(plan(&Choice::System, url, never, no_custom), Plan::System);
        let list = || vec![brave.clone()];
        assert_eq!(
            plan(
                &Choice::Detected {
                    id: brave.id.clone(),
                    name: "Brave".into()
                },
                url,
                list,
                no_custom
            ),
            Plan::Launch(vec!["/usr/bin/brave".into(), url.into()])
        );
        // Uninstalled since it was chosen.
        assert_eq!(
            plan(
                &Choice::Detected {
                    id: "desktop:gone.desktop".into(),
                    name: "Gone".into()
                },
                url,
                list,
                no_custom
            ),
            Plan::Fallback
        );
        let files = fs(&["/opt/b/brave"], &[]);
        let custom = |path: &str| custom_browser(path, Os::Linux, &files);
        assert_eq!(
            plan(
                &Choice::Custom {
                    path: "/opt/b/brave".into(),
                    name: "brave".into()
                },
                url,
                Vec::new,
                custom
            ),
            Plan::Launch(vec!["/opt/b/brave".into(), url.into()])
        );
        assert_eq!(
            plan(
                &Choice::Custom {
                    path: "/opt/b/gone".into(),
                    name: "gone".into()
                },
                url,
                Vec::new,
                custom
            ),
            Plan::Fallback
        );
    }

    #[test]
    fn the_webview_can_ask_for_the_default_or_a_detected_browser_but_never_a_path() {
        let parse = |json: &str| serde_json::from_str::<Request>(json);
        assert_eq!(parse(r#"{"kind":"system"}"#).unwrap(), Request::System);
        assert_eq!(
            parse(r#"{"kind":"detected","id":"x","name":"X"}"#).unwrap(),
            Request::Detected { id: "x".into() }
        );
        // No custom path (only the native file dialog of `pick_browser` sets one), no other kind.
        assert!(parse(r#"{"kind":"custom","path":"/bin/sh","name":"b"}"#).is_err());
        assert!(parse(r#"{"kind":"shell","cmd":"x"}"#).is_err());
        let list = || {
            vec![Browser {
                id: "win:brave".into(),
                name: "Brave".into(),
                argv: vec![Arg::Lit(r"C:\b\brave.exe".into()), Arg::url()],
            }]
        };
        assert_eq!(
            resolve_request(&Request::System, || panic!("no detection")),
            Ok(Choice::System)
        );
        assert_eq!(
            resolve_request(
                &Request::Detected {
                    id: "win:brave".into()
                },
                list
            ),
            Ok(Choice::Detected {
                id: "win:brave".into(),
                name: "Brave".into()
            })
        );
        assert!(resolve_request(
            &Request::Detected {
                id: "win:gone".into()
            },
            list
        )
        .is_err());
    }

    #[test]
    fn the_choice_is_kept_on_this_side_and_read_back_sanitised() {
        assert_eq!(parse_stored(r#"{"kind":"system"}"#), Choice::System);
        assert_eq!(
            parse_stored(r#"{"kind":"detected","id":"x","name":"X"}"#),
            Choice::Detected {
                id: "x".into(),
                name: "X".into()
            }
        );
        assert_eq!(
            parse_stored(r#"{"kind":"custom","path":"/b","name":"b"}"#),
            Choice::Custom {
                path: "/b".into(),
                name: "b".into()
            }
        );
        let long = format!(
            r#"{{"kind":"custom","path":"/{}","name":"b"}}"#,
            "x".repeat(5000)
        );
        for bad in [
            "",
            "not json",
            r#"{"kind":"shell","cmd":"x"}"#,
            r#"{"kind":"detected","id":" ","name":"X"}"#,
            r#"{"kind":"custom","path":"/b"}"#,
            long.as_str(),
        ] {
            assert_eq!(parse_stored(bad), Choice::System, "{bad}");
        }
        let root = std::env::temp_dir().join(format!("ttd-browser-{}", std::process::id()));
        let file = root.join("config").join("browser.json");
        let state = BrowserState::load(Some(file.clone()));
        assert_eq!(state.get(), Choice::System);
        let brave = Choice::Detected {
            id: "desktop:brave-browser.desktop".into(),
            name: "Brave".into(),
        };
        assert_eq!(state.set(brave.clone()), Ok(brave.clone()));
        assert_eq!(BrowserState::load(Some(file.clone())).get(), brave);
        assert_eq!(
            serde_json::to_string(&brave).unwrap(),
            r#"{"kind":"detected","id":"desktop:brave-browser.desktop","name":"Brave"}"#
        );
        state.set(Choice::System).unwrap();
        assert_eq!(BrowserState::load(Some(file)).get(), Choice::System);
        // Without a config folder the choice lives for this run only.
        let memory = BrowserState::load(None);
        memory.set(brave.clone()).unwrap();
        assert_eq!(memory.get(), brave);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn os_detection_and_spawning() {
        assert_eq!(
            Os::current(),
            if cfg!(windows) {
                Os::Windows
            } else if cfg!(target_os = "macos") {
                Os::Mac
            } else {
                Os::Linux
            }
        );
        // Detection runs on this machine without failing (whatever is installed).
        let _ = detect();
        assert!(spawn(&[]).is_err());
        assert!(spawn(&["/nonexistent/browser".into()]).is_err());
        #[cfg(unix)]
        assert!(spawn(&["true".into()]).is_ok());
    }
}
