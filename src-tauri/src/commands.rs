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
use serde_json::Value;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::{env, fs, path::PathBuf};
use tauri::ipc::Channel;

// Drain both pipes while waiting: a blocked child must not freeze the UI or
// deadlock on a full stderr buffer. Diagnostics are never returned verbatim.
fn bounded_output(
    command: &mut Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |mut pipe: Box<dyn Read + Send>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let keep = n.min(65536usize.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&chunk[..keep]);
            }
            let _ = tx.send(bytes);
        });
        rx
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let remaining = timeout.saturating_sub(started.elapsed());
            let stdout = out.recv_timeout(remaining).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "Codex 输出未关闭。")
            })?;
            let stderr = err
                .recv_timeout(timeout.saturating_sub(started.elapsed()))
                .map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "Codex 输出未关闭。")
                })?;
            return Ok(std::process::Output {
                status,
                stdout,
                stderr,
            });
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Codex 命令超时，已停止等待。",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

#[derive(Debug, Clone)]
struct CodexExecutable {
    path: PathBuf,
    source: String,
    version: String,
}

fn command_for(path: &PathBuf) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

pub(crate) fn bundled_model_catalog() -> Result<Value, SwitcherError> {
    #[cfg(debug_assertions)]
    if let Some(raw) = env::var_os(super::BUNDLED_MODEL_CATALOG_ENV) {
        let catalog: Value = serde_json::from_str(&raw.to_string_lossy())
            .map_err(|_| SwitcherError::Message("隔离测试模型目录不是有效 JSON。".into()))?;
        if catalog
            .get("models")
            .and_then(Value::as_array)
            .is_some_and(|models| !models.is_empty())
        {
            return Ok(catalog);
        }
        return Err(SwitcherError::Message("隔离测试模型目录为空。".into()));
    }
    let executable = locate_codex()?;
    let isolated_home = super::app_data_dir()?.join("model-catalog-discovery-home");
    fs::create_dir_all(&isolated_home)?;
    read_model_catalog_with_retry(
        || {
            bounded_output(
                command_for(&executable.path)
                    .args(["debug", "models", "--bundled"])
                    .env("CODEX_HOME", &isolated_home),
                std::time::Duration::from_secs(10),
            )
        },
        || std::thread::sleep(std::time::Duration::from_millis(500)),
    )
}

// Retry transient startup failures with a short bounded backoff. Callers decide
// whether missing catalogue data is blocking or an optional degradation.
fn read_model_catalog_with_retry(
    mut read: impl FnMut() -> std::io::Result<std::process::Output>,
    mut pause: impl FnMut(),
) -> Result<Value, SwitcherError> {
    let mut last_error =
        "无法读取本机 Codex 自带的模型目录。请确认 Codex CLI 可正常运行后重试。".to_string();
    for attempt in 0..3 {
        let output = match read() {
            Ok(output) => output,
            Err(_) => {
                last_error =
                    "无法启动 Codex 模型目录读取命令。请确认 Codex CLI 可正常运行后重试。".into();
                if attempt < 2 {
                    pause();
                    continue;
                }
                break;
            }
        };
        if !output.status.success() {
            last_error =
                "无法读取本机 Codex 自带的模型目录。请确认 Codex CLI 可正常运行后重试。".into();
        } else {
            match serde_json::from_slice::<Value>(&output.stdout) {
                Ok(catalog)
                    if catalog
                        .get("models")
                        .and_then(Value::as_array)
                        .is_some_and(|models| !models.is_empty()) =>
                {
                    return Ok(catalog);
                }
                Ok(_) => {
                    last_error = "Codex 内置模型目录为空，已停止生成自定义目录。".into();
                }
                Err(_) => {
                    last_error = "Codex 返回的内置模型目录不是有效 JSON。".into();
                }
            }
        }
        if attempt < 2 {
            pause();
        }
    }
    Err(SwitcherError::Message(last_error))
}

fn codex_candidates() -> Vec<(PathBuf, String)> {
    let mut candidates = Vec::new();
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let bin = PathBuf::from(local)
            .join("OpenAI")
            .join("Codex")
            .join("bin");
        let direct = bin.join("codex.exe");
        if let Ok(entries) = fs::read_dir(bin) {
            let mut versioned = entries
                .flatten()
                .map(|entry| entry.path().join("codex.exe"))
                .filter(|path| path.is_file())
                .collect::<Vec<_>>();
            versioned.sort_by(|left, right| right.cmp(left));
            candidates.extend(
                versioned
                    .into_iter()
                    .map(|path| (path, "Codex Desktop".to_string())),
            );
        }
        if direct.is_file() {
            candidates.push((direct, "Codex Desktop".to_string()));
        }
    }
    if let Some(appdata) = env::var_os("APPDATA") {
        for name in ["codex.cmd", "codex.exe"] {
            let path = PathBuf::from(&appdata).join("npm").join(name);
            if path.is_file() {
                candidates.push((path, "npm".to_string()));
            }
        }
    }
    candidates.push((PathBuf::from("codex.exe"), "PATH".to_string()));
    candidates.push((PathBuf::from("codex"), "PATH".to_string()));
    candidates
}

