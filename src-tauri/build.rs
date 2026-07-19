fn main() {
    println!("cargo:rerun-if-env-changed=CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL");
    tauri_build::build()
}
