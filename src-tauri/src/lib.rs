use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_autostart::ManagerExt;
#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

mod commands;
mod compat;
mod domain;
mod lab;
mod providers;
mod services;
mod storage;
mod updates;

pub use compat::import_legacy_profile_document_core;
#[allow(unused_imports)]
pub(crate) use compat::{merge_legacy_profile_document, profile_id_for_save, unique_profile_id};
pub use domain::*;
pub(crate) use domain::{check, custom_authentication_risk, validation_checks};
pub(crate) use lab::*;
use providers::{
    apply_verification, fetch_provider_models, provider_probe_endpoint, reset_profile_verification,
    verify_provider_auth_probe,
};
#[cfg(test)]
use providers::{
    build_model_catalog as provider_build_model_catalog, has_compatible_response_output,
    has_provider_error, model_catalog_http_detail, parse_provider_models,
};
pub(crate) use providers::{preferred_auth_mode, uses_provider_command_auth};
pub(crate) use services::*;
pub(crate) use storage::*;
pub use updates::check_for_update_core;

// Keep the existing data directory so installed users retain DPAPI-protected
// credentials, backups, and history when the visible product brand changes.
const APP_DIR_NAME: &str = "CodeX Provider Switcher";
const PROFILES_FILE: &str = "profiles.json";
const ACTIVITY_FILE: &str = "activity.json";
const BACKUPS_DIR: &str = "backups";
const INITIAL_BACKUP_LABEL: &str = "initial-install";
const CURRENT_BACKUP_FINGERPRINT_VERSION: u8 = 2;
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
const RELEASES_API_URL: &str =
    "https://api.github.com/repos/ga626/codex-provider-switcher/releases?per_page=20";
const PROTECTED_FILE_SUFFIX: &str = ".dpapi";

