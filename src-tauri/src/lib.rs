use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{
    image::Image,
    ipc::Channel,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

mod commands;
mod compat;
mod domain;
mod initialization;
mod lab;
mod protocol_gateway;
mod providers;
mod qa;
mod services;
mod storage;
mod updates;

pub use compat::import_legacy_profile_document_core;
#[allow(unused_imports)]
pub(crate) use compat::{merge_legacy_profile_document, profile_id_for_save, unique_profile_id};
pub use domain::*;
pub use initialization::initialize_with_progress;
pub(crate) use domain::{check, custom_authentication_risk, validation_checks};
pub(crate) use lab::*;
pub(crate) use providers::has_provider_error;
pub(crate) use providers::preferred_auth_mode;
#[cfg(test)]
pub(crate) use providers::uses_provider_command_auth;
use providers::{
    apply_verification, fetch_provider_models, provider_probe_endpoint, reset_profile_verification,
    verify_provider_auth_probe,
};
#[cfg(test)]
use providers::{
    build_model_catalog as provider_build_model_catalog, has_compatible_response_output,
    model_catalog_http_detail, parse_provider_models,
};
pub(crate) use services::*;
pub(crate) use storage::*;
pub use updates::check_for_update_core;

// Keep the existing data directory so installed users retain DPAPI-protected
// credentials, backups, and history when the visible product brand changes.
const APP_DIR_NAME: &str = "CodeX Provider Switcher";
const PROFILES_FILE: &str = "profiles.json";
const ACTIVITY_FILE: &str = "activity.json";
const BACKUPS_DIR: &str = "backups";
const INSTALL_BACKUP_DIR: &str = "SignalmanBackups";
const INITIAL_BACKUP_LABEL: &str = "initial-install";
const CURRENT_BACKUP_FINGERPRINT_VERSION: u8 = 3;
const CONNECTION_ENVIRONMENT_FILE: &str = "connection-environment.json";
const PENDING_TRANSACTION_FILE: &str = "pending-config-transaction.json";
const SWITCH_PREFLIGHT_FILE: &str = "pending-switch-preflight.json";
const OPERATION_RECEIPTS_FILE: &str = "config-operation-receipts.json";
const STARTUP_DIAGNOSTICS_FILE: &str = "startup-diagnostics.json";
// This is intentionally private to Signalman's development runners. Production
// installs follow Codex's documented CODEX_HOME contract.
const CODEX_HOME_ENV: &str = "CODEX_PROVIDER_SWITCHER_CODEX_HOME";
const OFFICIAL_CODEX_HOME_ENV: &str = "CODEX_HOME";
const APP_DATA_DIR_ENV: &str = "CODEX_PROVIDER_SWITCHER_APP_DATA_DIR";
const RELEASES_API_ENV: &str = "CODEX_PROVIDER_SWITCHER_RELEASES_API";
// Debug-only fixture hook used by the isolated backend smoke. Production reads
// the catalog from the installed Codex executable instead.
#[cfg(debug_assertions)]
pub(crate) const BUNDLED_MODEL_CATALOG_ENV: &str =
    "CODEX_PROVIDER_SWITCHER_BUNDLED_MODEL_CATALOG";
const RELEASES_API_URL: &str =
    "https://api.github.com/repos/ga626/codex-provider-switcher/releases?per_page=20";
const PROTECTED_FILE_SUFFIX: &str = ".dpapi";

fn is_store_release_channel() -> bool {
    matches!(
        option_env!("CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL"),
        Some("store")
    )
}

fn is_development_release_channel() -> bool {
    matches!(
        option_env!("CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL"),
        Some("development")
    )
}

fn development_fixture_roots() -> Result<(PathBuf, PathBuf, PathBuf), SwitcherError> {
    if !is_development_release_channel() {
        return Err(SwitcherError::Message(
            "QA 场景控制台只在开发版可用。".to_string(),
        ));
    }
    let project_root = env::current_dir()?;
    let runtime_root = project_root.join(".codex").join("runtime");
    let app_data = app_data_dir()?;
    let codex_home = qa::runtime_override()?
        .map(|(_, home)| home)
        .or_else(|| {
            env::var_os(CODEX_HOME_ENV)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .ok_or_else(|| {
            SwitcherError::Message("开发版缺少隔离 Codex 目录，已拒绝重置。".to_string())
        })?;
    let runtime_root = runtime_root.canonicalize()?;
    for target in [&app_data, &codex_home] {
        if !target.is_absolute()
            || target
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(SwitcherError::Message(
                "隔离路径必须是无上级跳转的绝对路径。".into(),
            ));
        }
        let ancestor = target
            .ancestors()
            .find(|path| path.exists())
            .ok_or_else(|| SwitcherError::Message("无法核对隔离目录。".into()))?
            .canonicalize()?;
        if !ancestor.starts_with(&runtime_root) {
            return Err(SwitcherError::Message(
                "隔离目录不在项目 runtime 内，未创建目录。".into(),
            ));
        }
    }
    fs::create_dir_all(&app_data)?;
    fs::create_dir_all(&codex_home)?;
    let app_data = app_data.canonicalize()?;
    let codex_home = codex_home.canonicalize()?;
    if !app_data.starts_with(&runtime_root)
        || !codex_home.starts_with(&runtime_root)
        || app_data == runtime_root
        || codex_home == runtime_root
        || app_data.starts_with(&codex_home)
        || codex_home.starts_with(&app_data)
    {
        return Err(SwitcherError::Message(
            "QA 场景只允许重置项目内的隔离 runtime；已拒绝触及其他目录。".to_string(),
        ));
    }
    Ok((project_root, app_data, codex_home))
}

fn clear_development_directory(path: &Path) -> Result<(), SwitcherError> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry_path)?;
        } else {
            fs::remove_file(entry_path)?;
        }
    }
    Ok(())
}

fn seed_daily_qa_fixture(
    project_root: &Path,
    app_data: &Path,
    codex_home: &Path,
) -> Result<(), SwitcherError> {
    let fixture_root = project_root
        .join("scripts")
        .join("qa")
        .join("fixtures")
        .join("dev-desktop");
    for file in [PROFILES_FILE, ACTIVITY_FILE] {
        let source = fixture_root.join(file);
        if !source.is_file() {
            return Err(SwitcherError::Message(format!(
                "QA 场景资料缺失：{}",
                source.display()
            )));
        }
        fs::copy(source, app_data.join(file))?;
    }
    fs::write(codex_home.join("config.toml"), "model = \"gpt-5.6-terra\"\nmodel_provider = \"custom\"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = \"服务商 A\"\nbase_url = \"https://provider-a.example/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n\n[projects]\n[features]\n[desktop]\n[memories]\n[mcp_servers]\n[plugins]\n[hooks]\n[hooks.state]\n[marketplaces]\n")?;
    fs::write(codex_home.join("auth.json"), "{}")?;
    create_backup_at(&app_data.join(BACKUPS_DIR), SIGNALMAN_TAKEOVER_BACKUP_LABEL, "signalman_initial_takeover", &codex_home.join("config.toml"), &codex_home.join("auth.json"))?;
    fs::write(app_data.join(CONNECTION_ENVIRONMENT_FILE), "{\"selected_layer_id\":\"user-config\",\"setup_completed\":true,\"onboarding_completed\":true,\"takeover_version\":1,\"takeover_backup_label\":\"signalman-initial-takeover-v1\"}")?;
    Ok(())
}

fn enrich_daily_density_fixture(app_data: &Path) -> Result<(), SwitcherError> {
    let fixture: Value =
        serde_json::from_str(include_str!("../../src/features/qa/boundary-fixture.json"))?;
    let profiles_path = app_data.join(PROFILES_FILE);
    let mut document: Value = serde_json::from_slice(&fs::read(&profiles_path)?)?;
    document["profiles"]["example-provider-a"]["name"] = fixture["currentProviderName"].clone();
    for profile in fixture["profiles"]
        .as_array()
        .ok_or_else(|| SwitcherError::Message("边界服务商资料无效。".into()))?
    {
        let id = profile["id"]
            .as_str()
            .ok_or_else(|| SwitcherError::Message("边界服务商缺少标识。".into()))?;
        let stored = json!({
            "name": profile["name"], "base_url": profile["baseUrl"],
            "api_key": if profile["hasApiKey"] == true { "development-placeholder" } else { "" },
            "model": profile["model"], "model_reasoning_effort": profile["reasoningEffort"],
            "note": profile["note"], "verified": profile["verified"],
            "verification_status": profile["verificationStatus"], "default": false,
            "last_verified_at": profile["lastVerifiedAt"],
            "last_verification_detail": profile["lastVerificationDetail"],
            "last_verification_stage": profile["lastVerificationStage"]
        });
        // 通过真实存储类型校验，不允许静默注入不存在的字段/状态形状。
        serde_json::from_value::<StoredProfile>(stored.clone())?;
        document["profiles"][id] = stored;
        document["profile_order"]
            .as_array_mut()
            .ok_or_else(|| SwitcherError::Message("缺少服务商排序。".into()))?
            .push(json!(id));
    }
    for catalog in fixture["modelCatalogs"]
        .as_array()
        .ok_or_else(|| SwitcherError::Message("边界模型资料无效。".into()))?
    {
        serde_json::from_value::<ModelCatalog>(catalog.clone())?;
        let id = catalog["providerId"].as_str().unwrap_or_default();
        document["model_catalogs"][id] = catalog.clone();
    }
    for (target, source) in [
        ("cost_calibrations", "costCalibrations"),
        ("response_probes", "responseProbes"),
    ] {
        if !document[target].is_array() {
            document[target] = json!([]);
        }
        document[target]
            .as_array_mut()
            .unwrap()
            .extend(fixture[source].as_array().cloned().unwrap_or_default());
    }
    document["backup_policy"] = json!({ "automaticLimit": 10, "manualLimit": 10 });
    serde_json::from_value::<StoredCatalog>(document.clone())?;
    fs::write(profiles_path, serde_json::to_vec_pretty(&document)?)?;
    let activity_path = app_data.join(ACTIVITY_FILE);
    let mut activity = fixture["activity"].as_array().cloned().unwrap_or_default();
    activity.extend(serde_json::from_slice::<Vec<Value>>(&fs::read(
        &activity_path,
    )?)?);
    fs::write(activity_path, serde_json::to_vec_pretty(&activity)?)?;
    // 恢复记录通过真正的备份逻辑生成，只读取已受保护的隔离 fixture。
    for index in 0..fixture["backupCount"].as_u64().unwrap_or(0) {
        create_backup_with_label(&format!("qa-manual-20260918-{index:06}"), "manual")?;
    }
    Ok(())
}
fn enrich_daily_feedback_fixture(app_data: &Path) -> Result<(), SwitcherError> {
    let activity_path = app_data.join(ACTIVITY_FILE);
    let mut activity: Vec<Value> = serde_json::from_slice(&fs::read(&activity_path)?)?;
    activity.insert(0, json!({
        "id": "qa-feedback-preview-ready",
        "time": "现在",
        "title": "状态反馈预览已准备",
        "detail": "这个样本只展示进行中、成功与错误反馈，不会模拟或执行保存、刷新、检查和恢复。",
        "tone": "info",
        "eventName": "qa.feedback_preview",
        "result": "info"
    }));
    fs::write(activity_path, serde_json::to_vec_pretty(&activity)?)?;
    Ok(())
}

