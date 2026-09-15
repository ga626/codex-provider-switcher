//! Thin Tauri command adapters.
//!
//! Business functions stay callable from the desktop app, the local parity
//! backend, and focused tests. Network-bound desktop commands live here so
//! `lib.rs` remains the composition root instead of another growing UI/API
//! boundary.

use super::{
    check_for_update_core, prepare_switch_core, preview_models_core, refresh_models_core,
    run_blocking_command_with_events, run_response_probe_for_model_core, verify_profile_core,
    AppState, ChatGptLoginStatus, EditableProfile, ModelCatalog, OperationEventV1, SwitchPreflight,
    SwitcherError, UpdateInfo,
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use tauri::ipc::Channel;

fn codex_command() -> Command {
    let mut command = Command::new("codex.exe");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

fn chatgpt_login_status_from_output(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> ChatGptLoginStatus {
    let status_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_lowercase();
    let connected =
        success && status_text.contains("logged in") && !status_text.contains("not logged in");
    ChatGptLoginStatus {
        state: if connected {
            "connected"
        } else {
            "not_connected"
        }
        .to_string(),
        detail: if connected {
            "Codex 已确认 ChatGPT 官方账号登录。Signalman 不读取或显示 token。"
        } else {
            "尚未确认登录；请在 OpenAI 官方页面完成授权后重试。"
        }
        .to_string(),
    }
}

#[tauri::command]
pub(crate) async fn begin_chatgpt_login() -> Result<ChatGptLoginStatus, SwitcherError> {
    super::run_blocking_command(|| {
        codex_command()
            .arg("login")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| SwitcherError::Message(format!("无法启动 Codex 官方登录：{error}")))?;
        Ok(ChatGptLoginStatus {
            state: "waiting".to_string(),
            detail: "已打开 OpenAI 官方授权页；完成后回到 Signalman 查看结果。".to_string(),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_chatgpt_login_status() -> Result<ChatGptLoginStatus, SwitcherError> {
    super::run_blocking_command(|| {
        let output = codex_command()
            .args(["login", "status"])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| SwitcherError::Message(format!("无法读取 Codex 登录状态：{error}")))?;
        Ok(chatgpt_login_status_from_output(
            output.status.success(),
            &output.stdout,
            &output.stderr,
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::chatgpt_login_status_from_output;

    #[test]
    fn chatgpt_login_status_accepts_the_codex_logged_in_message() {
        let status = chatgpt_login_status_from_output(true, b"Logged in using ChatGPT", b"");
        assert_eq!(status.state, "connected");
    }

    #[test]
    fn chatgpt_login_status_does_not_treat_not_logged_in_as_connected() {
        let status = chatgpt_login_status_from_output(true, b"Not logged in", b"");
        assert_eq!(status.state, "not_connected");
    }

    #[test]
    fn chatgpt_login_status_requires_a_successful_codex_command() {
        let status =
            chatgpt_login_status_from_output(false, b"Logged in using ChatGPT", b"command failed");
        assert_eq!(status.state, "not_connected");
    }
}

#[tauri::command]
pub(crate) async fn check_for_update() -> Result<UpdateInfo, SwitcherError> {
    super::run_blocking_command(check_for_update_core).await
}

#[tauri::command]
pub(crate) async fn prepare_switch(
    profile_id: String,
    on_event: Channel<OperationEventV1>,
) -> Result<SwitchPreflight, SwitcherError> {
    run_blocking_command_with_events("prepare-switch", "provider", Some(on_event), move || {
        prepare_switch_core(profile_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn verify_profile(
    profile_id: String,
    on_event: Channel<OperationEventV1>,
) -> Result<AppState, SwitcherError> {
    run_blocking_command_with_events("verify-profile", "provider", Some(on_event), move || {
        verify_profile_core(profile_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn run_response_probe(
    profile_id: String,
    benchmark_model: String,
    on_event: Channel<OperationEventV1>,
) -> Result<AppState, SwitcherError> {
    run_blocking_command_with_events("run-cost-probe", "lab", Some(on_event), move || {
        run_response_probe_for_model_core(profile_id, benchmark_model)
    })
    .await
}

#[tauri::command]
pub(crate) async fn refresh_models(
    profile_id: String,
    on_event: Channel<OperationEventV1>,
) -> Result<AppState, SwitcherError> {
    run_blocking_command_with_events("refresh-models", "provider", Some(on_event), move || {
        refresh_models_core(profile_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_models(
    profile: EditableProfile,
    on_event: Channel<OperationEventV1>,
) -> Result<ModelCatalog, SwitcherError> {
    run_blocking_command_with_events("preview-models", "provider", Some(on_event), move || {
        preview_models_core(profile)
    })
    .await
}
