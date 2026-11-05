include!("app-commands.rs");

fn main() {
    // Compile-time switches read with `option_env!` in src/lib.rs (see docs/RELEASE-PLAN-0.4.0.md):
    // `TIMETRACK_CHANNEL=store` builds the Microsoft Store variant (no in-app updater) and `TAURI_UPDATER_PUBKEY`
    // overrides the updater public key of tauri.conf.json.
    println!("cargo:rerun-if-env-changed=TIMETRACK_CHANNEL");
    println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBKEY");
    println!("cargo:rerun-if-changed=app-commands.rs");
    // With an app manifest, Tauri checks every app command against the capabilities of the calling window (without
    // one, any local window could call any command): `allow-<command>` is granted per window in capabilities/.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("tauri build");
}