#[tauri::command]
fn qa_reset_scenario(scenario_id: String) -> Result<AppState, SwitcherError> {
    let _transition = qa::Transition::begin()?;
    if !matches!(
        scenario_id.as_str(),
        "daily-baseline"
            | "daily-simulation"
            | "daily-density"
            | "daily-operation-flow"
            | "first-run-review"
    ) {
        return Err(SwitcherError::Message("未知 QA 场景，已拒绝重置。".into()));
    }
    if qa::live_requested() {
        return Err(SwitcherError::Message(
            "真实副本窗口不能载入模拟资料；请回 QA 主窗口。".into(),
        ));
    }
    let (project_root, app_data, codex_home) = development_fixture_roots()?;
    qa::validate_tree(&project_root.join(".codex/runtime"), &app_data)?;
    qa::validate_tree(&project_root.join(".codex/runtime"), &codex_home)?;
    clear_development_directory(&app_data)?;
    clear_development_directory(&codex_home)?;
    match scenario_id.as_str() {
        "daily-baseline" | "daily-simulation" => {
            seed_daily_qa_fixture(&project_root, &app_data, &codex_home)?
        }
        "daily-density" => {
            seed_daily_qa_fixture(&project_root, &app_data, &codex_home)?;
            enrich_daily_density_fixture(&app_data)?;
        }
        "daily-operation-flow" => {
            seed_daily_qa_fixture(&project_root, &app_data, &codex_home)?;
            enrich_daily_feedback_fixture(&app_data)?;
        }
        "first-run-review" => {}
        _ => {
            return Err(SwitcherError::Message(
                "未知 QA 场景，已拒绝重置。".to_string(),
            ))
        }
    }
    load_state_core()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QaLiveValidationStatus {
    snapshot_id: Option<String>,
    snapshot_ready: bool,
    import_ready: bool,
    detail: String,
    mode: String,
    in_use: bool,
    included_files: Vec<String>,
    missing_files: Vec<String>,
}

#[tauri::command]
fn qa_live_validation_status() -> Result<QaLiveValidationStatus, SwitcherError> {
    qa::status()
}
#[tauri::command]
fn qa_create_live_validation_snapshot() -> Result<QaLiveValidationStatus, SwitcherError> {
    qa::create_snapshot()
}
#[tauri::command]
fn qa_import_live_validation_snapshot() -> Result<QaLiveValidationStatus, SwitcherError> {
    qa::import_snapshot()
}
#[tauri::command]
fn qa_clear_live_validation_copy() -> Result<QaLiveValidationStatus, SwitcherError> {
    qa::clear_copy()
}
#[tauri::command]
fn qa_open_live_validation_window() -> Result<QaLiveValidationStatus, SwitcherError> {
    qa::open_window()
}

fn development_window_title() -> Option<String> {
    if matches!(
        option_env!("CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL"),
        Some("development")
    ) {
        let build_sha = option_env!("CODEX_PROVIDER_SWITCHER_BUILD_SHA").unwrap_or("local");
        return Some(format!("Signalman AI · 开发版 · {build_sha}"));
    }
    None
}

fn is_isolated_development_fixture(profile: &StoredProfile) -> bool {
    !qa::live_requested()
        && env::var_os("CODEX_PROVIDER_SWITCHER_BUILD_SHA").is_some()
        && profile.api_key.trim() == "development-placeholder"
        && profile.base_url.trim().ends_with(".example/v1")
}

fn verification_activity_diagnostics(profile: &StoredProfile) -> Vec<ActivityDiagnostic> {
    let mut diagnostics: Vec<ActivityDiagnostic> = [
        diagnostic_field(
            "verification.status",
            "检查结果",
            &profile.verification_status,
        ),
        profile
            .last_verification_stage
            .as_deref()
            .and_then(|value| diagnostic_field("verification.stage", "检查环节", value)),
        profile
            .last_verification_http_status
            .and_then(|value| diagnostic_field("http.status_code", "HTTP 状态", value.to_string())),
        profile
            .last_verification_provider_code
            .as_deref()
            .and_then(|value| diagnostic_field("provider.error_code", "服务商错误代码", value)),
        profile
            .verification_response_shape
            .as_deref()
            .and_then(|value| diagnostic_field("response.shape", "返回格式", value)),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(capability) = profile.capability_profile.as_ref() {
        diagnostics.extend(
            [
                diagnostic_field(
                    "capability.probe_version",
                    "识别规则版本",
                    &capability.probe_version,
                ),
                diagnostic_field("capability.protocol", "识别到的接口", &capability.protocol),
                diagnostic_field("capability.streaming", "流式输出", &capability.streaming),
                diagnostic_field("capability.completion", "完整结束", &capability.completion),
                diagnostic_field(
                    "capability.transport_retry_count",
                    "连接重试次数",
                    capability.transport_retry_count.to_string(),
                ),
                capability.response_header_ms.and_then(|value| {
                    diagnostic_field(
                        "timing.response_header_ms",
                        "收到响应头",
                        format!("{value} ms"),
                    )
                }),
                capability.first_event_ms.and_then(|value| {
                    diagnostic_field(
                        "timing.first_event_ms",
                        "收到首个事件",
                        format!("{value} ms"),
                    )
                }),
                capability.total_ms.and_then(|value| {
                    diagnostic_field("timing.total_ms", "检查总耗时", format!("{value} ms"))
                }),
            ]
            .into_iter()
            .flatten(),
        );
    }
    diagnostics
}

fn model_catalog_activity_diagnostics(catalog: &ModelCatalog) -> Vec<ActivityDiagnostic> {
    [
        diagnostic_field("model_catalog.status", "目录结果", &catalog.status),
        diagnostic_field(
            "model_catalog.model_count",
            "发现模型数",
            catalog.models.len().to_string(),
        ),
        catalog
            .http_status
            .and_then(|value| diagnostic_field("http.status_code", "HTTP 状态", value.to_string())),
        catalog
            .provider_code
            .as_deref()
            .and_then(|value| diagnostic_field("provider.error_code", "服务商错误代码", value)),
        catalog
            .request_id
            .as_deref()
            .and_then(|value| diagnostic_field("request.id", "服务商请求编号", value)),
        catalog.retry_after_seconds.and_then(|value| {
            diagnostic_field("retry.after_seconds", "建议等待秒数", value.to_string())
        }),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn response_probe_activity_diagnostics(
    observation: &ResponseProbeObservation,
) -> Vec<ActivityDiagnostic> {
    let mut diagnostics = vec![
        diagnostic_field("response_probe.status", "探针结果", &observation.status),
        diagnostic_field(
            "response_probe.version",
            "探针版本",
            &observation.probe_version,
        ),
        observation
            .http_status
            .and_then(|value| diagnostic_field("http.status_code", "HTTP 状态", value.to_string())),
        observation
            .request_id
            .as_deref()
            .and_then(|value| diagnostic_field("request.id", "服务商请求编号", value)),
        observation
            .actual_model
            .as_deref()
            .and_then(|value| diagnostic_field("response.actual_model", "实际返回模型", value)),
        observation
            .cost_source
            .as_deref()
            .and_then(|value| diagnostic_field("cost.source", "费用数据来源", value)),
        observation
            .cost_candidate
            .as_deref()
            .and_then(|value| diagnostic_field("cost.candidate", "费用候选值", value)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if let Some(usage) = &observation.usage {
        diagnostics.extend(
            [
                usage.input_tokens.and_then(|value| {
                    diagnostic_field("usage.input_tokens", "输入 tokens", value.to_string())
                }),
                usage.output_tokens.and_then(|value| {
                    diagnostic_field("usage.output_tokens", "输出 tokens", value.to_string())
                }),
                usage.total_tokens.and_then(|value| {
                    diagnostic_field("usage.total_tokens", "总 tokens", value.to_string())
                }),
            ]
            .into_iter()
            .flatten(),
        );
    }
    diagnostics
}

#[cfg(windows)]
fn windows_user_proxy() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let internet_settings = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = internet_settings.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let raw: String = internet_settings.get_value("ProxyServer").ok()?;
    let candidate = raw
        .split(';')
        .map(str::trim)
        .find_map(|item| {
            item.strip_prefix("https=")
                .or_else(|| item.strip_prefix("http="))
        })
        .or_else(|| raw.split(';').map(str::trim).find(|item| !item.is_empty()))?;
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return None;
    }
    Some(
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            candidate.to_string()
        } else {
            format!("http://{candidate}")
        },
    )
}

#[cfg(not(windows))]
fn windows_user_proxy() -> Option<String> {
    None
}

fn configure_http_client(
    builder: reqwest::blocking::ClientBuilder,
) -> reqwest::blocking::ClientBuilder {
    let Some(proxy_url) = windows_user_proxy() else {
        return builder;
    };
    match reqwest::Proxy::all(&proxy_url) {
        Ok(proxy) => builder.proxy(proxy),
        Err(_) => builder,
    }
}

// Provider endpoints can take several seconds to answer. Keep the existing
// blocking HTTP client on a dedicated runtime worker so the desktop event loop
// stays responsive while a command is waiting for the network.
static OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(crate) fn operation_event_channel(
    kind: &str,
    scope: &str,
    channel: Option<&Channel<OperationEventV1>>,
) -> Option<OperationEventV1> {
    let sequence = OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = chrono::Utc::now();
    let event = OperationEventV1::started(
        format!("{kind}-{}-{sequence}", now.timestamp_millis()),
        kind.to_string(),
        scope.to_string(),
        now.to_rfc3339(),
    );
    if let Some(channel) = channel {
        let _ = channel.send(event.clone());
    }
    Some(event)
}

pub(crate) fn send_operation_detail(
    base: &OperationEventV1,
    channel: Option<&Channel<OperationEventV1>>,
    detail: impl Into<String>,
) {
    if let Some(channel) = channel {
        let mut event = base.clone();
        event.detail = Some(detail.into());
        let _ = channel.send(event);
    }
}

async fn run_blocking_command<T>(
    operation: impl FnOnce() -> Result<T, SwitcherError> + Send + 'static,
) -> Result<T, SwitcherError>
where
    T: Send + 'static,
{
    let scope = qa::operation_scope()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _scope = scope;
        operation()
    })
    .await
    .map_err(|error| SwitcherError::Message(format!("后台任务意外中断：{error}")))?
}

pub(crate) async fn run_blocking_command_with_events<T>(
    kind: &'static str,
    scope: &'static str,
    channel: Option<Channel<OperationEventV1>>,
    operation: impl FnOnce() -> Result<T, SwitcherError> + Send + 'static,
) -> Result<T, SwitcherError>
where
    T: Send + 'static,
{
    let started = operation_event_channel(kind, scope, channel.as_ref())
        .expect("operation event must always be created");
    send_operation_detail(
        &started,
        channel.as_ref(),
        "后台任务已开始；正在执行实际检查。",
    );
    // A blocking provider request must never look like a frozen desktop. The
    // heartbeat deliberately reports only the fact that we are still waiting;
    // it does not claim to know whether the provider has accepted or cancelled
    // the request.
    let completed = Arc::new(AtomicBool::new(false));
    if let Some(channel) = channel.as_ref() {
        let completed = Arc::clone(&completed);
        let channel = channel.clone();
        let started = started.clone();
        std::thread::spawn(move || {
            let mut waited_seconds = 0_u64;
            loop {
                std::thread::sleep(Duration::from_secs(5));
                if completed.load(Ordering::Relaxed) {
                    return;
                }
                waited_seconds += 5;
                if waited_seconds >= 15 {
                    send_operation_detail(
                        &started,
                        Some(&channel),
                        "服务商仍在处理，正在继续等待结果。",
                    );
                }
            }
        });
    }
    let started_at = std::time::Instant::now();
    let result = run_blocking_command(operation).await;
    completed.store(true, Ordering::Relaxed);
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    if let Some(channel) = channel.as_ref() {
        let event = match &result {
            Ok(_) => started.completed(elapsed_ms, Some("操作已完成。".to_string())),
            Err(error) => started.failed(
                elapsed_ms,
                error.to_string(),
                Some("operation_failed".to_string()),
            ),
        };
        let _ = channel.send(event);
    }
    result
}

#[tauri::command]
fn update_transport_options() -> UpdateTransportOptions {
    // The updater plugin is separate from reqwest. Pass the Windows system
    // proxy only for this request; never persist or return it through app state.
    UpdateTransportOptions {
        proxy: windows_user_proxy(),
        timeout_ms: 10_000,
    }
}

// Backup validation, recovery preparation, and backup listing live in the
// storage module. The command layer below only coordinates transactions.

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "只在显式设置项目隔离目录时运行"]
    fn initialization_transaction_roundtrip() {
        let project = env::current_dir().unwrap().parent().unwrap().to_path_buf();
        let runtime = project.join(".codex/runtime").canonicalize().unwrap();
        assert!(app_data_dir().unwrap().canonicalize().unwrap().starts_with(&runtime));
        assert!(codex_home().unwrap().canonicalize().unwrap().starts_with(&runtime));
        assert!(!root_config_path().unwrap().exists());
        prepare_connection_environment_core_with_onboarding("user-config".into(), true).unwrap();
        let record = load_connection_environment_record();
        assert!(record.setup_completed && takeover_backup_is_healthy(&record));
        let permanent = backups_dir().unwrap().join(record.takeover_backup_label.as_ref().unwrap());
        fs::remove_file(permanent.join("manifest.json")).unwrap();
        assert_eq!(connection_environment_state().status, "needs_setup");
        let second_report = initialize_with_progress(true, &mut |_| {});
        assert!(!second_report.can_continue);
        assert_eq!(second_report.steps[6].status, "warning");
        assert!(permanent.join("invalid-backup.json").is_file());
        assert!(takeover_backup_is_healthy(&load_connection_environment_record()));
        assert_ne!(load_connection_environment_record().takeover_backup_label, record.takeover_backup_label);

        let config = root_config_path().unwrap();
        let auth = auth_path().unwrap();
        let original = "model='fixture-old'\nmodel_provider='openai'\nmodel_catalog_json='C:/fixture/old.json'\n[mcp_servers.keep]\ncommand='keep'\n";
        let oauth = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-old"}}"#;
        let refreshed = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-refreshed"}}"#;
        fs::write(&config, original).unwrap();
        fs::write(&auth, oauth).unwrap();
        let previous = load_connection_environment_record();
        let backup = create_backup_with_label("interrupted-initialization", "before_switch").unwrap();
        let candidate = build_connection_environment_config(original).unwrap();
        let before = owned_configuration_fingerprint(original, oauth).unwrap();
        begin_config_transaction_at("interrupted-initialization", "initialization", &before, config.clone(), auth.clone(), Some(previous.clone()), Some(owned_configuration_fingerprint(&candidate, oauth).unwrap())).unwrap();
        fs::write(&config, &candidate).unwrap();
        fs::write(&auth, refreshed).unwrap();
        let path = pending_transaction_path().unwrap();
        let mut transaction: PendingConfigTransaction = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        transaction.writer_pid = 0;
        transaction.phase = "config_replaced".into();
        fs::write(&path, serde_json::to_vec(&transaction).unwrap()).unwrap();
        fs::write(&config, "model='external-change'\n").unwrap();
        assert!(recover_pending_config_transaction().is_err());
        assert!(path.is_file());
        let external_protected = format!("{candidate}\n[plugins.external]\nenabled=true\n");
        fs::write(&config, &external_protected).unwrap();
        assert!(recover_pending_config_transaction().is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), external_protected);
        assert!(path.exists());
        fs::write(&config, &candidate).unwrap();
        recover_pending_config_transaction().unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), original);
        assert_eq!(fs::read_to_string(&auth).unwrap(), refreshed);
        assert!(!path.exists());
        assert_eq!(load_connection_environment_record().takeover_backup_label, previous.takeover_backup_label);
        assert!(backup.join("manifest.json").is_file());

        fs::remove_file(&config).unwrap();
        fs::remove_file(&auth).unwrap();
        create_backup_with_label("interrupted-empty-initialization", "before_switch").unwrap();
        let candidate = build_connection_environment_config("").unwrap();
        begin_config_transaction_at("interrupted-empty-initialization", "initialization", &owned_configuration_fingerprint("", "{}").unwrap(), config.clone(), auth.clone(), Some(previous), Some(owned_configuration_fingerprint(&candidate, "{}").unwrap())).unwrap();
        fs::write(&config, &candidate).unwrap();
        fs::write(&auth, "{}").unwrap();
        let mut transaction: PendingConfigTransaction = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        transaction.writer_pid = 0;
        fs::write(&path, serde_json::to_vec(&transaction).unwrap()).unwrap();
        recover_pending_config_transaction().unwrap();
        assert!(!config.exists() && !auth.exists() && !path.exists());
        super::initialization::fault_matrix();
    }

    #[test]
    fn initialization_catalog_reuses_only_verified_owned_content() {
        let root = std::env::temp_dir().join(super::unique_backup_label("signalman-catalog-test"));
        std::fs::create_dir_all(&root).unwrap();
        let bytes = br#"{"models":[{"slug":"fixture-model"}]}"#;
        let path = root.join(format!("{}.json", &super::bytes_digest(bytes)[..24]));
        let config = format!("model_catalog_json={}\n", serde_json::to_string(&path.display().to_string()).unwrap());
        assert!(super::matching_owned_model_catalog(&config, &root, bytes).unwrap().is_none());
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(super::matching_owned_model_catalog(&config, &root, bytes).unwrap(), Some(path.clone()));
        assert!(super::matching_owned_model_catalog(&config, &root.join("other"), bytes).unwrap().is_none());
        std::fs::write(&path, b"{}").unwrap();
        assert!(super::matching_owned_model_catalog(&config, &root, bytes).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn official_switch_preserves_extensions_and_rejects_empty_model() {
        let original = "model='old'\nmodel_provider='custom'\nopenai_base_url='https://relay.example/v1'\nmodel_catalog_json='C:/app/provider-models.json'\n[mcp_servers.demo]\ncommand='keep'\n[model_providers.custom]\nname='relay'\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n";
        let next = super::official_provider_config(original, "official-test-model").unwrap();
        let value: toml::Value = toml::from_str(&next).unwrap();
        assert_eq!(value["model_provider"].as_str(), Some("openai"));
        assert!(value.get("openai_base_url").is_none());
        assert!(value.get("model_catalog_json").is_none());
        assert!(super::protected_sections_match(original, &next).unwrap());
        assert!(super::official_provider_config(original, " ").is_err());
    }

    #[test]
    fn chat_only_provider_is_written_through_the_local_gateway() {
        let original = "model = 'old'\nmodel_provider = 'custom'\n[model_providers.custom]\nname = 'Relay'\nbase_url = 'https://before.example/v1'\nwire_api = 'responses'\n";
        let profile: super::StoredProfile = serde_json::from_value(serde_json::json!({
            "name":"Relay", "base_url":"https://relay.example/v1", "model":"chat-model",
            "api_key":"fixture-key", "capability_profile":{"protocol":"chat_completions"}
        }))
        .unwrap();
        let next = super::build_next_config(original, "relay", &profile).unwrap();
        let config: toml::Value = toml::from_str(&next).unwrap();
        assert_eq!(
            config["model_providers"]["custom"]["wire_api"].as_str(),
            Some("responses")
        );
        assert_eq!(
            config["model_providers"]["custom"]["base_url"].as_str(),
            Some(super::protocol_gateway::local_base_url().as_str())
        );
        assert!(super::protected_sections_match(original, &next).unwrap());
    }

    #[test]
    fn new_chat_models_are_selected_automatically_except_non_chat_model_types() {
        let mut catalog: super::ModelCatalog = serde_json::from_value(serde_json::json!({
            "providerId":"relay", "baseUrl":"https://relay.example/v1", "status":"ok",
            "statusDetail":"ok", "models":[
                {"id":"gpt-custom","aliases":[],"source":"models-api","tags":[],"verifiedForResponses":"unknown"},
                {"id":"embed-large","aliases":[],"source":"models-api","tags":[],"verifiedForResponses":"unknown"},
                {"id":"audio-transcribe","aliases":[],"source":"models-api","tags":[],"verifiedForResponses":"unknown"}
            ]
        })).unwrap();
        super::apply_default_codex_model_selection(&mut catalog, "gpt-custom", &[]);
        assert_eq!(catalog.models[0].codex_enabled, Some(true));
        assert_eq!(catalog.models[1].codex_enabled, Some(false));
        assert_eq!(catalog.models[2].codex_enabled, Some(false));
    }

    #[test]
    fn generated_codex_catalog_keeps_the_default_even_if_provider_refresh_omits_it() {
        let profile: super::StoredProfile = serde_json::from_value(serde_json::json!({
            "name": "Relay", "base_url": "https://relay.example/v1", "model": "new-default"
        }))
        .unwrap();
        let catalog: super::ModelCatalog = serde_json::from_value(serde_json::json!({
            "providerId": "relay", "baseUrl": "https://relay.example/v1", "status": "ok",
            "statusDetail": "ok", "models": [{
                "id": "selected-extra", "aliases": [], "source": "models-api", "tags": [],
                "verifiedForResponses": "unknown", "codexEnabled": true
            }]
        }))
        .unwrap();
        let bundled = vec![serde_json::json!({
            "slug": "gpt-template", "display_name": "Template", "description": "Bundled",
            "model_messages": [], "base_instructions": "vendor text", "comp_hash": "hash",
            "supports_reasoning_summaries": true
        })];

        let bytes = super::build_codex_model_catalog(&catalog, &profile, &bundled).unwrap();
        let generated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let models = generated["models"].as_array().unwrap();

        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["slug"], "selected-extra");
        assert_eq!(models[1]["slug"], "new-default");
        assert!(models
            .iter()
            .all(|model| model.get("model_messages").is_none()));
        assert!(models.iter().all(|model| model
            .get("base_instructions")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())));
    }

    #[test]
    fn bound_helper_does_not_need_codex_home_or_mutate_catalog() {
        let root = std::env::temp_dir().join(super::unique_backup_label("bound-helper-test"));
        std::fs::create_dir_all(&root).unwrap();
        let document = r#"{"profiles":{"example":{"name":"test","base_url":"https://example.invalid/v1","model":"test","api_key":"fixture-not-a-secret"}},"profile_order":["example"]}"#;
        let path = root.join(super::PROFILES_FILE);
        std::fs::write(&path, document).unwrap();
        assert_eq!(
            super::read_bound_provider_token(root.to_str().unwrap(), "example").unwrap(),
            "fixture-not-a-secret"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), document);
        assert!(super::read_bound_provider_token("relative", "example").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_write_replaces_a_readonly_config_in_an_isolated_directory() {
        let root = std::env::temp_dir().join(super::unique_backup_label("readonly-recovery-test"));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        std::fs::write(&path, "broken = [\n").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        let result = super::write_recovery_target(&path, b"model_provider = \"custom\"\n");
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        assert!(
            !permissions.readonly(),
            "restored config must be writable for the next provider switch"
        );
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(bytes, b"model_provider = \"custom\"\n");
    }

    #[cfg(windows)]
    #[test]
    fn damaged_config_rescue_requires_full_confirmation_and_preserves_the_original() {
        let root = std::env::temp_dir().join(super::unique_backup_label("damaged-rescue-test"));
        let config_path = root.join("codex").join("config.toml");
        let backup_dir = root.join("backup");
        let evidence_root = root.join("evidence");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&backup_dir).unwrap();
        let damaged = b"this = [not valid TOML\n";
        std::fs::write(&config_path, damaged).unwrap();
        let mut permissions = std::fs::metadata(&config_path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&config_path, permissions).unwrap();

        let backed_up = b"model = \"gpt-test\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"fixture\"\nbase_url = \"https://fixture.invalid/v1\"\nwire_api = \"responses\"\n";
        let protected = super::protect_secret(backed_up).unwrap();
        let protected_bytes = protected.as_bytes().to_vec();
        std::fs::write(backup_dir.join("config.toml.dpapi"), &protected_bytes).unwrap();
        let manifest = super::BackupManifest {
            schema_version: 4,
            fingerprint_version: 2,
            created_at: "2026-09-23".into(),
            reason: "manual".into(),
            files: vec!["config.toml.dpapi".into()],
            missing_files: vec!["auth.json".into()],
            post_change_fingerprint: None,
            snapshot_fingerprint: None,
            protected_fingerprint: None,
            file_digests: std::collections::BTreeMap::from([(
                "config.toml.dpapi".into(),
                super::bytes_digest(&protected_bytes),
            )]),
            retention_managed: true,
        };

        let mut invalid_manifest = manifest.clone();
        invalid_manifest
            .file_digests
            .insert("config.toml.dpapi".into(), "incorrect-digest".into());
        assert!(super::recover_damaged_config(
            &config_path,
            &evidence_root,
            &backup_dir,
            &invalid_manifest,
            "恢复全部配置",
        )
        .is_err());
        assert_eq!(std::fs::read(&config_path).unwrap(), damaged);

        assert!(super::recover_damaged_config(
            &config_path,
            &evidence_root,
            &backup_dir,
            &manifest,
            "恢复",
        )
        .is_err());
        assert_eq!(std::fs::read(&config_path).unwrap(), damaged);

        let evidence = super::recover_damaged_config(
            &config_path,
            &evidence_root,
            &backup_dir,
            &manifest,
            "恢复全部配置",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            String::from_utf8(backed_up.to_vec()).unwrap()
        );
        let protected_original =
            std::fs::read_to_string(evidence.join("config.toml.dpapi")).unwrap();
        assert_eq!(
            super::unprotect_secret(&protected_original).unwrap(),
            damaged
        );

        std::fs::remove_file(&config_path).unwrap();
        let missing_evidence = super::recover_damaged_config(
            &config_path,
            &evidence_root,
            &backup_dir,
            &manifest,
            "恢复全部配置",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            String::from_utf8(backed_up.to_vec()).unwrap()
        );
        let missing_receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(missing_evidence.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(missing_receipt["file"], "config.toml was missing");

        let mut permissions = std::fs::metadata(&config_path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&config_path, permissions).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    use super::*;

    #[test]
    #[ignore = "只在显式设置项目隔离目录时运行"]
    fn boundary_fixture_roundtrip() {
        let project = env::current_dir().unwrap().parent().unwrap().to_path_buf();
        let runtime = project.join(".codex/runtime").canonicalize().unwrap();
        let app_data = app_data_dir().unwrap().canonicalize().unwrap();
        let codex_home = PathBuf::from(env::var(CODEX_HOME_ENV).unwrap())
            .canonicalize()
            .unwrap();
        assert!(app_data.starts_with(&runtime) && codex_home.starts_with(&runtime));
        assert_eq!(
            fs::read_dir(&app_data).unwrap().count(),
            0,
            "测试必须使用新建空目录"
        );
        seed_daily_qa_fixture(&project, &app_data, &codex_home).unwrap();
        enrich_daily_density_fixture(&app_data).unwrap();
        let state = load_state_core().unwrap();
        let value = serde_json::to_value(state).unwrap();
        assert!(value["profiles"].as_array().unwrap().len() >= 25);
        assert!(value["costCalibrations"].as_array().unwrap().len() >= 12);
        assert!(value["modelCatalogs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["providerId"] == "qa-density-provider-03"
                && c["models"].as_array().unwrap().is_empty()));
        assert!(
            value["backups"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["restoreReady"] == true)
                .count()
                >= 10
        );
        // Exercise actual filesystem transactions, without invoking login or
        // networking. A refreshed official identity must survive both routes.
        let before = read_config().unwrap();
        let oauth = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-only"}}"#;
        fs::write(auth_path().unwrap(), oauth).unwrap();
        activate_official_provider_core("official-test-model").unwrap();
        assert_eq!(fs::read_to_string(auth_path().unwrap()).unwrap(), oauth);
        assert_eq!(
            current_profile_id(&load_catalog().unwrap(), &read_config().unwrap()),
            "chatgpt-official-account"
        );
        restore_latest_backup_core("恢复".into()).unwrap();
        assert_eq!(fs::read_to_string(auth_path().unwrap()).unwrap(), oauth);
        assert_eq!(
            toml::from_str::<toml::Value>(&before).unwrap(),
            toml::from_str::<toml::Value>(&read_config().unwrap()).unwrap()
        );
        // A purely official initial configuration has no custom provider.
        fs::write(
            config_path().unwrap(),
            "model='official-old'\n[mcp_servers.fixture]\ncommand='keep'\n",
        )
        .unwrap();
        let backup =
            create_backup_with_label(&unique_backup_label("official-baseline"), "manual").unwrap();
        let manifest: BackupManifest =
            serde_json::from_str(&fs::read_to_string(backup.join("manifest.json")).unwrap())
                .unwrap();
        let (next, auth) = restored_owned_files(&backup, &manifest).unwrap();
        assert!(auth.is_none());
        assert!(toml::from_str::<toml::Value>(&next)
            .unwrap()
            .get("model_provider")
            .is_none());
        qa::tests::single_window_roundtrip(&app_data, &codex_home);
    }

    fn fingerprint_fixture_manifest(
        fingerprint: String,
        fingerprint_version: u8,
    ) -> BackupManifest {
        BackupManifest {
            schema_version: 4,
            fingerprint_version,
            created_at: "2026-08-19 00:00:00".to_string(),
            reason: "before_switch".to_string(),
            files: vec![
                "config.toml.dpapi".to_string(),
                "auth.json.dpapi".to_string(),
            ],
            missing_files: Vec::new(),
            post_change_fingerprint: None,
            snapshot_fingerprint: Some(fingerprint),
            protected_fingerprint: None,
            file_digests: BTreeMap::new(),
            retention_managed: true,
        }
    }

    #[test]
    fn accepts_a_valid_legacy_backup_fingerprint_but_not_for_new_manifests() {
        let config = r#"
model = "gpt-test"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "provider"
wire_api = "responses"
base_url = "https://provider.example/v1"
api_key = "test-key"

[model_providers.custom.auth]
command = "powershell.exe"
args = ["-NoProfile"]
"#;
        let auth = r#"{"OPENAI_API_KEY":"test-key"}"#;
        let legacy = owned_configuration_fingerprint_v1(config, auth).unwrap();
        let current = owned_configuration_fingerprint(config, auth).unwrap();

        assert_ne!(legacy, current);
        assert_eq!(
            backup_snapshot_fingerprint_match(
                &fingerprint_fixture_manifest(legacy.clone(), 0),
                config,
                auth,
            )
            .unwrap(),
            Some(1)
        );
        assert_eq!(
            backup_snapshot_fingerprint_match(
                &fingerprint_fixture_manifest(legacy, CURRENT_BACKUP_FINGERPRINT_VERSION),
                config,
                auth,
            )
            .unwrap(),
            None
        );
        assert_eq!(
            backup_snapshot_fingerprint_match(
                &fingerprint_fixture_manifest(current, CURRENT_BACKUP_FINGERPRINT_VERSION),
                config,
                auth,
            )
            .unwrap(),
            Some(CURRENT_BACKUP_FINGERPRINT_VERSION)
        );
    }

    #[test]
    fn validates_a_dpapi_protected_legacy_backup_before_accepting_its_fingerprint() {
        let config = r#"
model = "gpt-test"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "provider"
wire_api = "responses"
base_url = "https://provider.example/v1"
api_key = "test-key"

[model_providers.custom.auth]
command = "powershell.exe"
args = ["-NoProfile"]
"#;
        let auth = r#"{"OPENAI_API_KEY":"test-key"}"#;
        let path = env::temp_dir().join(format!(
            "signalman-legacy-backup-{}",
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir(&path).unwrap();
        let protected_config = protect_secret(config.as_bytes()).unwrap();
        let protected_auth = protect_secret(auth.as_bytes()).unwrap();
        fs::write(path.join("config.toml.dpapi"), &protected_config).unwrap();
        fs::write(path.join("auth.json.dpapi"), &protected_auth).unwrap();
        let manifest = BackupManifest {
            schema_version: 4,
            fingerprint_version: 0,
            created_at: "2026-08-19 00:00:00".to_string(),
            reason: "initial_install".to_string(),
            files: vec![
                "config.toml.dpapi".to_string(),
                "auth.json.dpapi".to_string(),
            ],
            missing_files: Vec::new(),
            post_change_fingerprint: None,
            snapshot_fingerprint: Some(owned_configuration_fingerprint_v1(config, auth).unwrap()),
            protected_fingerprint: None,
            file_digests: BTreeMap::from([
                (
                    "config.toml.dpapi".to_string(),
                    bytes_digest(protected_config.as_bytes()),
                ),
                (
                    "auth.json.dpapi".to_string(),
                    bytes_digest(protected_auth.as_bytes()),
                ),
            ]),
            retention_managed: false,
        };

        assert!(backup_manifest_health(&path, &manifest).is_ok());
        fs::write(path.join("auth.json.dpapi"), "changed").unwrap();
        assert!(backup_manifest_health(&path, &manifest).is_err());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn parses_full_openai_compatible_model_list_without_version_filtering() {
        let body = json!({
            "object": "list",
            "data": [
                { "id": "provider-reasoning-current", "object": "model" },
                { "id": "provider-reasoning-legacy", "object": "model" },
                { "id": "provider-chat-compatible", "object": "model" },
                { "id": "provider-embedding-large", "object": "model" },
                { "id": "provider-coder", "object": "model" },
                { "id": "PROVIDER-REASONING-LEGACY", "object": "model" },
                { "object": "model" }
            ]
        });

        let models = parse_provider_models(&body);
        let ids = models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec![
                "provider-chat-compatible",
                "provider-coder",
                "provider-embedding-large",
                "provider-reasoning-current",
                "provider-reasoning-legacy"
            ]
        );
        assert!(models
            .iter()
            .find(|model| model.id == "provider-embedding-large")
            .expect("embedding model should be kept")
            .tags
            .contains(&"embedding".to_string()));
    }

    #[test]
    fn parses_common_models_array_catalog_shape() {
        let body = json!({
            "models": [
                { "id": "provider-reasoning-current" },
                { "id": "provider-fast-current" }
            ]
        });

        let ids = parse_provider_models(&body)
            .into_iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec!["provider-fast-current", "provider-reasoning-current"]
        );
    }

    #[test]
    fn preview_models_reports_missing_key_without_contacting_the_provider() {
        let catalog = preview_models_core(EditableProfile {
            connection_kind: None,
            id: String::new(),
            name: "草稿服务商".to_string(),
            base_url: "https://provider.example/v1".to_string(),
            endpoint_mode: default_endpoint_mode(),
            model: String::new(),
            note: String::new(),
            api_key: String::new(),
        })
        .unwrap();

        assert_eq!(catalog.provider_id, "draft-provider");
        assert_eq!(catalog.status, "missing_key");
        assert!(catalog.models.is_empty());
    }

    #[test]
    fn parses_provider_array_model_list() {
        let body =
            json!(["provider-fast-legacy", { "id": "vision-model" }, "", { "name": "ignored" }]);

        let models = parse_provider_models(&body);
        let ids = models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["provider-fast-legacy", "vision-model"]);
        assert!(models
            .iter()
            .find(|model| model.id == "vision-model")
            .expect("vision model should be kept")
            .tags
            .contains(&"vision".to_string()));
    }

    #[test]
    fn treats_null_error_as_a_success_payload_and_recognizes_compatible_output() {
        let body = json!({
            "error": null,
            "object": "response",
            "output_text": "OK"
        });

        assert!(!has_provider_error(&body));
        assert!(has_compatible_response_output(&body));
    }

    #[test]
    fn preserves_non_null_error_as_a_provider_failure() {
        let body = json!({"error": {"code": "insufficient_quota"}});

        assert!(has_provider_error(&body));
    }

    #[test]
    fn model_catalog_http_detail_keeps_retry_and_request_diagnostics() {
        let (detail, code) = model_catalog_http_detail(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":{"code":"USAGE_LIMIT_EXCEEDED"}}"#,
            Some("req-123"),
            Some(17),
        );

        assert_eq!(code.as_deref(), Some("USAGE_LIMIT_EXCEEDED"));
        assert!(detail.contains("HTTP 429"));
        assert!(detail.contains("17 秒"));
        assert!(detail.contains("req-123"));
    }

    #[test]
    fn failed_model_refresh_preserves_last_successful_catalog() {
        let profile = StoredProfile {
            connection_kind: None,
            name: "Test".to_string(),
            base_url: "https://provider.example/v1".to_string(),
            endpoint_mode: default_endpoint_mode(),
            api_key: "key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-test".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            capability_profile: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };
        let previous = build_model_catalog(
            "test",
            &profile,
            "ok",
            "已刷新",
            vec![ProviderModel {
                id: "gpt-test".to_string(),
                aliases: Vec::new(),
                source: "provider_models_api".to_string(),
                tags: vec!["responses-candidate".to_string()],
                verified_for_responses: "verified".to_string(),
                codex_enabled: None,
                last_verification_at: Some("2026-08-21 00:00:00".to_string()),
                last_verification_status: Some("verified".to_string()),
                last_verification_detail: Some("测试 fixture".to_string()),
            }],
        );
        let previous_value = serde_json::to_value(previous).unwrap();
        let mut next = build_model_catalog(
            "test",
            &profile,
            "rate_limited",
            "服务商当前限流",
            Vec::new(),
        );

        preserve_previous_model_catalog(Some(&previous_value), &mut next);
        preserve_catalog_model_verifications(Some(&previous_value), &mut next);

        assert_eq!(next.status, "stale");
        assert_eq!(next.models.len(), 1);
        assert_eq!(next.models[0].id, "gpt-test");
        assert_eq!(next.models[0].verified_for_responses, "verified");
        assert!(next.status_detail.contains("上次成功目录"));
    }

    #[test]
    fn parses_catalog_json_with_a_utf8_byte_order_mark() {
        let catalog: StoredCatalog = parse_json_document("\u{feff}{\"profiles\":{}}").unwrap();

        assert!(catalog.profiles.is_empty());
    }

    #[test]
    fn ordinary_provider_uses_standard_bearer_contract() {
        let original = r#"
model = "gpt-test"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "before"
wire_api = "responses"
base_url = "https://before.example/v1"
api_key = "before-key"
"#;
        let profile = StoredProfile {
            connection_kind: None,
            name: "A6".to_string(),
            base_url: "https://api.a6api.com/v1".to_string(),
            endpoint_mode: default_endpoint_mode(),
            api_key: "a6-test-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-after".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            capability_profile: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, "test-profile", &profile).unwrap();

        let parsed = toml::from_str::<toml::Value>(&next).unwrap();
        let custom = parsed
            .get("model_providers")
            .and_then(|providers| providers.get("custom"))
            .expect("custom provider");
        let auth = custom.get("auth").expect("provider credential helper");
        assert!(auth.get("command").and_then(toml::Value::as_str).is_some());
        assert!(custom.get("requires_openai_auth").is_none());
        for removed_key in ["env_key", "experimental_bearer_token", "api_key"] {
            assert!(
                custom.get(removed_key).is_none(),
                "{removed_key} should be absent"
            );
        }

        let original_auth = "{\r\n  \"auth_mode\": \"chatgpt\",\r\n  \"tokens\": {\"access_token\": \"opaque\"},\r\n  \"other\": \"keep\"\r\n}";
        let auth_json = build_next_auth(original_auth, &profile).unwrap();
        assert_eq!(
            auth_json, original_auth,
            "official auth must remain byte-for-byte unchanged"
        );
        let auth_value = serde_json::from_str::<Value>(&auth_json).unwrap();
        assert!(auth_value.get("OPENAI_API_KEY").is_none());
        assert_eq!(
            auth_value.get("other").and_then(Value::as_str),
            Some("keep")
        );
    }

    #[test]
    fn protected_fingerprint_covers_unknown_config_and_auth_fields() {
        let config = r#"
model = "gpt-test"
model_provider = "custom"
future_codex_setting = "keep-me"

[model_providers.custom]
name = "before"
wire_api = "responses"
base_url = "https://before.example/v1"

[projects]
"D:/safe" = "trusted"
"#;
        let auth = r#"{"OPENAI_API_KEY":"old","future_auth_field":"keep-me"}"#;
        let same = protected_configuration_fingerprint(config, auth).unwrap();
        let changed_config = config.replace("keep-me", "changed");
        let changed_auth = auth.replace("keep-me", "changed");
        assert_ne!(
            same,
            protected_configuration_fingerprint(&changed_config, auth).unwrap()
        );
        assert_ne!(
            same,
            protected_configuration_fingerprint(config, &changed_auth).unwrap()
        );

        let provider_only = config
            .replace("before.example", "after.example")
            .replace("name = \"before\"", "name = \"after\"");
        let provider_only_auth = auth.replace("old", "new");
        assert_eq!(
            same,
            protected_configuration_fingerprint(&provider_only, &provider_only_auth).unwrap()
        );
    }

    #[test]
    fn five_provider_profiles_share_the_standard_bearer_fixture_contract() {
        let original = r#"
model = "old-model"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "before"
wire_api = "responses"
base_url = "https://before.example/v1"
requires_openai_auth = true
env_key = "OLD_PROVIDER_KEY"
experimental_bearer_token = "old-token"
api_key = "old-key"

[projects]
"D:/safe" = "trusted"
"D:/other" = { trust_level = "trusted" }
"#;

        for (name, base_url) in [
            ("A6", "https://api.a6api.com/v1"),
            ("Hiyo", "https://codex.hiyo.top/v1"),
            ("A18", "https://ai8.my/v1"),
            ("OWL", "https://api.owlai.tech/v1"),
            ("Unconfigured", "https://provider.example/v1"),
        ] {
            let profile = StoredProfile {
                connection_kind: None,
                name: name.to_string(),
                base_url: base_url.to_string(),
                endpoint_mode: default_endpoint_mode(),
                api_key: format!("{name}-test-key"),
                api_key_protected: String::new(),
                model: "gpt-test".to_string(),
                auth_mode: default_auth_mode(),
                model_reasoning_effort: default_reasoning(),
                verified: false,
                verification_status: default_verification_status(),
                verification_response_shape: None,
                capability_profile: None,
                default: false,
                note: String::new(),
                last_switched_at: None,
                last_verified_at: None,
                last_verification_detail: None,
                last_verification_stage: None,
                last_verification_http_status: None,
                last_verification_provider_code: None,
            };

            let next = build_next_config(original, "test-profile", &profile).unwrap();
            let parsed = toml::from_str::<toml::Value>(&next).unwrap();
            let custom = parsed
                .get("model_providers")
                .and_then(|providers| providers.get("custom"))
                .expect("custom provider");
            let auth = custom.get("auth").expect("provider credential helper");
            let args = auth.get("args").and_then(toml::Value::as_array).unwrap();
            assert_eq!(
                args.get(1).and_then(toml::Value::as_str),
                Some("test-profile")
            );
            assert!(custom.get("requires_openai_auth").is_none());
            for removed_key in ["env_key", "experimental_bearer_token", "api_key"] {
                assert!(
                    custom.get(removed_key).is_none(),
                    "{name} retained {removed_key}"
                );
            }
            assert!(protected_sections_match(original, &next).unwrap());

            let auth_value = serde_json::from_str::<Value>(
                &build_next_auth(r#"{"other":"keep"}"#, &profile).unwrap(),
            )
            .unwrap();
            assert!(auth_value.get("OPENAI_API_KEY").is_none());
            assert_eq!(
                auth_value.get("other").and_then(Value::as_str),
                Some("keep")
            );
        }
    }

    #[test]
    fn unknown_provider_does_not_guess_command_auth() {
        let original = r#"
model = "gpt-test"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "before"
wire_api = "responses"
base_url = "https://before.example/v1"
api_key = "before-key"
"#;
        let profile = StoredProfile {
            connection_kind: None,
            name: "after".to_string(),
            base_url: "https://after.example/v1".to_string(),
            endpoint_mode: default_endpoint_mode(),
            api_key: "after-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-after".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            capability_profile: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, "test-profile", &profile).unwrap();
        let checks = validation_checks(&next);

        assert!(!next.contains("api_key"));
        assert!(checks
            .iter()
            .any(|check| { check.id == "custom-authentication-mode" && check.ok }));
        assert!(next.contains("[model_providers.custom.auth]"));
        assert!(!next.contains("requires_openai_auth"));
    }

    #[test]
    fn modelflare_switch_uses_provider_command_auth_contract() {
        let original = r#"
model = "gpt-test"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "before"
wire_api = "responses"
requires_openai_auth = false
base_url = "https://before.example/v1"
api_key = "before-key"

[projects]
"D:/safe" = "trusted"
"#;
        let profile = StoredProfile {
            connection_kind: None,
            name: "ModelFlare".to_string(),
            base_url: "https://modelflare.dev/v1".to_string(),
            endpoint_mode: default_endpoint_mode(),
            api_key: "model-flare-test-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-5.6-sol".to_string(),
            auth_mode: "provider_command".to_string(),
            model_reasoning_effort: "xhigh".to_string(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            capability_profile: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, "test-profile", &profile).unwrap();
        let parsed = toml::from_str::<toml::Value>(&next).unwrap();
        let auth = parsed
            .get("model_providers")
            .and_then(|providers| providers.get("custom"))
            .and_then(|provider| provider.get("auth"))
            .expect("provider auth table");
        assert!(auth.get("command").and_then(toml::Value::as_str).is_some());
        let args = auth
            .get("args")
            .and_then(toml::Value::as_array)
            .expect("provider auth args");
        assert_eq!(
            args.first().and_then(toml::Value::as_str),
            Some("--print-provider-token")
        );
        assert_eq!(
            args.get(1).and_then(toml::Value::as_str),
            Some("test-profile")
        );
        assert!(!next.contains("requires_openai_auth"));
        assert!(next.contains("gpt-5.6-sol"));
        assert!(protected_sections_match(original, &next).unwrap());

        let auth_json = build_next_auth(r#"{"other":"keep"}"#, &profile).unwrap();
        let auth_value = serde_json::from_str::<Value>(&auth_json).unwrap();
        assert!(auth_value.get("OPENAI_API_KEY").is_none());
        assert_eq!(
            auth_value.get("other").and_then(Value::as_str),
            Some("keep")
        );
    }

    #[test]
    #[ignore = "requires the live ModelFlare edge; run explicitly for transport diagnostics"]
    fn modelflare_edge_is_reachable_with_windows_tls_stack() {
        let client = configure_http_client(
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(15))
                .http1_only(),
        )
        .build()
        .unwrap();
        let response = client
            .get("https://modelflare.dev/v1/models")
            .bearer_auth("signalman-transport-probe-invalid")
            .send()
            .expect("ModelFlare edge should complete a TLS request");
        assert!(matches!(response.status().as_u16(), 401 | 403));
    }

    #[test]
    fn switching_replaces_legacy_auth_flags_with_standard_bearer_auth() {
        let original = r#"
model = "gpt-test"
model_provider = "custom"
disable_response_storage = true

[model_providers.custom]
name = "before"
wire_api = "responses"
requires_openai_auth = false
base_url = "https://before.example/v1"
api_key = "before-key"
"#;
        let profile = StoredProfile {
            connection_kind: None,
            name: "after".to_string(),
            base_url: "https://after.example/v1".to_string(),
            endpoint_mode: default_endpoint_mode(),
            api_key: "after-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-after".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            capability_profile: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, "test-profile", &profile).unwrap();

        assert!(next.contains("[model_providers.custom.auth]"));
        assert!(!next.contains("requires_openai_auth"));
    }

    #[test]
    fn incomplete_backup_staging_is_removed() {
        let path = env::temp_dir().join(format!(
            "signalman-backup-staging-{}",
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir(&path).unwrap();
        {
            let _staging = BackupStaging::new(path.clone());
        }

        assert!(!path.exists());
    }
}

#[cfg(test)]
fn build_model_catalog(
    provider_id: &str,
    profile: &StoredProfile,
    status: &str,
    detail: &str,
    models: Vec<ProviderModel>,
) -> ModelCatalog {
    provider_build_model_catalog(provider_id, profile, status, detail, models, now_label())
}

#[tauri::command]
async fn prepare_connection_environment(
    layer_id: String,
    onboarding: Option<bool>,
    progress: Channel<InitializationStep>,
) -> Result<InitializationReport, SwitcherError> {
    let _ = layer_id; // Installation always manages the user's root configuration.
    run_blocking_command(move || Ok(initialize_with_progress(onboarding.unwrap_or(false), &mut |step| {
        let _ = progress.send(step);
    }))).await
}

#[tauri::command]
fn complete_onboarding() -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    complete_onboarding_core()
}

pub fn prepare_connection_environment_core(layer_id: String) -> Result<AppState, SwitcherError> {
    prepare_connection_environment_core_with_onboarding(layer_id, false)
}

pub fn prepare_connection_environment_core_with_onboarding(
    _requested_layer_id: String,
    onboarding: bool,
) -> Result<AppState, SwitcherError> {
    let report = initialize_with_progress(onboarding, &mut |_| {});
    if !report.can_continue {
        return Err(SwitcherError::Message(report.steps.iter().find(|step| step.status == "failure").map(|step| step.detail.clone()).unwrap_or_else(|| "初始化未完成，请查看检查结果。".into())));
    }
    report.state.ok_or_else(|| SwitcherError::Message("初始化状态暂时无法加载。".into()))
}

pub fn complete_onboarding_core() -> Result<AppState, SwitcherError> {
    let mut record = load_connection_environment_record();
    let selected_valid = record.selected_layer_id.as_ref().is_some_and(|selected| {
        configuration_layer_candidates()
            .map(|layers| layers.iter().any(|(id, _, _)| id == selected))
            .unwrap_or(false)
    });
    if !record.setup_completed || !selected_valid {
        return Err(SwitcherError::Message(
            "连接环境尚未准备完成，暂时不能结束首次使用流程。".to_string(),
        ));
    }
    record.onboarding_completed = true;
    save_connection_environment_record(&record)?;
    app_state().or_else(|_| startup_safe_state(StartupNotice { code: "onboarding-state-unavailable".into(), detail: "初始化已完成，完整状态暂时无法读取；已进入安全视图，可稍后刷新。".into() }))
}

fn switch_config(
    profile_id: &str,
    profile: &StoredProfile,
    expected_fingerprint: &str,
    expected_candidate_fingerprint: &str,
    expected_protected_fingerprint: &str,
    expected_candidate_protected_fingerprint: &str,
) -> Result<(), SwitcherError> {
    let original = read_config()?;
    ensure_configuration_layer_is_unambiguous()?;
    let config = config_path()?;
    let original_auth_text = read_auth()?;
    let before_fingerprint = owned_configuration_fingerprint(&original, &original_auth_text)?;
    let before_protected_fingerprint =
        protected_configuration_fingerprint(&original, &original_auth_text)?;
    if before_fingerprint != expected_fingerprint {
        return Err(SwitcherError::Message(
            "切换预览已过期：Codex 服务商设置已发生变化，请重新检查后确认。".to_string(),
        ));
    }
    if !expected_protected_fingerprint.is_empty()
        && before_protected_fingerprint != expected_protected_fingerprint
    {
        return Err(SwitcherError::Message(
            "切换预览已过期：受保护配置已发生变化，请重新检查后确认。".to_string(),
        ));
    }
    healthy_baseline_backup()?;
    let next_config = build_profile_config(&original, profile_id, profile)?;
    let next_auth = build_next_auth(&original_auth_text, profile)?;
    let candidate_fingerprint = owned_configuration_fingerprint(&next_config, &next_auth)?;
    let candidate_protected_fingerprint =
        protected_configuration_fingerprint(&next_config, &next_auth)?;
    if candidate_fingerprint != expected_candidate_fingerprint {
        return Err(SwitcherError::Message(
            "切换预览已失效：目标服务商认证或配置发生变化，请重新检查。".to_string(),
        ));
    }
    if !expected_candidate_protected_fingerprint.is_empty()
        && candidate_protected_fingerprint != expected_candidate_protected_fingerprint
    {
        return Err(SwitcherError::Message(
            "切换预览已失效：受保护配置候选发生变化，请重新检查。".to_string(),
        ));
    }
    let backup = create_backup()?;
    let backup_id = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SwitcherError::Message("恢复点标识无效。".to_string()))?;
    begin_config_transaction(backup_id, "switch", &before_fingerprint)?;
    if let Err(error) = write_bytes_atomically(&config, next_config.as_bytes()) {
        let _ = complete_config_transaction();
        return Err(error);
    }
    update_config_transaction_phase("config_replaced")?;
    // Provider switching never writes Codex-owned authentication. Keeping the
    // original bytes is the hard boundary that lets official OAuth coexist
    // with a third-party Responses route.
    update_config_transaction_phase("auth_preserved")?;
    let written_config = match fs::read_to_string(&config) {
        Ok(value) => value,
        Err(error) => {
            rollback_config_transaction(&config, &original)?;
            return Err(error.into());
        }
    };
    let written_auth = match read_auth() {
        Ok(value) => value,
        Err(error) => {
            rollback_config_transaction(&config, &original)?;
            return Err(error.into());
        }
    };
    if written_config != next_config
        || written_auth != next_auth
        || protected_configuration_fingerprint(&written_config, &written_auth)?
            != before_protected_fingerprint
    {
        rollback_config_transaction(&config, &original)?;
        return Err(SwitcherError::Message(
            "切换后的配置回读不一致，已恢复切换前文件。".to_string(),
        ));
    }
    let fingerprint = owned_configuration_fingerprint(&written_config, &written_auth)?;
    record_backup_post_change(&backup, &fingerprint)?;
    let initial_backup = backups_dir()?.join(INITIAL_BACKUP_LABEL);
    if let Ok(initial_manifest) =
        fs::read_to_string(initial_backup.join("manifest.json")).and_then(|text| {
            serde_json::from_str::<BackupManifest>(&text).map_err(std::io::Error::other)
        })
    {
        if initial_manifest.post_change_fingerprint.is_none() {
            record_backup_post_change(&initial_backup, &fingerprint)?;
        }
    }
    record_operation_receipt(ConfigOperationReceipt {
        id: unique_backup_label("switch-receipt"),
        backup_id: backup_id.to_string(),
        kind: "switch".to_string(),
        created_at: now_label(),
        fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
        before_fingerprint,
        after_fingerprint: fingerprint,
    })?;
    update_config_transaction_phase("verified")?;
    complete_config_transaction()?;
    Ok(())
}

#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    let mut state = load_state_core()?;
    match app.autolaunch().is_enabled() {
        Ok(enabled) => state.auto_start = enabled,
        Err(_) => {
            let notice = StartupNotice {
                code: "autostart-status".to_string(),
                detail: "Windows 开机启动状态暂时无法读取；窗口和配置保护仍可正常使用。"
                    .to_string(),
            };
            record_startup_diagnostic(&notice);
            state.startup_notice = Some(notice);
            state.auto_start = false;
        }
    }
    Ok(state)
}

pub fn load_state_core() -> Result<AppState, SwitcherError> {
    let state = match ensure_daily_backup() {
        Ok(true) => app_state_with_activity(
            "已创建今日自动备份",
            "已保存当前服务商设置；每天首次打开应用时最多创建一次。",
            "success",
        ),
        Ok(false) => app_state(),
        Err(error) => {
            let notice = StartupNotice {
                code: startup_error_code(&error),
                detail: "本次自动备份未完成。窗口仍可打开；在首次基线备份完成前，切换和恢复等写入操作会保持受保护状态。".to_string(),
            };
            record_startup_diagnostic(&notice);
            return startup_safe_state(notice);
        }
    };
    match state {
        Ok(state) => Ok(state),
        Err(error) => {
            let notice = StartupNotice {
                code: startup_error_code(&error),
                detail: "启动检查未完成。窗口仍可打开；请修复配置或备份问题后重新检查。"
                    .to_string(),
            };
            record_startup_diagnostic(&notice);
            startup_safe_state(notice)
        }
    }
}

#[tauri::command]
fn create_manual_backup(confirmation: Option<String>) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    create_manual_backup_core(confirmation.as_deref())
}

pub fn create_manual_backup_core(confirmation: Option<&str>) -> Result<AppState, SwitcherError> {
    ensure_initial_backup()?;
    let limit = load_catalog()?.backup_policy.manual_limit;
    if managed_manual_backup_count()? >= limit && confirmation.map(str::trim) != Some("替换") {
        return Err(SwitcherError::Message(format!(
            "已保留 {limit} 个手动恢复点。确认替换最早的手动恢复点前，请在确认窗口中继续。"
        )));
    }
    let label = unique_backup_label("manual");
    create_backup_with_label(&label, "manual")?;
    app_state_with_activity(
        "已创建手动恢复点",
        "已保存当前服务商设置；恢复时只会还原本工具管理的字段。",
        "success",
    )
}

#[tauri::command]
fn set_backup_policy(
    automatic_limit: usize,
    manual_limit: usize,
) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    set_backup_policy_core(automatic_limit, manual_limit)
}

