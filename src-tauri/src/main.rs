#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    let action = args.next();
    if action.as_deref() == Some("--qa-emergency-restore") {
        match codex_switcher_tauri_lib::qa_emergency_restore() {
            Ok(()) => return,
            Err(_error) => {
                eprintln!("紧急恢复未完成，请在 Signalman 中查看诊断信息。");
                std::process::exit(1);
            }
        }
    }
    if action.as_deref() == Some("--run-protocol-gateway") {
        match codex_switcher_tauri_lib::run_protocol_gateway() {
            Ok(()) => return,
            Err(_error) => {
                eprintln!("协议网关启动失败，请在 Signalman 中查看诊断信息。");
                std::process::exit(1);
            }
        }
    }
    if action.as_deref() == Some("--print-provider-token") {
        let Some(profile_id) = args.next().filter(|value| !value.trim().is_empty()) else {
            eprintln!("缺少服务商标识。");
            std::process::exit(2);
        };
        let Some(data_root) = args.next() else {
            eprintln!("凭据助手缺少绑定资料目录，请在 Signalman 重新切换服务商。");
            std::process::exit(2);
        };
        match codex_switcher_tauri_lib::read_bound_provider_token(&data_root, &profile_id) {
            Ok(token) => {
                // lgtm [rust/cleartext-logging] The credential-helper contract
                // intentionally emits the selected token on stdout to Codex;
                // it is never written to a log file.
                print!("{token}");
                return;
            }
            Err(error) => {
                let _ = error;
                eprintln!("无法读取绑定服务商凭据，请检查资料目录与服务商是否仍存在。");
                std::process::exit(1);
            }
        }
    }
    codex_switcher_tauri_lib::run()
}