fn is_store_release_channel() -> bool {
    matches!(
        option_env!("CODEX_PROVIDER_SWITCHER_RELEASE_CHANNEL"),
        Some("store")
    )
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
    env::var_os("CODEX_PROVIDER_SWITCHER_BUILD_SHA").is_some()
        && profile.api_key.trim() == "development-placeholder"
        && profile.base_url.trim().ends_with(".example/v1")
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
    tauri::async_runtime::spawn_blocking(operation)
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
    let started_at = std::time::Instant::now();
    let result = run_blocking_command(operation).await;
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
    use super::*;

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
            id: String::new(),
            name: "草稿服务商".to_string(),
            base_url: "https://provider.example/v1".to_string(),
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
            name: "Test".to_string(),
            base_url: "https://provider.example/v1".to_string(),
            api_key: "key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-test".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
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
    fn switching_declares_profile_key_authentication_explicitly() {
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
            name: "after".to_string(),
            base_url: "https://after.example/v1".to_string(),
            api_key: "after-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-after".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, &profile).unwrap();

        assert!(next.contains("requires_openai_auth = false"));
    }

    #[test]
    fn switching_removes_legacy_api_key_for_no_auth_provider() {
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
            name: "after".to_string(),
            base_url: "https://after.example/v1".to_string(),
            api_key: "after-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-after".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, &profile).unwrap();
        let checks = validation_checks(&next);

        assert!(!next.contains("api_key"));
        assert!(checks
            .iter()
            .any(|check| { check.id == "custom-authentication-mode" && check.ok }));
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
            name: "ModelFlare".to_string(),
            base_url: "https://modelflare.dev/v1".to_string(),
            api_key: "model-flare-test-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-5.6-sol".to_string(),
            auth_mode: "provider_command".to_string(),
            model_reasoning_effort: "xhigh".to_string(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, &profile).unwrap();
        let parsed = toml::from_str::<toml::Value>(&next).unwrap();
        let auth = parsed
            .get("model_providers")
            .and_then(|providers| providers.get("custom"))
            .and_then(|provider| provider.get("auth"))
            .expect("provider auth table");
        assert_eq!(
            auth.get("command").and_then(toml::Value::as_str),
            Some("powershell.exe")
        );
        let args = auth
            .get("args")
            .and_then(toml::Value::as_array)
            .expect("provider auth args");
        let command = args
            .iter()
            .filter_map(toml::Value::as_str)
            .find(|value| value.contains("OPENAI_API_KEY"))
            .expect("provider auth command");
        assert!(command.contains("$env:CODEX_HOME"));
        assert!(command.contains("Join-Path $codexHome 'auth.json'"));
        assert!(!command.contains("Join-Path (Join-Path $HOME '.codex') 'auth.json'"));
        assert!(!next.contains("requires_openai_auth"));
        assert!(next.contains("gpt-5.6-sol"));
        assert!(protected_sections_match(original, &next).unwrap());

        let auth_json = build_next_auth(r#"{"other":"keep"}"#, &profile).unwrap();
        let auth_value = serde_json::from_str::<Value>(&auth_json).unwrap();
        assert_eq!(
            auth_value.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("model-flare-test-key")
        );
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
    fn switching_preserves_existing_requires_openai_auth_value() {
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
            name: "after".to_string(),
            base_url: "https://after.example/v1".to_string(),
            api_key: "after-key".to_string(),
            api_key_protected: String::new(),
            model: "gpt-after".to_string(),
            auth_mode: default_auth_mode(),
            model_reasoning_effort: default_reasoning(),
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            default: false,
            note: String::new(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: None,
            last_verification_stage: None,
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };

        let next = build_next_config(original, &profile).unwrap();

        assert!(next.contains("requires_openai_auth = false"));
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
fn prepare_connection_environment(
    layer_id: String,
    onboarding: Option<bool>,
) -> Result<AppState, SwitcherError> {
    prepare_connection_environment_core_with_onboarding(layer_id, onboarding.unwrap_or(false))
}

#[tauri::command]
fn complete_onboarding() -> Result<AppState, SwitcherError> {
    complete_onboarding_core()
}

pub fn prepare_connection_environment_core(layer_id: String) -> Result<AppState, SwitcherError> {
    prepare_connection_environment_core_with_onboarding(layer_id, false)
}

pub fn prepare_connection_environment_core_with_onboarding(
    layer_id: String,
    onboarding: bool,
) -> Result<AppState, SwitcherError> {
    let candidates = configuration_layer_candidates()?;
    if !candidates.iter().any(|(id, _, _)| id == &layer_id) {
        return Err(SwitcherError::Message(
            "选择的 Codex 配置层已不存在，请重新检查。".to_string(),
        ));
    }
    let previous = load_connection_environment_record();
    let onboarding_completed =
        !onboarding && (previous.onboarding_completed || previous.setup_completed);
    let selected = StoredConnectionEnvironment {
        selected_layer_id: Some(layer_id.clone()),
        setup_completed: false,
        onboarding_completed,
    };
    save_connection_environment_record(&selected)?;
    let config = config_path()?;
    let auth = auth_path()?;
    let original_config = capture_file(&config)?;
    let original_auth = capture_file(&auth)?;
    let result = (|| {
        let original = String::from_utf8(original_config.bytes.clone()).map_err(|_| {
            SwitcherError::Message(
                "现有 Codex 配置不是 UTF-8 文本，已停止准备连接环境。".to_string(),
            )
        })?;
        let next = build_connection_environment_config(&original)?;
        create_backup()?;
        write_bytes_atomically(&config, next.as_bytes())?;
        if !original_auth.exists {
            write_bytes_atomically(&auth, b"{}")?;
        }
        let confirmed_config = fs::read_to_string(&config)?;
        if confirmed_config != next || !protected_sections_match(&original, &confirmed_config)? {
            return Err(SwitcherError::Message(
                "连接环境准备未通过回读确认，已停止继续使用。".to_string(),
            ));
        }
        let confirmed_auth = read_auth()?;
        let auth_value = serde_json::from_str::<Value>(&confirmed_auth)?;
        if !auth_value.is_object() {
            return Err(SwitcherError::Message(
                "认证文件不是 JSON 对象，已停止准备连接环境。".to_string(),
            ));
        }
        let completed = StoredConnectionEnvironment {
            selected_layer_id: Some(layer_id),
            setup_completed: true,
            onboarding_completed,
        };
        save_connection_environment_record(&completed)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = restore_file_snapshot(&config, &original_config);
        let _ = restore_file_snapshot(&auth, &original_auth);
        let _ = save_connection_environment_record(&previous);
        return Err(error);
    }
    app_state_with_activity(
        "连接环境已准备",
        "已创建恢复点，并只统一 custom 服务商与 Responses 所需设置；项目、MCP、插件和历史记录保持不变。",
        "success",
    )
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
    app_state()
}

fn switch_config(
    profile: &StoredProfile,
    expected_fingerprint: &str,
    expected_candidate_fingerprint: &str,
) -> Result<(), SwitcherError> {
    let original = read_config()?;
    ensure_configuration_layer_is_unambiguous()?;
    let config = config_path()?;
    let auth = auth_path()?;
    let original_auth_text = read_auth()?;
    let before_fingerprint = owned_configuration_fingerprint(&original, &original_auth_text)?;
    if before_fingerprint != expected_fingerprint {
        return Err(SwitcherError::Message(
            "切换预览已过期：Codex 服务商设置已发生变化，请重新检查后确认。".to_string(),
        ));
    }
    healthy_baseline_backup()?;
    let next_config = build_next_config(&original, profile)?;
    let next_auth = build_next_auth(&original_auth_text, profile)?;
    let candidate_fingerprint = owned_configuration_fingerprint(&next_config, &next_auth)?;
    if candidate_fingerprint != expected_candidate_fingerprint {
        return Err(SwitcherError::Message(
            "切换预览已失效：目标服务商认证或配置发生变化，请重新检查。".to_string(),
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
    if let Err(error) = write_bytes_atomically(&auth, next_auth.as_bytes()) {
        let _ = write_bytes_atomically(&config, original.as_bytes());
        let _ = complete_config_transaction();
        return Err(error);
    }
    update_config_transaction_phase("auth_replaced")?;
    let written_config = match fs::read_to_string(&config) {
        Ok(value) => value,
        Err(error) => {
            let _ = restore_file_snapshot(
                &config,
                &FileSnapshot {
                    exists: true,
                    bytes: original.as_bytes().to_vec(),
                },
            );
            let _ = restore_file_snapshot(
                &auth,
                &FileSnapshot {
                    exists: true,
                    bytes: original_auth_text.as_bytes().to_vec(),
                },
            );
            let _ = complete_config_transaction();
            return Err(error.into());
        }
    };
    let written_auth = match fs::read_to_string(&auth) {
        Ok(value) => value,
        Err(error) => {
            let _ = restore_file_snapshot(
                &config,
                &FileSnapshot {
                    exists: true,
                    bytes: original.as_bytes().to_vec(),
                },
            );
            let _ = restore_file_snapshot(
                &auth,
                &FileSnapshot {
                    exists: true,
                    bytes: original_auth_text.as_bytes().to_vec(),
                },
            );
            let _ = complete_config_transaction();
            return Err(error.into());
        }
    };
    if written_config != next_config || written_auth != next_auth {
        let _ = restore_file_snapshot(
            &config,
            &FileSnapshot {
                exists: true,
                bytes: original.as_bytes().to_vec(),
            },
        );
        let _ = restore_file_snapshot(
            &auth,
            &FileSnapshot {
                exists: true,
                bytes: original_auth_text.as_bytes().to_vec(),
            },
        );
        let _ = complete_config_transaction();
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
    save_catalog(&catalog)?;
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
    save_profile_core(profile)
}

pub fn save_profile_core(profile: EditableProfile) -> Result<AppState, SwitcherError> {
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
    let mut stored = StoredProfile {
        name: profile.name.trim().to_string(),
        base_url: profile.base_url.trim().to_string(),
        api_key,
        api_key_protected: String::new(),
        model: profile.model.trim().to_string(),
        auth_mode: existing_profile
            .as_ref()
            .map(|p| p.auth_mode.clone())
            .filter(|mode| {
                mode != &default_auth_mode()
                    || preferred_auth_mode(&profile.name, &profile.base_url) != "provider_command"
            })
            .unwrap_or_else(|| preferred_auth_mode(&profile.name, &profile.base_url)),
        model_reasoning_effort: existing_profile
            .as_ref()
            .map(|p| p.model_reasoning_effort.clone())
            .unwrap_or_else(default_reasoning),
        verified: false,
        verification_status: default_verification_status(),
        verification_response_shape: None,
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
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已保存"),
        "服务商信息已更新；已清除旧兼容性探测结果。",
        "info",
    )
}

#[tauri::command]
fn delete_profile(profile_id: String) -> Result<AppState, SwitcherError> {
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
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已删除"),
        "该服务商已从切换目录移除；当前和默认服务商不会被删除。",
        "warning",
    )
}

#[tauri::command]
fn reorder_profiles(profile_ids: Vec<String>) -> Result<AppState, SwitcherError> {
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
    save_catalog(&catalog)?;
    app_state_with_activity(
        "服务商顺序已更新",
        "此顺序只影响列表显示，不会切换或改写 Codex 设置。",
        "info",
    )
}

#[tauri::command]
fn reveal_profile_api_key(profile_id: String) -> Result<String, SwitcherError> {
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

#[tauri::command]
fn prepare_switch(profile_id: String) -> Result<SwitchPreflight, SwitcherError> {
    prepare_switch_core(profile_id)
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
    let auth = fs::read_to_string(auth_path()?)?;
    let fingerprint = owned_configuration_fingerprint(&config, &auth)?;
    let candidate_config = build_next_config(&config, &profile)?;
    let candidate_auth = build_next_auth(&auth, &profile)?;
    let candidate_fingerprint =
        owned_configuration_fingerprint(&candidate_config, &candidate_auth)?;
    healthy_baseline_backup()?;
    let verification = verify_provider_auth_probe(&profile);
    let verified = verification.verified;
    let detail = verification.detail.clone();
    apply_verification(&mut profile, verification, now_label());
    if verified {
        mark_catalog_model_verified(&mut catalog, &profile_id, &profile.model)?;
    }
    catalog
        .profiles
        .insert(profile_id.clone(), serde_json::to_value(&profile)?);
    save_catalog(&catalog)?;
    let mut risks = Vec::new();
    if profile.api_key.trim().is_empty() {
        risks.push(
            "未保存应用访问密钥；切换器已记录外部认证风险，无法用 profile 凭据确认目标服务商。"
                .to_string(),
        );
    }
    if !verified {
        risks.push(format!("目标服务商的本次自动检查未确认可用：{detail}"));
    }
    if let Some(detail) = custom_authentication_risk(&candidate_config)? {
        risks.push(detail);
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
        risk_acknowledgement_required: !risks.is_empty(),
    };
    write_bytes_atomically(
        &switch_preflight_path()?,
        serde_json::to_string_pretty(&preflight)?.as_bytes(),
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
        &profile,
        &preflight.fingerprint,
        &preflight.candidate_fingerprint,
    )?;
    let _ = fs::remove_file(switch_preflight_path()?);
    profile.last_switched_at = Some(now_label());
    catalog
        .profiles
        .insert(profile_id, serde_json::to_value(profile)?);
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("已切换到 {display_name}"),
        if has_risk {
            "已写入同一候选认证合同的 Codex 服务商配置并生成回滚备份；切换前自动检查提示的使用风险已由用户确认。"
        } else {
            "已写入同一候选认证合同的 Codex 服务商配置并生成回滚备份；切换前自动检查已通过。"
        },
        if has_risk { "warning" } else { "success" },
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
    apply_verification(&mut profile, verification, now_label());
    if verified {
        mark_catalog_model_verified(&mut catalog, &profile_id, &profile.model)?;
    }
    catalog
        .profiles
        .insert(profile_id, serde_json::to_value(profile)?);
    save_catalog(&catalog)?;
    if verified {
        app_state_with_activity(
            "服务商可用性测试通过",
            &format!("{display_name} 已完成短时、已认证的可用性测试。"),
            "success",
        )
    } else if status == "response_shape_unconfirmed" || status == "response_unparseable" {
        app_state_with_activity(
            "服务端已响应，结果待确认",
            &format!("{display_name} 的可用性测试未能确认模型输出：{detail}"),
            "warning",
        )
    } else {
        app_state_with_activity(
            "服务商可用性测试未确认",
            &format!("{display_name} 的可用性测试未确认：{detail}"),
            "warning",
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
        observation.actual_model = Some(requested_model);
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
        push_probe_observation(&mut catalog, observation);
        save_catalog(&catalog)?;
        return app_state_with_activity(
            "返回能力探针已完成",
            &format!("{}：{detail}", profile.name),
            "success",
        );
    }
    let client = configure_http_client(
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .http1_only(),
    )
    .build()
    .map_err(|err| SwitcherError::Message(format!("创建探针连接失败：{err}")))?;
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
                        if observation.cost_candidate.is_some() {
                            observation.status = "final_cost_inline".to_string();
                            observation.detail = "已从响应内容或响应头读取费用候选值；仍需核对平台余额单位和账单规则后再保存。".to_string();
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
    push_probe_observation(&mut catalog, observation);
    save_catalog(&catalog)?;
    app_state_with_activity(
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
    )
}

#[tauri::command]
fn save_cost_calibration(input: CostCalibrationInput) -> Result<AppState, SwitcherError> {
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
    let result_cny = calculate_calibrated_cost(&input)?;
    let official_cny = input
        .official_cny
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_fixed_decimal(value, "官方同次成本").map(|_| value.to_string()))
        .transpose()?;
    let now = now_label();
    let record = CostCalibration {
        id: format!("cost-calibration-{}", Local::now().timestamp_millis()),
        provider_id: input.provider_id,
        provider_name: input.provider_name,
        funding_mode: input.funding_mode,
        paid_cny: input.paid_cny,
        consumable_credit: input.consumable_credit,
        debit_credit: input.debit_credit,
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
    let mut catalog = load_catalog()?;
    catalog.cost_calibrations.insert(0, record);
    catalog.cost_calibrations.truncate(100);
    save_catalog(&catalog)?;
    app_state_with_activity(
        "费用校准已保存",
        &format!("{provider_name} 的固定探针人民币成本为 ¥{result_cny}。"),
        "success",
    )
}

#[tauri::command]
fn delete_cost_calibration(calibration_id: String) -> Result<AppState, SwitcherError> {
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
    save_catalog(&catalog)?;
    app_state_with_activity("已删除费用记录", "已删除一条基准测试费用记录。", "info")
}

pub fn preview_models_core(profile: EditableProfile) -> Result<ModelCatalog, SwitcherError> {
    let base_url = profile.base_url.trim();
    provider_probe_endpoint(base_url, "models").map_err(SwitcherError::Message)?;

    let draft_profile = StoredProfile {
        name: profile.name.trim().to_string(),
        base_url: base_url.to_string(),
        api_key: profile.api_key.trim().to_string(),
        api_key_protected: String::new(),
        model: profile.model.trim().to_string(),
        auth_mode: preferred_auth_mode(&profile.name, base_url),
        model_reasoning_effort: default_reasoning(),
        verified: false,
        verification_status: default_verification_status(),
        verification_response_shape: None,
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
            catalog
                .model_catalogs
                .insert(profile_id, serde_json::to_value(&model_catalog)?);
            save_catalog(&catalog)?;
            return app_state_with_activity(
                "模型目录已刷新",
                &model_catalog.status_detail,
                "success",
            );
        }
    }
    let mut model_catalog = fetch_provider_models(&profile_id, &profile)?;
    preserve_previous_model_catalog(previous_catalog.as_ref(), &mut model_catalog);
    preserve_catalog_model_verifications(previous_catalog.as_ref(), &mut model_catalog);
    let ok = model_catalog.status == "ok";
    catalog
        .model_catalogs
        .insert(profile_id.clone(), serde_json::to_value(&model_catalog)?);
    save_catalog(&catalog)?;
    app_state_with_activity(
        if ok {
            "模型目录已刷新"
        } else {
            "模型目录刷新失败"
        },
        &model_catalog.status_detail,
        if ok { "success" } else { "warning" },
    )
}

#[tauri::command]
fn set_default_profile(profile_id: String) -> Result<AppState, SwitcherError> {
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
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已设为默认"),
        "默认标记仅影响切换目录排序和保护策略，不会立即改写 Codex 当前服务商。",
        "info",
    )
}

#[tauri::command]
fn sync_current_configuration() -> Result<AppState, SwitcherError> {
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
    save_catalog(&catalog)?;
    app_state_with_activity(
        "已同步当前 Codex 配置",
        &format!("{display_name} 的目录模型已从 {previous_model} 同步为 {current_model}；旧测试结果已失效，未写入 Codex 配置或凭据。"),
        "success",
    )
}

#[tauri::command]
fn toggle_auto_start(app: tauri::AppHandle, enabled: bool) -> Result<AppState, SwitcherError> {
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

#[tauri::command]
fn restore_backup(backup_id: String, confirmation: String) -> Result<AppState, SwitcherError> {
    restore_backup_core(backup_id, confirmation)
}

pub fn restore_backup_core(
    backup_id: String,
    confirmation: String,
) -> Result<AppState, SwitcherError> {
    if confirmation.trim() != "恢复" {
        return Err(SwitcherError::Message(
            "请在恢复确认窗口中输入“恢复”后再继续。".to_string(),
        ));
    }
    let (backup_dir, manifest) = read_backup_manifest(&backup_id)?;
    current_state_is_safe_to_restore(&manifest)?;
    let config = config_path()?;
    let auth = auth_path()?;
    let (next_config, next_auth) = restored_owned_files(&backup_dir, &manifest)?;
    let previous_config = capture_file(&config)?;
    let rollback_label = unique_backup_label("before-restore");
    let rollback_dir = create_backup_with_label(&rollback_label, "before_restore")?;
    let rollback_id = rollback_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SwitcherError::Message("恢复点标识无效。".to_string()))?;
    let before_fingerprint = current_owned_fingerprint()?;
    begin_config_transaction(rollback_id, "restore", &before_fingerprint)?;
    if let Err(error) = write_bytes_atomically(&config, next_config.as_bytes()) {
        complete_config_transaction()?;
        return Err(error);
    }
    update_config_transaction_phase("config_replaced")?;
    if let Some(next_auth) = next_auth {
        if let Err(error) = write_bytes_atomically(&auth, next_auth.as_bytes()) {
            let config_rollback = restore_file_snapshot(&config, &previous_config);
            if config_rollback.is_err() {
                return Err(SwitcherError::Message(
                    "恢复失败且自动恢复未完成；请立即使用恢复中心中的最新恢复点。".to_string(),
                ));
            }
            complete_config_transaction()?;
            return Err(error);
        }
        update_config_transaction_phase("auth_replaced")?;
    }
    let current_auth = fs::read_to_string(&auth)?;
    let restored_fingerprint = owned_configuration_fingerprint(&next_config, &current_auth)?;
    record_backup_post_change(&rollback_dir, &restored_fingerprint)?;
    record_operation_receipt(ConfigOperationReceipt {
        id: unique_backup_label("restore-receipt"),
        backup_id: backup_id.clone(),
        kind: "restore".to_string(),
        created_at: now_label(),
        fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
        before_fingerprint,
        after_fingerprint: restored_fingerprint,
    })?;
    update_config_transaction_phase("verified")?;
    complete_config_transaction()?;

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
            if let Some(title) = development_window_title() {
                if let Some(window) = app.get_webview_window("main") {
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
            prepare_switch,
            switch_profile,
            commands::verify_profile,
            commands::run_response_probe,
            save_cost_calibration,
            delete_cost_calibration,
            commands::refresh_models,
            commands::preview_models,
            set_default_profile,
            sync_current_configuration,
            toggle_auto_start,
            create_manual_backup,
            set_backup_policy,
            restore_latest_backup,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running Signalman AI");
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
    fn first_environment_setup_does_not_create_an_empty_current_provider() {
        let prepared = build_connection_environment_config("").unwrap();
        assert!(prepared.contains("disable_response_storage = true"));
        assert!(!prepared.contains("model_provider = \"custom\""));
        assert!(!prepared.contains("[model_providers.custom]"));

        let checks = validation_checks(&prepared);
        assert!(checks.iter().any(|check| {
            check.id == "custom-provider" && !check.ok && check.severity == "info"
        }));
        assert!(checks.iter().any(|check| {
            check.id == "custom-base-url" && !check.ok && check.severity == "info"
        }));
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

        let switched = build_next_config(&prepared, &profile).unwrap();
        assert!(switched.contains("model_provider = \"custom\""));
        assert!(switched.contains("[model_providers.custom]"));
        assert!(switched.contains("base_url = \"https://provider.example/v1\""));
        assert!(switched.contains("wire_api = \"responses\""));
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