pub fn set_backup_policy_core(
    automatic_limit: usize,
    manual_limit: usize,
) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let next = BackupPolicy {
        automatic_limit: normalized_backup_limit(automatic_limit),
        manual_limit: normalized_backup_limit(manual_limit),
    };
    catalog.backup_policy = next.clone();
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        "恢复点保留数量已更新",
        &format!(
            "自动保护保留 {} 个，手动保存保留 {} 个；旧版历史目录不会自动删除。",
            next.automatic_limit, next.manual_limit
        ),
        "info",
    )
}

#[tauri::command]
fn save_profile(profile: EditableProfile) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    save_profile_core(profile)
}

pub fn save_profile_core(profile: EditableProfile) -> Result<AppState, SwitcherError> {
    if profile
        .connection_kind
        .as_deref()
        .is_some_and(|kind| !matches!(kind, "relay" | "official-api"))
    {
        return Err(SwitcherError::Message(
            "官方账号请使用独立登录入口，不能保存为 API 服务商。".into(),
        ));
    }
    let mut catalog = load_catalog()?;
    if profile.name.trim().is_empty() {
        return Err(SwitcherError::Message("服务商名称不能为空。".to_string()));
    }
    let id = profile_id_for_save(&catalog, &profile.id, &profile.name);
    if id.is_empty() {
        return Err(SwitcherError::Message("服务商名称不能为空。".to_string()));
    }
    if !profile.base_url.trim().starts_with("http://")
        && !profile.base_url.trim().starts_with("https://")
    {
        return Err(SwitcherError::Message(
            "接口地址必须以 http 或 https 开头。".to_string(),
        ));
    }
    let existing = catalog.profiles.get(&id).cloned();
    let existing_profile = existing.and_then(|v| serde_json::from_value::<StoredProfile>(v).ok());
    let api_key = if profile.api_key.trim().is_empty() {
        existing_profile
            .as_ref()
            .map(|p| p.api_key.clone())
            .unwrap_or_default()
    } else {
        profile.api_key.trim().to_string()
    };
    let preferred_mode = preferred_auth_mode(&profile.name, &profile.base_url);
    let auth_mode = existing_profile
        .as_ref()
        .map(|p| p.auth_mode.clone())
        .filter(|mode| {
            // Do not carry a legacy command adapter to a non-ModelFlare
            // endpoint; conversely, promote a default-mode ModelFlare profile
            // to its registered command adapter immediately on save.
            !(mode == "provider_command" && preferred_mode != "provider_command")
                && !(mode == &default_auth_mode() && preferred_mode == "provider_command")
        })
        .unwrap_or_else(|| preferred_mode.clone());
    let mut stored = StoredProfile {
        connection_kind: profile.connection_kind.clone().or_else(|| {
            existing_profile
                .as_ref()
                .and_then(|p| p.connection_kind.clone())
        }),
        name: profile.name.trim().to_string(),
        base_url: profile.base_url.trim().to_string(),
        endpoint_mode: if profile.endpoint_mode == "full" { "full".to_string() } else { default_endpoint_mode() },
        api_key,
        api_key_protected: String::new(),
        model: profile.model.trim().to_string(),
        auth_mode,
        model_reasoning_effort: existing_profile
            .as_ref()
            .map(|p| p.model_reasoning_effort.clone())
            .unwrap_or_else(default_reasoning),
        verified: false,
        verification_status: default_verification_status(),
        verification_response_shape: None,
        capability_profile: None,
        default: existing_profile
            .as_ref()
            .map(|p| p.default)
            .unwrap_or(false),
        note: profile.note.trim().to_string(),
        last_switched_at: existing_profile
            .as_ref()
            .and_then(|p| p.last_switched_at.clone()),
        last_verified_at: None,
        last_verification_detail: None,
        last_verification_stage: None,
        last_verification_http_status: None,
        last_verification_provider_code: None,
    };
    reset_profile_verification(&mut stored, "保存后需要重新运行服务商可用性测试。");
    let display_name = stored.name.clone();
    let is_new = !catalog.profiles.contains_key(&id);
    catalog
        .profiles
        .insert(id.clone(), serde_json::to_value(stored)?);
    if is_new {
        catalog.profile_order.push(id.clone());
    }
    invalidate_catalog_model_verifications(&mut catalog, &id);
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已保存"),
        "服务商信息已更新；已清除旧兼容性探测结果。",
        "info",
    )
}

