fn main() {
    println!("cargo:rerun-if-env-changed=CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL");
    println!("cargo:rerun-if-env-changed=CODEX_PROVIDER_SWITCHER_BUILD_SHA");
    tauri_build::build()
}
