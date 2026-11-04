fn main() {
    // Compile-time switches read with `option_env!` in src/lib.rs (see docs/RELEASE-PLAN-0.4.0.md):
    // `TIMETRACK_CHANNEL=store` builds the Microsoft Store variant (no in-app updater) and `TAURI_UPDATER_PUBKEY`
    // overrides the updater public key of tauri.conf.json.
    println!("cargo:rerun-if-env-changed=TIMETRACK_CHANNEL");
    println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBKEY");
    tauri_build::build()
}