#[tauri::command]
fn delete_profile(profile_id: String) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    delete_profile_core(profile_id)
}

pub fn delete_profile_core(profile_id: String) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let config = read_config().unwrap_or_default();
    let current = current_profile_id(&catalog, &config);
    if profile_id == current {
        return Err(SwitcherError::Message("当前服务商不能删除。".to_string()));
    }
    let stored = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let profile = serde_json::from_value::<StoredProfile>(stored)?;
    let display_name = profile.name.clone();
    if profile.default {
        return Err(SwitcherError::Message("默认服务商不能删除。".to_string()));
    }
    catalog.profiles.remove(&profile_id);
    catalog.profile_order.retain(|id| id != &profile_id);
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已删除"),
        "该服务商已从切换目录移除；当前和默认服务商不会被删除。",
        "warning",
    )
}

#[tauri::command]
fn reorder_profiles(profile_ids: Vec<String>) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    reorder_profiles_core(profile_ids)
}

pub fn reorder_profiles_core(profile_ids: Vec<String>) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let unique_ids = profile_ids.iter().collect::<BTreeSet<_>>();
    if profile_ids.len() != catalog.profiles.len()
        || unique_ids.len() != catalog.profiles.len()
        || profile_ids
            .iter()
            .any(|id| !catalog.profiles.contains_key(id))
    {
        return Err(SwitcherError::Message("服务商排序内容无效。".to_string()));
    }
    catalog.profile_order = profile_ids;
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        "服务商顺序已更新",
        "此顺序只影响列表显示，不会切换或改写 Codex 设置。",
        "info",
    )
}