fn locate_codex() -> Result<CodexExecutable, SwitcherError> {
    let mut diagnostics = Vec::new();
    let mut valid = Vec::new();
    for (path, source) in codex_candidates() {
        match bounded_output(
            command_for(&path).arg("--version"),
            std::time::Duration::from_secs(3),
        ) {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                valid.push(CodexExecutable {
                    path,
                    source,
                    version,
                });
            }
            Ok(output) => diagnostics.push(format!(
                "{}（退出码 {}）",
                path.display(),
                output
                    .status
                    .code()
                    .map_or_else(|| "未知".to_string(), |code| code.to_string())
            )),
            Err(error) => diagnostics.push(format!("{}（{}）", path.display(), error)),
        }
    }
    valid.sort_by(|left, right| {
        let source_rank = |source: &str| match source {
            "Codex Desktop" => 3,
            "npm" => 2,
            _ => 1,
        };
        source_rank(&right.source)
            .cmp(&source_rank(&left.source))
            .then_with(|| codex_semver(&right.version).cmp(&codex_semver(&left.version)))
    });
    if let Some(executable) = valid.into_iter().next() {
        return Ok(executable);
    }
    Err(SwitcherError::Message(format!(
        "已检查 Codex Desktop、PATH 和 npm 安装，但没有找到可运行的 Codex。检查结果：{}",
        diagnostics.join("；")
    )))
}

fn codex_semver(output: &str) -> semver::Version {
    output
        .split_whitespace()
        .find_map(|part| semver::Version::parse(part).ok())
        .unwrap_or_else(|| semver::Version::new(0, 0, 0))
}

fn chatgpt_login_status_from_output(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    executable: &CodexExecutable,
) -> ChatGptLoginStatus {
    let status_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_lowercase();
    let connected = success
        && status_text.contains("logged in using chatgpt")
        && !status_text.contains("not logged in");
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
            "尚未确认 ChatGPT 官方登录；API Key 登录不算官方账号授权。"
        }
        .to_string(),
        executable_path: Some(executable.path.display().to_string()),
        executable_source: Some(executable.source.clone()),
        codex_version: Some(executable.version.clone()),
        checked_at: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
    }
}

