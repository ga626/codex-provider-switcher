use codex_switcher_tauri_lib::import_legacy_profile_document_core;
use std::{env, fs, process};

fn main() {
    let Some(source) = env::args().nth(1) else {
        eprintln!("Usage: profile_recovery <legacy-profiles.json>");
        process::exit(2);
    };

    let document = match fs::read_to_string(&source) {
        Ok(document) => document,
        Err(error) => {
            eprintln!("Unable to read legacy profile file: {error}");
            process::exit(1);
        }
    };

    match import_legacy_profile_document_core(document) {
        Ok(state) => {
            let recovered = state
                .profiles
                .iter()
                .filter(|profile| profile.has_api_key)
                .count();
            println!("[PASS] Legacy profile recovery completed. Protected profiles available: {recovered}");
        }
        Err(error) => {
            eprintln!("Legacy profile recovery failed: {error}");
            process::exit(1);
        }
    }
}