#[tauri::command]
fn reveal_profile_api_key(profile_id: String) -> Result<String, SwitcherError> {
    let _scope = qa::operation_scope()?;
    reveal_profile_api_key_core(profile_id)
}

pub fn reveal_profile_api_key_core(profile_id: String) -> Result<String, SwitcherError> {
    let catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let profile: StoredProfile = serde_json::from_value(value)?;
    if profile.api_key.trim().is_empty() {
        return Err(SwitcherError::Message(
            "该服务商没有已保存的访问密钥。".to_string(),
        ));
    }
    Ok(profile.api_key)
}

/// Credential helper is read-only and independent of the launching shell.
/// Never run catalog migrations, recovery or default-home discovery here.
pub fn read_bound_provider_token(
    data_root: &str,
    profile_id: &str,
) -> Result<String, SwitcherError> {
    let root = Path::new(data_root);
    if !root.is_absolute() || !root.is_dir() {
        return Err(SwitcherError::Message("凭据资料目录无效。".into()));
    }
    let catalog: StoredCatalog =
        parse_json_document(&fs::read_to_string(root.join(PROFILES_FILE))?)?;
    let value = catalog
        .profiles
        .get(profile_id)
        .ok_or_else(|| SwitcherError::Message("服务商不存在。".into()))?;
    let profile: StoredProfile = serde_json::from_value(value.clone())?;
    let token = if profile.api_key_protected.is_empty() {
        profile.api_key
    } else {
        String::from_utf8(unprotect_secret(&profile.api_key_protected)?)
            .map_err(|_| SwitcherError::Message("凭据无效。".into()))?
    };
    if token.trim().is_empty() {
        return Err(SwitcherError::Message("凭据为空。".into()));
    }
    Ok(token)
}

pub fn qa_emergency_restore() -> Result<(), SwitcherError> {
    qa::emergency_restore()
}

fn official_provider_config(original: &str, model: &str) -> Result<String, SwitcherError> {
    if model.trim().is_empty() || model.contains(['\n', '\r']) {
        return Err(SwitcherError::Message(
            "请输入账号可用的官方模型标识。".into(),
        ));
    }
    toml::from_str::<toml::Value>(original)?;
    let mut lines = original.lines().map(str::to_owned).collect::<Vec<_>>();
    upsert_root_string(&mut lines, "model_provider", "openai");
    upsert_root_string(&mut lines, "model", model.trim());
    // `openai_base_url` overrides the built-in OpenAI endpoint. Leaving a
    // third-party value behind would make an "official" switch misleading.
    remove_root_key(&mut lines, "openai_base_url");
    // A provider-specific catalog must not shadow the official Codex catalog.
    remove_root_key(&mut lines, "model_catalog_json");
    let next = lines.join("\r\n");
    if !protected_sections_match(original, &next)? {
        return Err(SwitcherError::Message(
            "官方切换会影响受保护配置，已停止。".into(),
        ));
    }
    Ok(next)
}

fn activate_official_provider_core(model: &str) -> Result<AppState, SwitcherError> {
    ensure_configuration_layer_is_unambiguous()?;
    let config = config_path()?;
    let original = read_config()?;
    let auth = read_auth()?;
    let next = official_provider_config(&original, model)?;
    let backup = create_backup()?;
    let id = backup
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| SwitcherError::Message("恢复点标识无效。".into()))?;
    let before = owned_configuration_fingerprint(&original, &auth)?;
    begin_config_transaction(id, "official-switch", &before)?;
    write_bytes_atomically(&config, next.as_bytes())?;
    update_config_transaction_phase("config_replaced")?;
    if fs::read_to_string(&config)? != next {
        write_bytes_atomically(&config, original.as_bytes())?;
        complete_config_transaction()?;
        return Err(SwitcherError::Message(
            "官方配置回读失败，已恢复原设置。".into(),
        ));
    }
    let after = owned_configuration_fingerprint(&next, &read_auth()?)?;
    record_backup_post_change(&backup, &after)?;
    record_operation_receipt(ConfigOperationReceipt {
        id: unique_backup_label("official-receipt"),
        backup_id: id.into(),
        kind: "official-switch".into(),
        created_at: now_label(),
        fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
        before_fingerprint: before,
        after_fingerprint: after,
    })?;
    complete_config_transaction()?;
    app_state_with_activity("已选择官方推理通道", "重启目标 Codex 后生效；官方账号、模型权限和实际调用仍以 Codex 为准。第三方配置保留，可再次切换。", "success")
}

pub fn prepare_switch_core(profile_id: String) -> Result<SwitchPreflight, SwitcherError> {
    let mut catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let mut profile: StoredProfile = serde_json::from_value(value)?;
    let display_name = profile.name.clone();
    if profile.model.trim().is_empty() {
        return Err(SwitcherError::Message(
            "切换已阻止：缺少 Codex 使用的模型名称。".to_string(),
        ));
    }
    if let Err(detail) = provider_probe_endpoint(&profile.base_url, "responses") {
        return Err(SwitcherError::Message(format!("切换已阻止：{detail}")));
    }
    let config = read_config()?;
    ensure_configuration_layer_is_unambiguous()?;
    let auth = read_auth()?;
    let fingerprint = owned_configuration_fingerprint(&config, &auth)?;
    let protected_fingerprint = protected_configuration_fingerprint(&config, &auth)?;
    healthy_baseline_backup()?;
    let verification = verify_provider_auth_probe(&profile);
    let verified = verification.verified;
    let status = verification.status.clone();
    let detail = verification.detail.clone();
    let verified_at = now_label();
    apply_verification(&mut profile, verification, verified_at.clone());
    if profile
        .capability_profile
        .as_ref()
        .is_some_and(|capability| protocol_gateway::requires_gateway(&capability.protocol))
    {
        protocol_gateway::ensure_running().map_err(SwitcherError::Message)?;
    }
    let candidate_config = build_profile_config(&config, &profile_id, &profile)?;
    let candidate_auth = build_next_auth(&auth, &profile)?;
    let candidate_fingerprint =
        owned_configuration_fingerprint(&candidate_config, &candidate_auth)?;
    let candidate_protected_fingerprint =
        protected_configuration_fingerprint(&candidate_config, &candidate_auth)?;
    update_catalog_model_verification(
        &mut catalog,
        &profile_id,
        &profile.model,
        verified,
        &status,
        &detail,
        &verified_at,
    )?;
    catalog
        .profiles
        .insert(profile_id.clone(), serde_json::to_value(&profile)?);
    save_catalog(&mut catalog)?;
    let mut risks = Vec::new();
    if profile.api_key.trim().is_empty() {
        risks.push(
            "未保存应用访问密钥；切换器已记录外部认证风险，无法用 profile 凭据确认目标服务商。"
                .to_string(),
        );
    }
    if !verified {
        risks.push(format!("目标服务商的本次自动检查未确认可用：{detail}"));
    } else if profile
        .capability_profile
        .as_ref()
        .is_some_and(|capability| capability.streaming != "verified")
    {
        risks.push(
            "目标服务商已完成基本调用，但尚未证明能完整传输 Codex 的流式响应；长任务或实时输出可能中断。"
                .to_string(),
        );
    }
    // A profile-key switch writes the selected key to auth.json in the same
    // transaction. Do not ask the user to acknowledge a generic external-auth
    // warning for that fully-bound contract; retain the warning for profiles
    // that deliberately rely on Codex login or an environment variable.
    if profile.api_key.trim().is_empty() {
        if let Some(detail) = custom_authentication_risk(&candidate_config)? {
            risks.push(detail);
        }
    }
    let operation_id = unique_backup_label("switch");
    let expires_at = Local::now().timestamp() + 10 * 60;
    let preflight = StoredSwitchPreflight {
        operation_id: operation_id.clone(),
        profile_id: profile_id.clone(),
        created_at: now_label(),
        expires_at,
        fingerprint,
        candidate_fingerprint,
        protected_fingerprint,
        candidate_protected_fingerprint,
        risk_acknowledgement_required: !risks.is_empty(),
    };
    write_bytes_atomically(
        &switch_preflight_path()?,
        serde_json::to_string_pretty(&preflight)?.as_bytes(),
    )?;
    let mut diagnostics = verification_activity_diagnostics(&profile);
    diagnostics.extend(
        [
            diagnostic_field(
                "switch_preflight.risk_acknowledgement_required",
                "需要确认使用风险",
                (!risks.is_empty()).to_string(),
            ),
            diagnostic_field(
                "switch_preflight.protected_fields_verified",
                "受保护设置检查",
                "passed",
            ),
        ]
        .into_iter()
        .flatten(),
    );
    push_activity_diagnostics(
        if risks.is_empty() {
            "切换前检查已完成"
        } else {
            "切换前检查发现使用风险"
        },
        if risks.is_empty() {
            "已确认目标服务商可检查，且候选配置未触及项目、MCP、插件和其他受保护设置。"
        } else {
            "已完成写入安全检查；目标服务商仍有使用风险，需要在切换确认窗口阅读并确认。"
        },
        if risks.is_empty() {
            "success"
        } else {
            "warning"
        },
        "provider.switch_preflight",
        if risks.is_empty() {
            "success"
        } else {
            "warning"
        },
        if risks.is_empty() {
            "如需切换，请在确认窗口继续；切换前会再核对候选状态。"
        } else {
            "请查看风险说明；确认理解后才能继续切换，或先回到服务商设置处理。"
        },
        Some(&profile.name),
        Some(&profile.model),
        diagnostics,
    )?;
    Ok(SwitchPreflight {
        operation_id,
        profile_id,
        target_name: display_name,
        target_model: profile.model,
        backup_detail: "确认后将创建新的受保护恢复点。".to_string(),
        protected_detail:
            "候选 config/auth 已通过 provider 白名单和 MCP、插件、项目等受保护内容检查。"
                .to_string(),
        availability_status: profile.verification_status.clone(),
        availability_detail: detail,
        availability_checked_at: profile.last_verified_at.clone().unwrap_or_else(now_label),
        availability_stage: profile.last_verification_stage.clone(),
        availability_http_status: profile.last_verification_http_status,
        availability_provider_code: profile.last_verification_provider_code.clone(),
        capability_profile: profile.capability_profile.clone(),
        risk_detail: (!risks.is_empty()).then(|| risks.join(" ")),
        expires_at: chrono::DateTime::from_timestamp(expires_at, 0)
            .map(|value| {
                value
                    .with_timezone(&Local)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string()
            })
            .unwrap_or_else(now_label),
    })
}

#[tauri::command]
fn switch_profile(
    profile_id: String,
    operation_id: String,
    risk_acknowledged: bool,
) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    switch_profile_core(profile_id, operation_id, risk_acknowledged)
}

pub fn switch_profile_core(
    profile_id: String,
    operation_id: String,
    risk_acknowledged: bool,
) -> Result<AppState, SwitcherError> {
    let preflight: StoredSwitchPreflight =
        serde_json::from_str(&fs::read_to_string(switch_preflight_path()?)?)
            .map_err(|_| SwitcherError::Message("切换预览无效，请重新运行检查。".to_string()))?;
    if preflight.operation_id != operation_id || preflight.profile_id != profile_id {
        return Err(SwitcherError::Message(
            "切换预览不匹配，请重新运行检查。".to_string(),
        ));
    }
    if Local::now().timestamp() > preflight.expires_at {
        return Err(SwitcherError::Message(
            "切换预览已过期，请重新运行检查。".to_string(),
        ));
    }
    let mut catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let mut profile: StoredProfile = serde_json::from_value(value)?;
    let display_name = profile.name.clone();
    if profile.model.trim().is_empty() {
        return Err(SwitcherError::Message(
            "切换预览已失效：服务商模型发生变化，请重新检查。".to_string(),
        ));
    }
    let has_risk = preflight.risk_acknowledgement_required;
    if has_risk && !risk_acknowledged {
        return Err(SwitcherError::Message(
            "本次切换存在使用风险。请在确认窗口勾选“我已了解风险”后继续。".to_string(),
        ));
    }
    switch_config(
        &profile_id,
        &profile,
        &preflight.fingerprint,
        &preflight.candidate_fingerprint,
        &preflight.protected_fingerprint,
        &preflight.candidate_protected_fingerprint,
    )?;
    let _ = fs::remove_file(switch_preflight_path()?);
    profile.last_switched_at = Some(now_label());
    catalog
        .profiles
        .insert(profile_id, serde_json::to_value(profile)?);
    save_catalog(&mut catalog)?;
    app_state_with_activity_diagnostics(
        &format!("已切换到 {display_name}"),
        if has_risk {
            "已写入同一候选认证合同的 Codex 服务商配置并生成回滚备份；切换前自动检查提示的使用风险已由用户确认。"
        } else {
            "已写入同一候选认证合同的 Codex 服务商配置并生成回滚备份；切换前自动检查已通过。"
        },
        if has_risk { "warning" } else { "success" },
        "provider.switch",
        if has_risk { "warning" } else { "success" },
        if has_risk {
            "请在 Codex 重启或刷新后确认新服务商；如异常，可使用最近恢复点回退。"
        } else {
            "请在 Codex 重启或刷新后确认新服务商；如异常，可使用最近恢复点回退。"
        },
        Some(&display_name),
        None,
        [
            diagnostic_field(
                "switch.risk_acknowledged",
                "已确认使用风险",
                has_risk.to_string(),
            ),
            diagnostic_field(
                "switch.protected_fields_verified",
                "受保护设置检查",
                "passed",
            ),
            diagnostic_field("switch.rollback_backup_created", "恢复点", "created"),
        ]
        .into_iter()
        .flatten()
        .collect(),
    )
}

pub fn verify_profile_core(profile_id: String) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let mut profile: StoredProfile = serde_json::from_value(value)?;
    let display_name = profile.name.clone();
    let verification = verify_provider_auth_probe(&profile);
    let verified = verification.verified;
    let status = verification.status.clone();
    let detail = verification.detail.clone();
    let verified_at = now_label();
    apply_verification(&mut profile, verification, verified_at.clone());
    update_catalog_model_verification(
        &mut catalog,
        &profile_id,
        &profile.model,
        verified,
        &status,
        &detail,
        &verified_at,
    )?;
    catalog
        .profiles
        .insert(profile_id, serde_json::to_value(&profile)?);
    save_catalog(&mut catalog)?;
    if verified {
        app_state_with_activity_diagnostics(
            "服务商可用性测试通过",
            &format!("{display_name} 已完成短时、已认证的可用性测试。"),
            "success",
            "provider.verification",
            "success",
            "可以继续切换或刷新模型目录；实际使用仍取决于服务商额度和网络状况。",
            Some(&display_name),
            Some(&profile.model),
            verification_activity_diagnostics(&profile),
        )
    } else if status == "response_shape_unconfirmed" || status == "response_unparseable" {
        app_state_with_activity_diagnostics(
            "服务端已响应，结果待确认",
            &format!("{display_name} 的可用性测试未能确认模型输出：{detail}"),
            "warning",
            "provider.verification",
            "warning",
            "请展开诊断详情，并用服务商请求编号或错误代码向服务商、搜索引擎或 AI 查询。",
            Some(&display_name),
            Some(&profile.model),
            verification_activity_diagnostics(&profile),
        )
    } else {
        app_state_with_activity_diagnostics(
            "服务商可用性测试未确认",
            &format!("{display_name} 的可用性测试未确认：{detail}"),
            "warning",
            "provider.verification",
            "warning",
            "请展开诊断详情，先核对认证、模型名称、额度和网络，再重新检查。",
            Some(&display_name),
            Some(&profile.model),
            verification_activity_diagnostics(&profile),
        )
    }
}

pub fn run_response_probe_core(profile_id: String) -> Result<AppState, SwitcherError> {
    run_response_probe_for_model_core(profile_id, String::new())
}