#[tauri::command]
pub(crate) async fn begin_chatgpt_login() -> Result<ChatGptLoginStatus, SwitcherError> {
    super::run_blocking_command(|| {
        let executable = locate_codex()?;
        let current = bounded_output(
            super::qa::login_command(&executable.path)?.args(["login", "status"]),
            std::time::Duration::from_secs(8),
        )
        .map_err(|error| SwitcherError::Message(format!("无法读取 Codex 登录状态：{error}")))?;
        let mut status = chatgpt_login_status_from_output(
            current.status.success(),
            &current.stdout,
            &current.stderr,
            &executable,
        );
        if status.state == "connected" {
            return Ok(status);
        }
        if super::qa::login_is_running()? {
            status.state = "waiting".to_string();
            status.detail = "Codex 官方登录仍在进行中；继续使用当前浏览器窗口完成授权。".to_string();
            return Ok(status);
        }
        let mut command = super::qa::login_command(&executable.path)?;
        command
            .arg("login")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::qa::start_login(command)?;
        Ok(ChatGptLoginStatus {
            state: "waiting".to_string(),
            detail: "已启动 Codex 登录进程，等待官方授权。若浏览器未打开，请取消后重试；此时尚未登录成功。".to_string(),
            executable_path: Some(executable.path.display().to_string()),
            executable_source: Some(executable.source),
            codex_version: Some(executable.version),
            checked_at: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_chatgpt_login_status() -> Result<ChatGptLoginStatus, SwitcherError> {
    super::run_blocking_command(|| {
        let executable = locate_codex()?;
        let output = bounded_output(
            super::qa::login_command(&executable.path)?.args(["login", "status"]),
            std::time::Duration::from_secs(8),
        )
        .map_err(|error| SwitcherError::Message(format!("无法读取 Codex 登录状态：{error}")))?;
        let mut status = chatgpt_login_status_from_output(
            output.status.success(),
            &output.stdout,
            &output.stderr,
            &executable,
        );
        if status.state != "connected" && super::qa::login_is_running()? {
            status.state = "waiting".to_string();
            status.detail =
                "Codex 官方登录仍在进行中；请在已打开的浏览器窗口完成授权。".to_string();
        }
        Ok(status)
    })
    .await
}

#[tauri::command]
pub(crate) async fn activate_official_provider(model: String) -> Result<AppState, SwitcherError> {
    let _scope = super::qa::operation_scope()?;
    let status = get_chatgpt_login_status().await?;
    if status.state != "connected" {
        return Err(SwitcherError::Message(
            "请先完成 ChatGPT 官方账号登录；不会使用 API Key 冒充官方身份。".into(),
        ));
    }
    super::run_blocking_command(move || super::activate_official_provider_core(&model)).await
}

#[tauri::command]
pub(crate) async fn qa_open_codex_target() -> Result<String, SwitcherError> {
    super::run_blocking_command(|| {
        let home = super::qa::validate_live()?;
        let executable = locate_codex()?;
        super::qa::open_codex_target(&executable.path, &home)?;
        Ok(
            "已启动读取当前副本的 Codex CLI；请在终端正常使用。这不代表桌面语音或插件已验证。"
                .into(),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{chatgpt_login_status_from_output, codex_semver, CodexExecutable};
    use std::path::PathBuf;

    fn catalog_output(success: bool, bytes: &[u8]) -> std::process::Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 256 }),
            stdout: bytes.to_vec(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn model_catalog_retries_each_transient_failure_once() {
        for failure in 0..4 {
            let mut calls = 0;
            let mut pauses = 0;
            let result = super::read_model_catalog_with_retry(
                || {
                    calls += 1;
                    if calls > 1 {
                        return Ok(catalog_output(true, br#"{"models":[{"slug":"test"}]}"#));
                    }
                    match failure {
                        0 => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "fixture")),
                        1 => Ok(catalog_output(false, b"")),
                        2 => Ok(catalog_output(true, br#"{"models":[]}"#)),
                        _ => Ok(catalog_output(true, b"invalid json")),
                    }
                },
                || pauses += 1,
            );
            assert!(result.is_ok());
            assert_eq!(calls, 2);
            assert_eq!(pauses, 1);
        }
    }

    #[test]
    fn model_catalog_persistent_failure_is_not_reported_as_success() {
        let mut calls = 0;
        let result = super::read_model_catalog_with_retry(
            || {
                calls += 1;
                Ok(catalog_output(true, br#"{"models":[]}"#))
            },
            || {},
        );
        assert!(result.is_err());
        assert_eq!(calls, 3);
    }

    #[test]
    fn model_catalog_success_does_not_retry() {
        let result = super::read_model_catalog_with_retry(
            || Ok(catalog_output(true, br#"{"models":[{}]}"#)),
            || panic!("successful reads must not pause"),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn model_catalog_retries_twice_before_reporting_persistent_failure() {
        let mut calls = 0;
        let mut pauses = 0;
        let result = super::read_model_catalog_with_retry(
            || {
                calls += 1;
                Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "fixture"))
            },
            || pauses += 1,
        );
        assert!(result.is_err());
        assert_eq!(calls, 3);
        assert_eq!(pauses, 2);
    }

    fn executable() -> CodexExecutable {
        CodexExecutable {
            path: PathBuf::from("codex.exe"),
            source: "test".to_string(),
            version: "codex-cli 1.2.3".to_string(),
        }
    }

    #[test]
    fn chatgpt_login_status_accepts_the_codex_logged_in_message() {
        let status =
            chatgpt_login_status_from_output(true, b"Logged in using ChatGPT", b"", &executable());
        assert_eq!(status.state, "connected");
    }

    #[test]
    fn api_key_or_ambiguous_login_is_not_chatgpt() {
        for text in [
            "Logged in using an API key",
            "Logged in",
            "Not logged in using ChatGPT",
        ] {
            assert_eq!(
                chatgpt_login_status_from_output(true, text.as_bytes(), b"", &executable()).state,
                "not_connected"
            );
        }
    }

    #[test]
    fn chatgpt_login_status_does_not_treat_not_logged_in_as_connected() {
        let status = chatgpt_login_status_from_output(true, b"Not logged in", b"", &executable());
        assert_eq!(status.state, "not_connected");
    }

    #[test]
    fn chatgpt_login_status_requires_a_successful_codex_command() {
        let status = chatgpt_login_status_from_output(
            false,
            b"Logged in using ChatGPT",
            b"command failed",
            &executable(),
        );
        assert_eq!(status.state, "not_connected");
    }

    #[test]
    fn codex_version_output_is_ranked_semantically() {
        assert!(
            codex_semver("codex-cli 0.154.0-alpha.6.2") > codex_semver("codex-cli 0.130.0-alpha.5")
        );
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
