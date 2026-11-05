// Every app command (`generate_handler!` in src/lib.rs). Shared by build.rs, which declares them in the app manifest
// so Tauri checks each one against the capabilities, and by the tests, which check the capabilities grant them
// per window. Keep it in step with `generate_handler!`.

/// Commands only the main window may call (capabilities/default.json).
pub const MAIN_COMMANDS: &[&str] = &[
    "secret_get",
    "secret_set",
    "secret_delete",
    "idle_seconds",
    "set_tray_status",
    "set_tray_menu",
    "set_global_shortcut",
    "check_update",
    "install_update",
    "beacon_fetch",
    "connection_security",
    "set_wake_plan",
    "notify_friendly",
    "prompt_open",
    "prompt_focus",
    "prompt_close",
];

/// Commands only the "Still there?" window may call (capabilities/prompt.json).
pub const PROMPT_COMMANDS: &[&str] = &["prompt_view", "prompt_answer", "prompt_show_main"];

pub const APP_COMMANDS: &[&str] = &[
    "secret_get",
    "secret_set",
    "secret_delete",
    "idle_seconds",
    "set_tray_status",
    "set_tray_menu",
    "set_global_shortcut",
    "check_update",
    "install_update",
    "beacon_fetch",
    "connection_security",
    "set_wake_plan",
    "notify_friendly",
    "prompt_open",
    "prompt_focus",
    "prompt_close",
    "prompt_view",
    "prompt_answer",
    "prompt_show_main",
];