pub fn run_response_probe_for_model_core(
    profile_id: String,
    benchmark_model: String,
) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let profile: StoredProfile = serde_json::from_value(value)?;
    if profile.api_key.trim().is_empty() {
        return Err(SwitcherError::Message(
            "缺少 API 密钥，无法运行返回能力探针。".to_string(),
        ));
    }
    let requested_model = if benchmark_model.trim().is_empty() {
        profile.model.trim().to_string()
    } else {
        benchmark_model.trim().to_string()
    };
    if requested_model.is_empty() {
        return Err(SwitcherError::Message(
            "缺少默认模型，无法运行返回能力探针。".to_string(),
        ));
    }
    let endpoint =
        provider_probe_endpoint(&profile.base_url, "responses").map_err(SwitcherError::Message)?;
    let observed_at = now_label();
    let mut observation = ResponseProbeObservation {
        id: format!("response-probe-{}", Local::now().timestamp_millis()),
        provider_id: profile_id.clone(),
        provider_name: profile.name.clone(),
        model: requested_model.clone(),
        probe_version: "cost-calibration-v2".to_string(),
        observed_at: observed_at.clone(),
        status: "failed".to_string(),
        http_status: None,
        request_id: None,
        response_id: None,
        actual_model: None,
        usage: None,
        cost_candidate: None,
        cost_source: None,
        detail: "探针未完成。".to_string(),
    };
    if is_isolated_development_fixture(&profile) {
        observation.status = "final_cost_inline".to_string();
        observation.http_status = Some(200);
        observation.request_id = Some(format!("development-{profile_id}"));
        observation.response_id = Some(format!("response-{profile_id}"));
        observation.actual_model = Some(requested_model.clone());
        observation.usage = Some(ProbeUsage {
            input_tokens: Some(12),
            output_tokens: Some(4),
            total_tokens: Some(16),
            cached_tokens: Some(0),
            cache_write_tokens: Some(0),
            reasoning_tokens: Some(0),
        });
        observation.cost_candidate = Some(
            if profile_id == "example-provider-d" {
                "0.000398"
            } else {
                "0.000524"
            }
            .to_string(),
        );
        observation.cost_source = Some("response_usage".to_string());
        observation.detail = "已从服务商回包读取测试额度。".to_string();
        let detail = observation.detail.clone();
        let diagnostics = response_probe_activity_diagnostics(&observation);
        push_probe_observation(&mut catalog, observation);
        save_catalog(&mut catalog)?;
        return app_state_with_activity_diagnostics(
            "返回能力探针已完成",
            &format!("{}：{detail}", profile.name),
            "success",
            "provider.response_probe",
            "success",
            "可在费用实验室核对本次用量；如需对账，可用服务商请求编号查询后台。",
            Some(&profile.name),
            Some(&requested_model),
            diagnostics,
        );
    }
    let client = configure_http_client(
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .http1_only(),
    )
    .build()
    .map_err(|err| SwitcherError::Message(format!("创建探针连接失败：{err}")))?;
    qa::guard_network(&endpoint)?;
    let response = client
        .post(endpoint)
        .bearer_auth(profile.api_key.trim())
        .json(&json!({
            "model": requested_model,
            "input": "Reply with OK.",
            "max_output_tokens": 16,
            "store": false,
        }))
        .send();

    match response {
        Ok(response) => {
            let http_status = response.status().as_u16();
            observation.http_status = Some(http_status);
            observation.request_id = response_header_id(response.headers());
            if let Some((cost, source)) = response_header_cost(response.headers()) {
                observation.cost_candidate = Some(cost);
                observation.cost_source = Some(source);
            }
            if response.status().is_success() {
                match response.json::<Value>() {
                    Ok(body) => {
                        observation.response_id = body
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string);
                        observation.actual_model = body
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string);
                        observation.usage = probe_usage(&body);
                        if let Some((cost, source)) = response_cost_candidate(&body) {
                            observation.cost_candidate = Some(cost);
                            observation.cost_source = Some(source);
                        }
                        if has_provider_error(&body) {
                            observation.status = "failed".to_string();
                            observation.detail =
                                "服务商返回了业务错误；未把响应中的费用或用量当作测试结果。"
                                    .to_string();
                        } else if observation
                            .actual_model
                            .as_deref()
                            .is_some_and(|model| !model.eq_ignore_ascii_case(&requested_model))
                        {
                            observation.status = "model_mismatch".to_string();
                            observation.detail = "服务商实际返回的模型与请求模型不一致；已记录关联信息，但不能用于固定测试比较。".to_string();
                        } else if observation.cost_candidate.is_some() {
                            observation.status = "cost_candidate_unverified".to_string();
                            observation.detail = "已记录服务端费用提示；它的币种或平台单位未获证明，不会自动作为平台真实扣额。请以平台使用日志为准。".to_string();
                        } else if observation.usage.is_some() {
                            observation.status = "usage_only".to_string();
                            observation.detail =
                                "响应包含用量字段，可与服务商后台日志交叉核对。".to_string();
                        } else if observation.request_id.is_some()
                            || observation.response_id.is_some()
                        {
                            observation.status = "correlation_only".to_string();
                            observation.detail =
                                "已获得关联 ID，可到服务商后台定位本次调用。".to_string();
                        } else {
                            observation.status = "no_signal".to_string();
                            observation.detail =
                                "服务商已响应，但没有返回可安全保存的费用、用量或关联线索。"
                                    .to_string();
                        }
                    }
                    Err(_) => {
                        observation.detail =
                            "服务商已响应，但返回体无法按 JSON 解析；未保存完整响应。".to_string();
                    }
                }
            } else {
                observation.detail = format!("服务商返回 HTTP {http_status}；未保存错误响应内容。")
            }
        }
        Err(error) if error.is_timeout() => {
            observation.detail = "服务商响应超时；未确认返回能力。".to_string();
        }
        Err(error) if error.is_connect() => {
            observation.detail =
                "无法建立服务商连接；请检查网络、DNS、TLS 或代理链路。".to_string();
        }
        Err(_) => {
            observation.detail = "服务商请求在传输过程中失败；未确认返回能力。".to_string();
        }
    }

    let succeeded = observation.status != "failed";
    let status = observation.status.clone();
    let detail = observation.detail.clone();
    let diagnostics = response_probe_activity_diagnostics(&observation);
    push_probe_observation(&mut catalog, observation);
    save_catalog(&mut catalog)?;
    app_state_with_activity_diagnostics(
        if succeeded {
            "返回能力探针已完成"
        } else {
            "返回能力探针未完成"
        },
        &format!("{}：{detail}", profile.name),
        if succeeded && status != "no_signal" {
            "success"
        } else {
            "warning"
        },
        "provider.response_probe",
        if succeeded && status != "no_signal" {
            "success"
        } else {
            "warning"
        },
        if succeeded {
            "可在费用实验室核对本次用量；如需对账，可用服务商请求编号查询后台。"
        } else {
            "请展开诊断详情，先检查 HTTP 状态、请求编号、网络和服务商额度后再重试。"
        },
        Some(&profile.name),
        Some(&requested_model),
        diagnostics,
    )
}

#[tauri::command]
fn save_cost_calibration(input: CostCalibrationInput) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    save_cost_calibration_core(input)
}

pub fn save_cost_calibration_core(input: CostCalibrationInput) -> Result<AppState, SwitcherError> {
    if input.provider_id.trim().is_empty()
        || input.provider_name.trim().is_empty()
        || input.model.trim().is_empty()
        || input.probe_version.trim().is_empty()
    {
        return Err(SwitcherError::Message(
            "费用校准缺少服务商、模型或探针版本信息。".to_string(),
        ));
    }
    if !input.debit_confirmed {
        return Err(SwitcherError::Message(
            "请先确认填写的是平台使用日志中的真实扣额，且与到账额度单位相同。".to_string(),
        ));
    }
    let result_cny = calculate_calibrated_cost(&input)?;
    let official_cny = input
        .official_cny
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_fixed_decimal(value, "官方同次成本").map(|_| value.to_string()))
        .transpose()?;
    let now = now_label();
    let mut catalog = load_catalog()?;
    if let Some(probe_id) = input
        .probe_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let probe = catalog
            .response_probes
            .iter()
            .find(|probe| probe.id == probe_id)
            .ok_or_else(|| {
                SwitcherError::Message(
                    "这条费用样本关联的固定测试不存在，请重新运行测试或清空关联。".to_string(),
                )
            })?;
        if probe.provider_id != input.provider_id
            || probe.model != input.model
            || probe.probe_version != input.probe_version
        {
            return Err(SwitcherError::Message(
                "固定测试与当前服务商、模型或测试版本不一致，不能混入这条费用样本。".to_string(),
            ));
        }
        if catalog
            .cost_calibrations
            .iter()
            .any(|item| item.probe_id.as_deref() == Some(probe_id))
        {
            return Err(SwitcherError::Message(
                "同一条固定测试已经保存过费用样本，不能重复计入排名。".to_string(),
            ));
        }
    }
    let record = CostCalibration {
        id: format!("cost-calibration-{}", Local::now().timestamp_millis()),
        provider_id: input.provider_id,
        provider_name: input.provider_name,
        funding_mode: input.funding_mode,
        paid_cny: input.paid_cny,
        consumable_credit: input.consumable_credit,
        debit_credit: input.debit_credit,
        debit_confirmed: input.debit_confirmed,
        credit_unit_label: input.credit_unit_label,
        model: input.model,
        probe_version: input.probe_version,
        cost_source: if input.cost_source.trim().is_empty() {
            "billing_log_manual".to_string()
        } else {
            input.cost_source
        },
        probe_id: input.probe_id,
        sample_kind: if input.sample_kind.trim().is_empty() {
            default_sample_kind()
        } else {
            input.sample_kind
        },
        official_cny,
        result_cny: result_cny.clone(),
        state: "completed".to_string(),
        created_at: now.clone(),
        updated_at: now,
        note: None,
    };
    let provider_name = record.provider_name.clone();
    // lgtm [rust/cleartext-logging] This updates the catalog; save_catalog
    // persists credentials through the protected storage path, not a log.
    catalog.cost_calibrations.insert(0, record);
    catalog.cost_calibrations.truncate(100);
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        "费用校准已保存",
        &format!("{provider_name} 的固定探针人民币成本为 ¥{result_cny}。"),
        "success",
    )
}

#[tauri::command]
fn delete_cost_calibration(calibration_id: String) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    delete_cost_calibration_core(calibration_id)
}

pub fn delete_cost_calibration_core(calibration_id: String) -> Result<AppState, SwitcherError> {
    if calibration_id.trim().is_empty() {
        return Err(SwitcherError::Message("缺少费用记录标识。".to_string()));
    }
    let mut catalog = load_catalog()?;
    let before = catalog.cost_calibrations.len();
    catalog
        .cost_calibrations
        .retain(|item| item.id != calibration_id);
    if catalog.cost_calibrations.len() == before {
        return Err(SwitcherError::Message("未找到这条费用记录。".to_string()));
    }
    save_catalog(&mut catalog)?;
    app_state_with_activity("已删除费用记录", "已删除一条基准测试费用记录。", "info")
}

fn bundled_model_entries() -> Result<Vec<Value>, SwitcherError> {
    commands::bundled_model_catalog()?
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("Codex 内置模型目录格式无效。".into()))
}

fn apply_default_codex_model_selection(
    model_catalog: &mut ModelCatalog,
    current_model: &str,
    bundled: &[Value],
) {
    let built_in_ids = bundled
        .iter()
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .collect::<BTreeSet<_>>();
    for model in &mut model_catalog.models {
        if model.codex_enabled.is_none() {
            let id = model.id.to_ascii_lowercase();
            let clearly_non_chat = [
                "embedding",
                "embed",
                "rerank",
                "moderation",
                "whisper",
                "transcribe",
                "tts",
                "text-to-speech",
                "speech-to-text",
            ]
            .iter()
            .any(|marker| id.contains(marker))
                || model
                    .tags
                    .iter()
                    .any(|tag| tag == "embedding" || tag == "audio");
            let enabled = model.id.eq_ignore_ascii_case(current_model)
                || built_in_ids.contains(&id)
                || !clearly_non_chat;
            model.codex_enabled = Some(enabled);
        }
    }
}

fn custom_codex_model_entry(template: &Value, model_id: &str, provider_name: &str) -> Value {
    let mut entry = template.clone();
    entry["slug"] = Value::String(model_id.to_string());
    entry["display_name"] = Value::String(model_id.to_string());
    entry["description"] = Value::String(format!(
        "{} · 第三方 Responses 模型，实际能力以服务商支持为准。",
        provider_name
    ));
    if let Some(object) = entry.as_object_mut() {
        object.remove("model_messages");
        object.remove("comp_hash");
    }
    entry
}

fn build_codex_model_catalog(
    catalog: &ModelCatalog,
    profile: &StoredProfile,
    bundled: &[Value],
) -> Result<Vec<u8>, SwitcherError> {
    if catalog.status != "ok" && catalog.status != "stale" {
        return Err(SwitcherError::Message(
            "当前服务商模型目录不可用，尚不能生成 Codex 列表。请先刷新目录。".into(),
        ));
    }
    let bundled_by_id = bundled
        .iter()
        .filter_map(|model| {
            model
                .get("slug")
                .and_then(Value::as_str)
                .map(|id| (id.to_ascii_lowercase(), model.clone()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let template = bundled
        .first()
        .cloned()
        .ok_or_else(|| SwitcherError::Message("Codex 没有提供可用的模型目录模板。".into()))?;
    let mut selected = Vec::<Value>::new();
    let mut seen = BTreeSet::new();
    for model in catalog.models.iter().filter(|model| {
        model.codex_enabled.unwrap_or(false) || model.id.eq_ignore_ascii_case(&profile.model)
    }) {
        let id = model.id.trim();
        if id.is_empty() || id.contains(['\n', '\r']) {
            return Err(SwitcherError::Message(
                "模型标识为空或包含换行符，无法加入 Codex。".into(),
            ));
        }
        if !seen.insert(id.to_ascii_lowercase()) {
            continue;
        }
        let entry = if let Some(bundled) = bundled_by_id.get(&id.to_ascii_lowercase()) {
            bundled.clone()
        } else {
            // The CLI owns this undocumented JSON schema. Reuse its current
            // entry shape, but never copy vendor-specific instruction text to
            // a different provider model.
            custom_codex_model_entry(&template, id, &profile.name)
        };
        selected.push(entry);
    }
    let current_model = profile.model.trim();
    if !current_model.is_empty() && !seen.contains(&current_model.to_ascii_lowercase()) {
        if current_model.contains(['\n', '\r']) {
            return Err(SwitcherError::Message(
                "默认模型标识包含换行符，无法加入 Codex。".into(),
            ));
        }
        selected.push(
            if let Some(entry) = bundled_by_id.get(&current_model.to_ascii_lowercase()) {
                entry.clone()
            } else {
                custom_codex_model_entry(&template, current_model, &profile.name)
            },
        );
    }
    if selected.is_empty() {
        return Err(SwitcherError::Message(
            "至少需要保留一个已加入 Codex 的模型。".into(),
        ));
    }
    Ok(serde_json::to_vec(&json!({"models": selected}))?)
}

fn codex_model_catalog_bytes(
    profile_id: &str,
    profile: &StoredProfile,
) -> Result<Vec<u8>, SwitcherError> {
    let bundled = bundled_model_entries()?;
    let stored = load_catalog()?;
    let catalog_value = stored
        .model_catalogs
        .get(profile_id)
        .cloned();
    let catalog: ModelCatalog = if let Some(value) = catalog_value {
        serde_json::from_value(value)?
    } else {
        // 已保存连接升级时可从默认模型重建目录，不联网获取新模型。
        providers::build_model_catalog(profile_id, profile, "stale", "使用已保存的默认模型重建目录；尚未刷新服务商列表。", Vec::new(), now_label())
    };
    build_codex_model_catalog(&catalog, profile, &bundled)
}

fn prepare_saved_profile_config(original: &str, profile_id: &str, profile: &StoredProfile) -> Result<String, SwitcherError> {
    let next = build_next_config(original, profile_id, profile)?;
    let bytes = codex_model_catalog_bytes(profile_id, profile)?;
    let path = match matching_owned_model_catalog(original, &app_data_dir()?.join("model-catalogs"), &bytes)? {
        Some(path) => path,
        None => write_codex_model_catalog(&bytes)?,
    };
    let mut lines = next.lines().map(str::to_string).collect::<Vec<_>>();
    upsert_root_string(&mut lines, "model_catalog_json", &path.display().to_string());
    Ok(lines.join("\r\n"))
}

fn matching_owned_model_catalog(original: &str, directory: &Path, expected: &[u8]) -> Result<Option<PathBuf>, SwitcherError> {
    let config = toml::from_str::<toml::Value>(original)?;
    let Some(path) = config.get("model_catalog_json").and_then(toml::Value::as_str).map(PathBuf::from) else { return Ok(None) };
    if path.parent() == Some(directory) && path.extension().and_then(|ext| ext.to_str()) == Some("json")
        && fs::read(&path).is_ok_and(|bytes| bytes == expected) {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

fn build_profile_config(
    original: &str,
    profile_id: &str,
    profile: &StoredProfile,
) -> Result<String, SwitcherError> {
    let mut lines = build_next_config(original, profile_id, profile)?
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let catalog_path = write_codex_model_catalog(&codex_model_catalog_bytes(profile_id, profile)?)?;
    upsert_root_string(
        &mut lines,
        "model_catalog_json",
        &catalog_path.display().to_string(),
    );
    let next = lines.join("\r\n");
    if !protected_sections_match(original, &next)?
        || !only_provider_owned_configuration_changed(original, &next)?
    {
        return Err(SwitcherError::Message(
            "加入模型目录时检测到受保护设置发生变化，已拒绝写入。".into(),
        ));
    }
    Ok(next)
}

fn set_active_model_catalog_path(
    profile_id: &str,
    profile: &StoredProfile,
) -> Result<(), SwitcherError> {
    let config = config_path()?;
    let original = read_config()?;
    let auth = read_auth()?;
    let mut lines = original
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let catalog_path = write_codex_model_catalog(&codex_model_catalog_bytes(profile_id, profile)?)?;
    upsert_root_string(
        &mut lines,
        "model_catalog_json",
        &catalog_path.display().to_string(),
    );
    let next = lines.join("\r\n");
    if next == original {
        return Ok(());
    }
    ensure_configuration_layer_is_unambiguous()?;
    if !protected_sections_match(&original, &next)?
        || !only_provider_owned_configuration_changed(&original, &next)?
    {
        return Err(SwitcherError::Message(
            "模型目录更新会影响受保护设置，已停止。".into(),
        ));
    }
    healthy_baseline_backup()?;
    let backup = create_backup()?;
    let backup_id = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SwitcherError::Message("恢复点标识无效。".into()))?;
    let before_fingerprint = owned_configuration_fingerprint(&original, &auth)?;
    begin_config_transaction(backup_id, "model_catalog", &before_fingerprint)?;
    if let Err(error) = write_bytes_atomically(&config, next.as_bytes()) {
        let _ = complete_config_transaction();
        return Err(error);
    }
    update_config_transaction_phase("config_replaced")?;
    let written = fs::read_to_string(&config)?;
    let written_auth = read_auth()?;
    if written != next
        || written_auth != auth
        || protected_configuration_fingerprint(&written, &written_auth)?
            != protected_configuration_fingerprint(&original, &auth)?
    {
        rollback_config_transaction(&config, &original)?;
        return Err(SwitcherError::Message(
            "模型目录更新未通过回读校验，已恢复原配置。".into(),
        ));
    }
    let after_fingerprint = owned_configuration_fingerprint(&written, &written_auth)?;
    record_backup_post_change(&backup, &after_fingerprint)?;
    record_operation_receipt(ConfigOperationReceipt {
        id: unique_backup_label("model-catalog-receipt"),
        backup_id: backup_id.to_string(),
        kind: "model_catalog".to_string(),
        created_at: now_label(),
        fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
        before_fingerprint,
        after_fingerprint,
    })?;
    update_config_transaction_phase("verified")?;
    complete_config_transaction()
}

pub fn save_codex_model_selection_core(
    profile_id: String,
    model_id: String,
    enabled: bool,
) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let profile_value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".into()))?;
    let profile: StoredProfile = serde_json::from_value(profile_value)?;
    let catalog_value = catalog
        .model_catalogs
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("请先刷新当前服务商的模型目录。".into()))?;
    let mut model_catalog: ModelCatalog = serde_json::from_value(catalog_value)?;
    let model = model_catalog
        .models
        .iter_mut()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            SwitcherError::Message("这个模型已不在最新目录中，请先刷新后再操作。".into())
        })?;
    if !enabled && profile.model.eq_ignore_ascii_case(&model_id) {
        return Err(SwitcherError::Message(
            "当前默认模型必须留在 Codex 列表中；先更换默认模型，再取消加入。".into(),
        ));
    }
    let previous = model.codex_enabled;
    model.codex_enabled = Some(enabled);
    catalog
        .model_catalogs
        .insert(profile_id.clone(), serde_json::to_value(&model_catalog)?);
    save_catalog(&mut catalog)?;
    let config = read_config()?;
    if current_profile_id(&catalog, &config) == profile_id {
        if let Err(error) = set_active_model_catalog_path(&profile_id, &profile) {
            let mut rollback = load_catalog()?;
            if let Some(value) = rollback.model_catalogs.get(&profile_id).cloned() {
                if let Ok(mut prior) = serde_json::from_value::<ModelCatalog>(value) {
                    if let Some(model) = prior.models.iter_mut().find(|model| model.id == model_id)
                    {
                        model.codex_enabled = previous;
                    }
                    rollback
                        .model_catalogs
                        .insert(profile_id.clone(), serde_json::to_value(prior)?);
                    let _ = save_catalog(&mut rollback);
                }
            }
            return Err(error);
        }
    }
    app_state_with_activity(
        if enabled {
            "模型已加入 Codex"
        } else {
            "模型已从 Codex 列表移除"
        },
        if current_profile_id(&catalog, &config) == profile_id {
            "模型目录已保存并写入当前 Codex 配置；重新打开 Codex 后可在模型选择中查看。"
        } else {
            "选择已保存在该服务商资料；切换到它时会一并写入 Codex 模型列表。"
        },
        "success",
    )
}

#[tauri::command]
fn save_codex_model_selection(
    profile_id: String,
    model_id: String,
    enabled: bool,
) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    save_codex_model_selection_core(profile_id, model_id, enabled)
}

pub fn preview_models_core(profile: EditableProfile) -> Result<ModelCatalog, SwitcherError> {
    let base_url = profile.base_url.trim();
    provider_probe_endpoint(base_url, "models").map_err(SwitcherError::Message)?;

    let draft_profile = StoredProfile {
        connection_kind: None,
        name: profile.name.trim().to_string(),
        base_url: base_url.to_string(),
        endpoint_mode: if profile.endpoint_mode == "full" { "full".to_string() } else { default_endpoint_mode() },
        api_key: profile.api_key.trim().to_string(),
        api_key_protected: String::new(),
        model: profile.model.trim().to_string(),
        auth_mode: preferred_auth_mode(&profile.name, base_url),
        model_reasoning_effort: default_reasoning(),
        verified: false,
        verification_status: default_verification_status(),
        verification_response_shape: None,
        capability_profile: None,
        default: false,
        note: String::new(),
        last_switched_at: None,
        last_verified_at: None,
        last_verification_detail: None,
        last_verification_stage: None,
        last_verification_http_status: None,
        last_verification_provider_code: None,
    };
    let preview_id = if profile.id.trim().is_empty() {
        "draft-provider"
    } else {
        profile.id.trim()
    };
    let mut result = fetch_provider_models(preview_id, &draft_profile)?;
    let bundled = bundled_model_entries().unwrap_or_default();
    apply_default_codex_model_selection(&mut result, &draft_profile.model, &bundled);
    result.provider_id = preview_id.to_string();
    result.status_detail = if result.status == "ok" {
        format!("{} 保存后才会写入本机服务商目录。", result.status_detail)
    } else {
        result.status_detail
    };
    // Deliberately do not persist the draft or its key. This endpoint exists
    // solely to populate the in-form model picker before a save.
    Ok(result)
}

pub fn refresh_models_core(profile_id: String) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let profile: StoredProfile = serde_json::from_value(value)?;
    let previous_catalog = catalog.model_catalogs.get(&profile_id).cloned();
    if is_isolated_development_fixture(&profile) {
        if let Some(value) = previous_catalog {
            let mut model_catalog: ModelCatalog = serde_json::from_value(value)?;
            model_catalog.fetched_at = Some(now_label());
            model_catalog.last_successful_at = model_catalog.fetched_at.clone();
            model_catalog.status = "ok".to_string();
            model_catalog.status_detail = "模型目录已刷新。".to_string();
            model_catalog.http_status = Some(200);
            let bundled = bundled_model_entries().unwrap_or_default();
            apply_default_codex_model_selection(&mut model_catalog, &profile.model, &bundled);
            let diagnostics = model_catalog_activity_diagnostics(&model_catalog);
            catalog
                .model_catalogs
                .insert(profile_id, serde_json::to_value(&model_catalog)?);
            save_catalog(&mut catalog)?;
            return app_state_with_activity_diagnostics(
                "模型目录已刷新",
                &model_catalog.status_detail,
                "success",
                "provider.model_catalog.refresh",
                "success",
                "可以在模型列表中选择模型；如目录与服务商后台不一致，可根据请求编号向服务商查询。",
                Some(&profile.name),
                Some(&profile.model),
                diagnostics,
            );
        }
    }
    let mut model_catalog = fetch_provider_models(&profile_id, &profile)?;
    if model_catalog.status == "ok" && model_catalog.base_url.trim() != profile.base_url.trim() {
        let mut resolved_profile = profile.clone();
        resolved_profile.base_url = model_catalog.base_url.clone();
        catalog.profiles.insert(profile_id.clone(), serde_json::to_value(resolved_profile)?);
    }
    preserve_previous_model_catalog(previous_catalog.as_ref(), &mut model_catalog);
    preserve_catalog_model_verifications(previous_catalog.as_ref(), &mut model_catalog);
    let bundled = bundled_model_entries().unwrap_or_default();
    apply_default_codex_model_selection(&mut model_catalog, &profile.model, &bundled);
    let ok = model_catalog.status == "ok";
    let detail = model_catalog.status_detail.clone();
    let diagnostics = model_catalog_activity_diagnostics(&model_catalog);
    catalog
        .model_catalogs
        .insert(profile_id.clone(), serde_json::to_value(&model_catalog)?);
    save_catalog(&mut catalog)?;
    app_state_with_activity_diagnostics(
        if ok {
            "模型目录已刷新"
        } else {
            "模型目录刷新失败"
        },
        &detail,
        if ok { "success" } else { "warning" },
        "provider.model_catalog.refresh",
        if ok { "success" } else { "warning" },
        if ok {
            "可以在模型列表中选择模型；如目录与服务商后台不一致，可根据请求编号向服务商查询。"
        } else {
            "请展开诊断详情，先核对 HTTP 状态、错误代码、认证和服务商限流信息后再重试。"
        },
        Some(&profile.name),
        Some(&profile.model),
        diagnostics,
    )
}

#[tauri::command]
fn set_default_profile(profile_id: String) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    set_default_profile_core(profile_id)
}

pub fn set_default_profile_core(profile_id: String) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let target = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let display_name = serde_json::from_value::<StoredProfile>(target)?.name;
    for (id, value) in catalog.profiles.clone() {
        let mut profile: StoredProfile = serde_json::from_value(value)?;
        profile.default = id == profile_id;
        catalog.profiles.insert(id, serde_json::to_value(profile)?);
    }
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已设为默认"),
        "默认标记仅影响切换目录排序和保护策略，不会立即改写 Codex 当前服务商。",
        "info",
    )
}

#[tauri::command]
fn sync_current_configuration() -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    sync_current_configuration_core()
}

pub fn sync_current_configuration_core() -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let config = read_config()?;
    let profile_id = current_profile_id(&catalog, &config);
    if profile_id == "unknown" {
        return Err(SwitcherError::Message(
            "当前 Codex 服务商未能与切换器目录唯一匹配，无法安全同步。请先检查服务商名称和接口地址。".to_string(),
        ));
    }
    let current_model = current_config_model(&config)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SwitcherError::Message("当前 Codex 配置缺少模型名称，无法安全同步。".to_string())
        })?;
    let value =
        catalog.profiles.get(&profile_id).cloned().ok_or_else(|| {
            SwitcherError::Message("当前服务商未在切换器目录中找到。".to_string())
        })?;
    let mut profile: StoredProfile = serde_json::from_value(value)?;
    if profile.model == current_model {
        return app_state_with_activity(
            "当前配置已一致",
            "切换器目录与 Codex 当前模型一致，未写入任何配置文件。",
            "info",
        );
    }
    let previous_model = profile.model.clone();
    profile.model = current_model.clone();
    reset_profile_verification(
        &mut profile,
        "Codex 当前模型已同步到本地目录；模型变化后需要重新运行服务商可用性测试。",
    );
    invalidate_catalog_model_verifications(&mut catalog, &profile_id);
    let display_name = profile.name.clone();
    catalog
        .profiles
        .insert(profile_id, serde_json::to_value(profile)?);
    save_catalog(&mut catalog)?;
    app_state_with_activity(
        "已同步当前 Codex 配置",
        &format!("{display_name} 的目录模型已从 {previous_model} 同步为 {current_model}；旧测试结果已失效，未写入 Codex 配置或凭据。"),
        "success",
    )
}

#[tauri::command]
fn toggle_auto_start(app: tauri::AppHandle, enabled: bool) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    if is_development_release_channel() {
        return Err(SwitcherError::Message(
            "开发版不修改 Windows 开机启动；请在正式版设置。".into(),
        ));
    }
    if enabled {
        app.autolaunch().enable().map_err(|error| {
            SwitcherError::Message(format!("无法开启 Windows 开机启动：{error}"))
        })?;
    } else {
        app.autolaunch().disable().map_err(|error| {
            SwitcherError::Message(format!("无法关闭 Windows 开机启动：{error}"))
        })?;
    }
    let mut state = app_state_with_activity(
        if enabled {
            "已开启开机启动"
        } else {
            "已关闭开机启动"
        },
        if enabled {
            "下次登录 Windows 时会自动打开 Signalman AI。"
        } else {
            "下次登录 Windows 时不会自动打开 Signalman AI。"
        },
        "success",
    )?;
    state.auto_start = app.autolaunch().is_enabled().map_err(|error| {
        SwitcherError::Message(format!("无法确认 Windows 开机启动状态：{error}"))
    })?;
    if state.auto_start != enabled {
        return Err(SwitcherError::Message(
            "Windows 未确认开机启动状态变更；已停止继续操作。".to_string(),
        ));
    }
    Ok(state)
}

pub fn toggle_auto_start_core(_enabled: bool) -> Result<AppState, SwitcherError> {
    Err(SwitcherError::Message(
        "开机启动只在 Signalman AI 桌面应用中提供；本地 Web 诊断模式不会写入 Windows 启动项。"
            .to_string(),
    ))
}

#[tauri::command]
fn restore_latest_backup(confirmation: String) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    restore_latest_backup_core(confirmation)
}

pub fn restore_latest_backup_core(confirmation: String) -> Result<AppState, SwitcherError> {
    let backups = list_backups()?;
    let latest = backups
        .first()
        .filter(|backup| backup.restore_ready)
        .or_else(|| backups.iter().find(|backup| backup.restore_ready))
        .ok_or_else(|| SwitcherError::Message("当前没有可恢复的备份。".to_string()))?;
    restore_backup_core(latest.label.clone(), confirmation)
}

fn restore_stage<T>(stage: &str, result: Result<T, SwitcherError>) -> Result<T, SwitcherError> {
    result.map_err(|error| SwitcherError::Message(format!("恢复在{stage}阶段失败：{error}")))
}

#[tauri::command]
fn restore_backup(backup_id: String, confirmation: String) -> Result<AppState, SwitcherError> {
    let _scope = qa::operation_scope()?;
    restore_backup_core(backup_id, confirmation)
}

pub fn restore_backup_core(
    backup_id: String,
    confirmation: String,
) -> Result<AppState, SwitcherError> {
    if confirmation.trim() != "恢复" && confirmation.trim() != "恢复全部配置" {
        return Err(SwitcherError::Message(
            "请按恢复窗口的提示输入“恢复”或“恢复全部配置”。".to_string(),
        ));
    }
    let (backup_dir, manifest) = restore_stage("读取恢复点", read_backup_manifest(&backup_id))?;
    let config = restore_stage("定位设置文件", config_path())?;
    let current_bytes = restore_stage(
        "读取当前设置",
        match fs::read(&config) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        },
    )?;
    let current_config = current_bytes
        .as_ref()
        .and_then(|bytes| String::from_utf8(bytes.clone()).ok());
    let current_is_parseable = current_config
        .as_deref()
        .is_some_and(|value| toml::from_str::<toml::Value>(value).is_ok());
    if !current_is_parseable || confirmation.trim() == "恢复全部配置" {
        if confirmation.trim() != "恢复全部配置" {
            return Err(SwitcherError::Message(
                "当前 config.toml 不存在或已无法解析。普通安全恢复无法判断哪些其他设置应保留；如确认用所选恢复点完整替换 config.toml，请重新输入“恢复全部配置”。auth.json 不会被回滚。".to_string(),
            ));
        }
        restore_stage(
            "完整恢复损坏设置",
            recover_damaged_config(
                &config,
                &app_data_dir()?.join("recovery-evidence"),
                &backup_dir,
                &manifest,
                &confirmation,
            ),
        )?;
        restore_stage("清理中断事务标记", complete_config_transaction())?;
        let preservation_detail = if current_bytes.is_some() {
            "原 config.toml 已加密留档"
        } else {
            "原 config.toml 不存在，恢复点已生成新文件"
        };
        return app_state_with_activity(
            "已完整救回 Codex 设置",
            &format!("已从 {backup_id} 完整替换 config.toml，并确认新文件可解析。{preservation_detail}；MCP、插件、项目等设置会回到这个恢复点的状态，当前 auth.json 保持不变。"),
            "success",
        );
    }
    restore_stage("核对当前配置", current_state_is_safe_to_restore(&manifest))?;
    let auth = restore_stage("定位认证文件", auth_path())?;
    let (next_config, next_auth) =
        restore_stage("合并受管字段", restored_owned_files(&backup_dir, &manifest))?;
    let previous_config = restore_stage("保存回滚快照", capture_file(&config))?;
    let rollback_label = unique_backup_label("before-restore");
    let rollback_dir = restore_stage(
        "创建恢复前保护点",
        create_backup_with_label(&rollback_label, "before_restore"),
    )?;
    let rollback_id = rollback_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SwitcherError::Message("恢复点标识无效。".to_string()))?;
    let before_fingerprint = restore_stage("核对恢复前指纹", current_owned_fingerprint())?;
    restore_stage(
        "建立原子写入回执",
        begin_config_transaction(rollback_id, "restore", &before_fingerprint),
    )?;
    if let Err(error) = write_recovery_target(&config, next_config.as_bytes()) {
        complete_config_transaction()?;
        return Err(error);
    }
    restore_stage(
        "记录设置写入",
        update_config_transaction_phase("config_replaced"),
    )?;
    if let Some(next_auth) = next_auth {
        if let Err(error) = write_recovery_target(&auth, next_auth.as_bytes()) {
            let config_rollback = restore_file_snapshot(&config, &previous_config);
            if config_rollback.is_err() {
                return Err(SwitcherError::Message(
                    "恢复失败且自动恢复未完成；请立即使用恢复中心中的最新恢复点。".to_string(),
                ));
            }
            complete_config_transaction()?;
            return Err(error);
        }
        restore_stage(
            "记录认证写入",
            update_config_transaction_phase("auth_replaced"),
        )?;
    }
    let current_auth = restore_stage("复核认证文件", read_auth())?;
    let restored_fingerprint = restore_stage(
        "核对恢复后指纹",
        owned_configuration_fingerprint(&next_config, &current_auth),
    )?;
    restore_stage(
        "固化恢复前保护点",
        record_backup_post_change(&rollback_dir, &restored_fingerprint),
    )?;
    restore_stage(
        "记录恢复回执",
        record_operation_receipt(ConfigOperationReceipt {
            id: unique_backup_label("restore-receipt"),
            backup_id: backup_id.clone(),
            kind: "restore".to_string(),
            created_at: now_label(),
            fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
            before_fingerprint,
            after_fingerprint: restored_fingerprint,
        }),
    )?;
    restore_stage("记录恢复验证", update_config_transaction_phase("verified"))?;
    restore_stage("完成原子写入", complete_config_transaction())?;

    app_state_with_activity(
        if manifest.reason == "initial_install" {
            "已恢复首次启动基线备份"
        } else {
            "已恢复配置备份"
        },
        &format!("已从 {backup_id} 回退服务商字段；MCP、插件、项目设置和其他后续内容没有被覆盖。"),
        "success",
    )
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());
    let builder = if is_store_release_channel() {
        builder
    } else {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    };
    builder
        .setup(|app| {
            qa::initialize_live()?;
            install_system_tray(app)?;
            if let Err(error) = protocol_gateway::ensure_active_profile_running() {
                eprintln!("Active provider gateway did not start: {error}");
            }
            if let Some(title) = development_window_title() {
                if let Some(window) = app.get_webview_window("main") {
                    // Keep the development candidate distinguishable in the
                    // Windows taskbar as well as in the notification area.
                    let development_icon = Image::from_bytes(include_bytes!("../icons/dev-tray.png"))?;
                    window.set_icon(development_icon)?;
                    // The development shell adds an external QA rail beside
                    // the complete product canvas. Keep it above the width
                    // where the product would otherwise be clipped.
                    window.set_min_size(Some(tauri::LogicalSize::new(1500.0, 700.0)))?;
                    window.set_size(tauri::LogicalSize::new(1540.0, 860.0))?;
                    window.set_title(&title)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            commands::check_for_update,
            save_profile,
            delete_profile,
            reorder_profiles,
            reveal_profile_api_key,
            prepare_connection_environment,
            complete_onboarding,
            update_transport_options,
            commands::prepare_switch,
            switch_profile,
            commands::verify_profile,
            commands::run_response_probe,
            save_cost_calibration,
            delete_cost_calibration,
            commands::refresh_models,
            commands::preview_models,
            save_codex_model_selection,
            commands::begin_chatgpt_login,
            commands::get_chatgpt_login_status,
            commands::activate_official_provider,
            commands::qa_open_codex_target,
            qa::cancel_chatgpt_login,
            set_default_profile,
            sync_current_configuration,
            toggle_auto_start,
            create_manual_backup,
            set_backup_policy,
            restore_latest_backup,
            restore_backup,
            qa_reset_scenario,
            qa_live_validation_status,
            qa_create_live_validation_snapshot,
            qa_import_live_validation_snapshot,
            qa_clear_live_validation_copy,
            qa_open_live_validation_window,
            qa::qa_leave_live_validation,
            qa::qa_check_summary,
            qa::qa_clear_snapshots,
            minimize_to_tray,
            quit_application
        ])
        .build(tauri::generate_context!())
        .expect("error while building Signalman AI")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                qa::stop_login_on_exit();
                protocol_gateway::stop_owned_gateway();
            }
        });
}

fn install_system_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let development = development_window_title().is_some();
    let show_label = if development {
        "显示开发版"
    } else {
        "显示窗口"
    };
    let minimize_label = if development {
        "最小化开发版"
    } else {
        "最小化"
    };
    let quit_label = if development {
        "退出开发版"
    } else {
        "退出"
    };
    let tooltip = if development {
        "Signalman AI · 开发版"
    } else {
        "Signalman AI"
    };
    let status_label = if development {
        "开发版 · 可在后台运行"
    } else {
        "可在后台运行"
    };
    let status = MenuItem::with_id(app, "status", status_label, false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let minimize = MenuItem::with_id(app, "minimize", minimize_label, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &show, &minimize, &separator, &quit])?;
    let icon = if development {
        Image::from_bytes(include_bytes!("../icons/dev-tray.png"))?
    } else {
        app.default_window_icon()
            .cloned()
            .ok_or("应用缺少系统托盘图标")?
    };
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip(tooltip)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "minimize" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.minimize();
                }
            }
            "quit" => {
                qa::stop_login_on_exit();
                protocol_gateway::stop_owned_gateway();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(tray);
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = app_handle.emit("signalman-close-requested", ());
            }
        });
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("signalman-window-visibility", true);
    }
}

#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口尚未准备好。".to_string())?;
    window.hide().map_err(|error| error.to_string())?;
    app.emit("signalman-window-visibility", false)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_application(app: tauri::AppHandle) -> Result<(), String> {
    qa::stop_login_on_exit();
    protocol_gateway::stop_owned_gateway();
    app.exit(0);
    Ok(())
}

pub fn run_protocol_gateway() -> Result<(), String> {
    protocol_gateway::run()
}

#[cfg(test)]
mod legacy_profile_import_tests {
    use super::*;

    fn profile(name: &str, base_url: &str, api_key: &str, api_key_protected: &str) -> Value {
        json!({
            "name": name,
            "base_url": base_url,
            "api_key": api_key,
            "api_key_protected": api_key_protected,
            "model": "gpt-test",
            "default": false,
            "note": "test fixture"
        })
    }

    fn catalog_with(profile_id: &str, profile_value: Value) -> StoredCatalog {
        let mut profiles = Map::new();
        profiles.insert(profile_id.to_string(), profile_value);
        StoredCatalog {
            version: default_version(),
            catalog_revision: 0,
            profiles,
            model_catalogs: Map::new(),
            cost_calibrations: Vec::new(),
            response_probes: Vec::new(),
            profile_order: vec![profile_id.to_string()],
            auto_start: false,
            backup_policy: default_backup_policy(),
            invariants: default_invariants(),
        }
    }

    #[test]
    fn legacy_command_auth_is_migrated_to_bearer_for_non_modelflare_profiles() {
        let mut value = profile("OWL", "https://owl.example/v1", "owl-key", "");
        value
            .as_object_mut()
            .expect("profile fixture object")
            .insert(
                "auth_mode".to_string(),
                Value::String("provider_command".to_string()),
            );
        let mut catalog = catalog_with("owl", value);

        assert!(hydrate_catalog_secrets(&mut catalog).unwrap());
        let migrated: StoredProfile =
            serde_json::from_value(catalog.profiles.get("owl").cloned().unwrap()).unwrap();
        assert_eq!(migrated.auth_mode, default_auth_mode());
        assert!(!uses_provider_command_auth(&migrated));
    }

    #[test]
    fn legacy_modelflare_profile_keeps_command_auth_adapter() {
        let mut value = profile(
            "Custom label",
            "https://modelflare.dev/v1",
            "model-flare-key",
            "",
        );
        value
            .as_object_mut()
            .expect("profile fixture object")
            .insert("auth_mode".to_string(), Value::String(default_auth_mode()));
        let mut catalog = catalog_with("modelflare", value);

        assert!(hydrate_catalog_secrets(&mut catalog).unwrap());
        let migrated: StoredProfile =
            serde_json::from_value(catalog.profiles.get("modelflare").cloned().unwrap()).unwrap();
        assert_eq!(migrated.auth_mode, "provider_command");
        assert!(uses_provider_command_auth(&migrated));
    }

    fn calibration_input(
        paid_cny: &str,
        consumable_credit: &str,
        debit_credit: &str,
    ) -> CostCalibrationInput {
        CostCalibrationInput {
            provider_id: "test".to_string(),
            provider_name: "Test".to_string(),
            funding_mode: "prepaid".to_string(),
            paid_cny: paid_cny.to_string(),
            consumable_credit: consumable_credit.to_string(),
            debit_credit: debit_credit.to_string(),
            debit_confirmed: true,
            credit_unit_label: "credit".to_string(),
            model: "gpt-test".to_string(),
            probe_version: "cost-calibration-v1".to_string(),
            cost_source: "billing_log_manual".to_string(),
            probe_id: None,
            sample_kind: "cold".to_string(),
            official_cny: None,
        }
    }

    #[test]
    fn calibrated_cost_uses_exact_decimal_math() {
        let input = calibration_input("10", "1000", "0.000524");
        assert_eq!(calculate_calibrated_cost(&input).unwrap(), "0.00000524");
    }

    #[test]
    fn calibrated_cost_rejects_invalid_or_zero_decimal_inputs() {
        assert!(calculate_calibrated_cost(&calibration_input("0", "100", "1")).is_err());
        assert!(calculate_calibrated_cost(&calibration_input("1", "abc", "1")).is_err());
        assert!(
            calculate_calibrated_cost(&calibration_input("1.0000000000001", "1", "1")).is_err()
        );
    }

    #[test]
    fn probe_usage_retains_cache_and_reasoning_breakdown() {
        let body = json!({
            "usage": {
                "input_tokens": 1200,
                "output_tokens": 18,
                "total_tokens": 1218,
                "input_tokens_details": { "cached_tokens": 1024, "cache_write_tokens": 0 },
                "output_tokens_details": { "reasoning_tokens": 7 }
            }
        });
        let usage = probe_usage(&body).expect("usage should be detected");
        assert_eq!(usage.cached_tokens, Some(1024));
        assert_eq!(usage.cache_write_tokens, Some(0));
        assert_eq!(usage.reasoning_tokens, Some(7));
    }

    #[test]
    fn response_cost_candidate_accepts_usage_cost_extension() {
        let body = json!({ "usage": { "cost": 0.000524 } });
        assert_eq!(
            response_cost_candidate(&body),
            Some(("0.000524".to_string(), "response_usage".to_string()))
        );
    }

    fn legacy_document(entries: Value) -> String {
        json!({ "profiles": entries }).to_string()
    }

    #[test]
    fn legacy_import_fills_an_empty_matching_profile() {
        let mut catalog =
            catalog_with("owl", profile("OWL", "https://api.example.test/v1", "", ""));
        let document = legacy_document(json!({
            "owl": {
                "name": "OWL",
                "base_url": "https://api.example.test/v1",
                "api_key": "legacy-test-key",
                "model": "gpt-test"
            }
        }));

        assert_eq!(
            merge_legacy_profile_document(&mut catalog, &document).unwrap(),
            1
        );
        let restored: StoredProfile =
            serde_json::from_value(catalog.profiles["owl"].clone()).unwrap();
        assert_eq!(restored.api_key, "legacy-test-key");
        assert!(restored.api_key_protected.is_empty());
    }

    #[test]
    fn new_install_catalog_has_no_preconfigured_provider() {
        let catalog = seed_catalog_from_existing().unwrap();
        assert!(catalog.profiles.is_empty());
    }

    #[test]
    fn provider_ids_are_non_empty_and_unique_for_unicode_names() {
        assert!(!provider_id_base("中转服务").is_empty());
        assert!(provider_id_base("中转服务").starts_with("provider-"));

        let mut catalog = seed_catalog_from_existing().unwrap();
        let first = unique_profile_id(&catalog, "服务商 A");
        catalog.profiles.insert(first.clone(), json!({}));
        let second = unique_profile_id(&catalog, "另一个 A");
        assert_ne!(first, second);
        assert!(!second.is_empty());
        assert_eq!(
            profile_id_for_save(&catalog, &first, "已改名的中文服务商"),
            first
        );
        assert_eq!(profile_id_for_save(&catalog, "", "服务商 A"), second);
    }

    #[test]
    fn empty_initial_backup_is_audit_only_and_not_restorable() {
        let manifest = BackupManifest {
            schema_version: 4,
            fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
            created_at: "2026-08-20 00:00:00".to_string(),
            reason: "initial_install".to_string(),
            files: Vec::new(),
            missing_files: vec!["config.toml".to_string(), "auth.json".to_string()],
            post_change_fingerprint: None,
            snapshot_fingerprint: None,
            protected_fingerprint: None,
            file_digests: BTreeMap::new(),
            retention_managed: true,
        };
        assert!(is_empty_initial_backup(&manifest));
    }

    #[test]
    fn codex_home_prefers_isolated_fixture_then_official_override_then_default() {
        let default_home = PathBuf::from("C:/Users/tester");
        assert_eq!(
            resolve_codex_home(
                Some(PathBuf::from("D:/fixture/.codex")),
                Some(PathBuf::from("D:/official/.codex")),
                default_home.clone(),
            ),
            PathBuf::from("D:/fixture/.codex")
        );
        assert_eq!(
            resolve_codex_home(
                None,
                Some(PathBuf::from("D:/official/.codex")),
                default_home.clone()
            ),
            PathBuf::from("D:/official/.codex")
        );
        assert_eq!(
            resolve_codex_home(None, None, default_home),
            PathBuf::from("C:/Users/tester/.codex")
        );
    }

    #[test]
    fn first_environment_setup_creates_the_fixed_custom_identity_without_credentials() {
        let prepared = build_connection_environment_config("").unwrap();
        assert!(prepared.contains("disable_response_storage = true"));
        assert!(prepared.contains("model_provider = \"custom\""));
        assert!(prepared.contains("[model_providers.custom]"));
        assert!(prepared.contains("name = \"Signalman AI\""));
        assert!(prepared.contains("wire_api = \"responses\""));
        assert!(!prepared.contains("base_url ="));
        assert!(!prepared.contains("[model_providers.custom.auth]"));

        let checks = validation_checks(&prepared);
        assert!(checks.iter().any(|check| check.id == "custom-provider"));
        assert!(checks.iter().any(|check| check.id == "custom-base-url"));
    }

    #[test]
    fn takeover_removes_old_openai_and_owl_connection_fields() {
        let original = r#"model = "gpt-5"
model_provider = "openai"
model_catalog_json = "C:/old/catalog.json"
openai_base_url = "https://owl.example/v1"
chatgpt_base_url = "https://owl.example/v1"
[model_providers.custom]
name = "OWL"
base_url = "https://owl.example/v1"
wire_api = "responses"
api_key = "should-not-survive"
[model_providers.custom.auth]
command = "old-helper"
[mcp_servers.keep]
command = "preserve"
"#;
        let prepared = build_connection_environment_config(original).unwrap();
        assert!(prepared.contains("model_provider = \"custom\""));
        assert!(prepared.contains("name = \"Signalman AI\""));
        assert!(!prepared.contains("owl.example"));
        assert!(!prepared.contains("should-not-survive"));
        assert!(!prepared.contains("old-helper"));
        assert!(!prepared.contains("model_catalog_json"));
        assert!(prepared.contains("[mcp_servers.keep]"));
        assert!(prepared.contains("command = \"preserve\""));
    }

    #[test]
    fn first_provider_switch_materializes_a_complete_custom_provider() {
        let prepared = build_connection_environment_config("").unwrap();
        let profile: StoredProfile = serde_json::from_value(json!({
            "name": "First provider",
            "base_url": "https://provider.example/v1",
            "api_key": "test-key",
            "model": "gpt-test"
        }))
        .unwrap();

        let switched = build_next_config(&prepared, "test-profile", &profile).unwrap();
        assert!(switched.contains("model_provider = \"custom\""));
        assert!(switched.contains("[model_providers.custom]"));
        assert!(switched.contains("base_url = \"https://provider.example/v1\""));
        assert!(switched.contains("wire_api = \"responses\""));
        assert!(switched.contains("[model_providers.custom.auth]"));
        assert!(!switched.contains("requires_openai_auth"));
    }

    #[test]
    fn legacy_import_never_overwrites_an_existing_protected_credential() {
        let mut catalog = catalog_with(
            "owl",
            profile(
                "OWL",
                "https://api.example.test/v1",
                "",
                "protected-existing-key",
            ),
        );
        let document = legacy_document(json!({
            "owl": {
                "name": "OWL",
                "base_url": "https://api.example.test/v1",
                "api_key": "legacy-test-key"
            }
        }));

        assert_eq!(
            merge_legacy_profile_document(&mut catalog, &document).unwrap(),
            0
        );
        let preserved: StoredProfile =
            serde_json::from_value(catalog.profiles["owl"].clone()).unwrap();
        assert!(preserved.api_key.is_empty());
        assert_eq!(preserved.api_key_protected, "protected-existing-key");
    }

    #[test]
    fn legacy_import_adds_an_unmatched_profile() {
        let mut existing = profile("OWL", "https://api.example.test/v1", "", "");
        existing["default"] = Value::Bool(true);
        let mut catalog = catalog_with("owl", existing);
        let document = legacy_document(json!({
            "a6api": {
                "name": "a6api",
                "base_url": "https://a6.example.test/v1",
                "api_key": "legacy-test-key",
                "model": "gpt-test",
                "default": true,
                "note": "restored profile"
            }
        }));

        assert_eq!(
            merge_legacy_profile_document(&mut catalog, &document).unwrap(),
            1
        );
        let restored: StoredProfile =
            serde_json::from_value(catalog.profiles["a6api"].clone()).unwrap();
        assert_eq!(restored.name, "a6api");
        assert_eq!(restored.base_url, "https://a6.example.test/v1");
        assert_eq!(restored.api_key, "legacy-test-key");
        assert!(!restored.default);
    }

    #[test]
    fn repeated_legacy_import_is_idempotent() {
        let mut catalog =
            catalog_with("owl", profile("OWL", "https://api.example.test/v1", "", ""));
        let document = legacy_document(json!({
            "owl": {
                "name": "OWL",
                "base_url": "https://api.example.test/v1",
                "api_key": "legacy-test-key"
            }
        }));

        assert_eq!(
            merge_legacy_profile_document(&mut catalog, &document).unwrap(),
            1
        );
        assert_eq!(
            merge_legacy_profile_document(&mut catalog, &document).unwrap(),
            0
        );
        assert_eq!(catalog.profiles.len(), 1);
    }
}
