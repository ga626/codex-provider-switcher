use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SwitcherError {
    #[error("无法定位用户目录。")]
    MissingHome,
    #[error("文件读写错误：{0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 解析错误：{0}")]
    Json(#[from] serde_json::Error),
    #[error("TOML 解析错误：{0}")]
    Toml(#[from] toml::de::Error),
    #[error("{0}")]
    Message(String),
}

/// Versioned lifecycle payload for long-running operations.
///
/// The desktop and local-web adapters may transport this value independently
/// of `AppState`. Keeping the fields string-based makes the contract forward
/// compatible with new operation kinds while the `version` field gives the
/// client an explicit negotiation point.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationEventV1 {
    pub version: u8,
    /// A unique id for one invocation, not the human-readable operation kind.
    pub id: String,
    pub kind: String,
    pub scope: String,
    pub phase: String,
    pub started_at: String,
    pub elapsed_ms: u64,
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl OperationEventV1 {
    pub const VERSION: u8 = 1;

    pub fn started(id: String, kind: String, scope: String, started_at: String) -> Self {
        Self {
            version: Self::VERSION,
            id,
            kind,
            scope,
            phase: "running".to_string(),
            started_at,
            elapsed_ms: 0,
            result: "pending".to_string(),
            detail: None,
            error_code: None,
        }
    }

    pub fn completed(&self, elapsed_ms: u64, detail: Option<String>) -> Self {
        Self {
            phase: "completed".to_string(),
            elapsed_ms,
            result: "success".to_string(),
            detail,
            ..self.clone()
        }
    }

    pub fn failed(&self, elapsed_ms: u64, detail: String, error_code: Option<String>) -> Self {
        Self {
            phase: "completed".to_string(),
            elapsed_ms,
            result: "failure".to_string(),
            detail: Some(detail),
            error_code,
            ..self.clone()
        }
    }

    pub fn cancelled(&self, elapsed_ms: u64, detail: Option<String>) -> Self {
        Self {
            phase: "completed".to_string(),
            elapsed_ms,
            result: "cancelled".to_string(),
            detail,
            ..self.clone()
        }
    }

    pub fn is_terminal(&self) -> bool {
        self.phase == "completed"
    }
}

#[cfg(test)]
mod operation_event_tests {
    use super::OperationEventV1;

    #[test]
    fn lifecycle_keeps_invocation_identity_and_serializes_camel_case() {
        let started = OperationEventV1::started(
            "op-123".to_string(),
            "refresh-models".to_string(),
            "provider".to_string(),
            "2026-08-21T00:00:00Z".to_string(),
        );
        assert_eq!(started.version, 1);
        assert_eq!(started.phase, "running");
        assert_eq!(started.result, "pending");
        assert!(!started.is_terminal());

        let finished = started.completed(1250, Some("模型目录已刷新".to_string()));
        assert_eq!(finished.id, "op-123");
        assert_eq!(finished.elapsed_ms, 1250);
        assert!(finished.is_terminal());

        let json = serde_json::to_value(finished).unwrap();
        assert_eq!(json["startedAt"], "2026-08-21T00:00:00Z");
        assert_eq!(json["elapsedMs"], 1250);
        assert_eq!(json["result"], "success");
    }

    #[test]
    fn failure_and_cancel_keep_terminal_result_and_detail() {
        let started = OperationEventV1::started(
            "op-456".to_string(),
            "verify-profile".to_string(),
            "provider".to_string(),
            "2026-08-21T00:00:00Z".to_string(),
        );
        let failed = started.failed(
            2400,
            "服务商拒绝请求".to_string(),
            Some("provider_http_401".to_string()),
        );
        assert!(failed.is_terminal());
        assert_eq!(failed.result, "failure");
        assert_eq!(failed.error_code.as_deref(), Some("provider_http_401"));

        let cancelled = started.cancelled(30, Some("用户取消".to_string()));
        assert!(cancelled.is_terminal());
        assert_eq!(cancelled.result, "cancelled");
        assert_eq!(cancelled.detail.as_deref(), Some("用户取消"));
    }
}

impl serde::Serialize for SwitcherError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub reasoning_effort: String,
    pub note: String,
    pub verified: bool,
    pub verification_status: String,
    pub verification_response_shape: Option<String>,
    pub is_default: bool,
    pub active: bool,
    pub has_api_key: bool,
    pub last_switched_at: Option<String>,
    pub last_verified_at: Option<String>,
    pub last_verification_detail: Option<String>,
    pub last_verification_stage: Option<String>,
    pub last_verification_http_status: Option<u16>,
    pub last_verification_provider_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub aliases: Vec<String>,
    pub source: String,
    pub tags: Vec<String>,
    pub verified_for_responses: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub provider_id: String,
    pub base_url: String,
    pub fetched_at: Option<String>,
    #[serde(default)]
    pub last_successful_at: Option<String>,
    pub status: String,
    pub status_detail: String,
    #[serde(default)]
    pub http_status: Option<u16>,
    #[serde(default)]
    pub provider_code: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub retry_after_seconds: Option<u64>,
    pub models: Vec<ProviderModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub note: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub id: String,
    pub time: String,
    pub title: String,
    pub detail: String,
    pub tone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostCalibration {
    pub id: String,
    pub provider_id: String,
    pub provider_name: String,
    pub funding_mode: String,
    pub paid_cny: String,
    pub consumable_credit: String,
    pub debit_credit: String,
    pub credit_unit_label: String,
    pub model: String,
    pub probe_version: String,
    #[serde(default)]
    pub cost_source: String,
    #[serde(default)]
    pub probe_id: Option<String>,
    #[serde(default = "default_sample_kind")]
    pub sample_kind: String,
    #[serde(default)]
    pub official_cny: Option<String>,
    pub result_cny: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostCalibrationInput {
    pub provider_id: String,
    pub provider_name: String,
    pub funding_mode: String,
    pub paid_cny: String,
    pub consumable_credit: String,
    pub debit_credit: String,
    pub credit_unit_label: String,
    pub model: String,
    pub probe_version: String,
    #[serde(default)]
    pub cost_source: String,
    #[serde(default)]
    pub probe_id: Option<String>,
    #[serde(default = "default_sample_kind")]
    pub sample_kind: String,
    #[serde(default)]
    pub official_cny: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseProbeObservation {
    pub id: String,
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub probe_version: String,
    pub observed_at: String,
    pub status: String,
    pub http_status: Option<u16>,
    pub request_id: Option<String>,
    pub response_id: Option<String>,
    #[serde(default)]
    pub actual_model: Option<String>,
    pub usage: Option<ProbeUsage>,
    pub cost_candidate: Option<String>,
    #[serde(default)]
    pub cost_source: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    pub id: String,
    pub time: String,
    pub label: String,
    pub files: usize,
    pub file_categories: Vec<String>,
    pub kind: String,
    pub retention_managed: bool,
    pub restore_ready: bool,
    pub restore_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPolicy {
    pub automatic_limit: usize,
    pub manual_limit: usize,
}

pub fn default_backup_policy() -> BackupPolicy {
    BackupPolicy {
        automatic_limit: 3,
        manual_limit: 3,
    }
}

pub fn normalized_backup_limit(value: usize) -> usize {
    value.clamp(1, 10)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub(crate) schema_version: u8,
    #[serde(default)]
    pub(crate) fingerprint_version: u8,
    pub(crate) created_at: String,
    pub(crate) reason: String,
    pub(crate) files: Vec<String>,
    #[serde(default)]
    pub(crate) missing_files: Vec<String>,
    #[serde(default)]
    pub(crate) post_change_fingerprint: Option<String>,
    #[serde(default)]
    pub(crate) snapshot_fingerprint: Option<String>,
    /// Digest of every configuration/auth field outside Signalman's owned
    /// provider contract.  This is an audit proof that protected settings
    /// (including previously unknown root fields) survived a write.
    #[serde(default)]
    pub(crate) protected_fingerprint: Option<String>,
    #[serde(default)]
    pub(crate) file_digests: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) retention_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingConfigTransaction {
    pub(crate) backup_id: String,
    pub(crate) reason: String,
    #[serde(default = "default_transaction_phase")]
    pub(crate) phase: String,
    #[serde(default)]
    pub(crate) before_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigOperationReceipt {
    pub(crate) id: String,
    pub(crate) backup_id: String,
    pub(crate) kind: String,
    pub(crate) created_at: String,
    #[serde(default)]
    pub(crate) fingerprint_version: u8,
    pub(crate) before_fingerprint: String,
    pub(crate) after_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSwitchPreflight {
    pub(crate) operation_id: String,
    pub(crate) profile_id: String,
    pub(crate) created_at: String,
    pub(crate) expires_at: i64,
    pub(crate) fingerprint: String,
    pub(crate) candidate_fingerprint: String,
    #[serde(default)]
    pub(crate) protected_fingerprint: String,
    #[serde(default)]
    pub(crate) candidate_protected_fingerprint: String,
    pub(crate) risk_acknowledgement_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchPreflight {
    pub operation_id: String,
    pub profile_id: String,
    pub target_name: String,
    pub target_model: String,
    pub backup_detail: String,
    pub protected_detail: String,
    pub availability_status: String,
    pub availability_detail: String,
    pub availability_checked_at: String,
    pub risk_detail: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub release_url: String,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GithubReleaseAsset {
    pub(crate) name: String,
    pub(crate) browser_download_url: String,
}

#[derive(Debug, Deserialize)]
pub struct GithubRelease {
    pub(crate) tag_name: String,
    pub(crate) html_url: String,
    pub(crate) draft: bool,
    pub(crate) published_at: Option<String>,
    #[serde(default)]
    pub(crate) assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub runtime_mode: String,
    pub current_profile_id: String,
    pub config_path: String,
    pub auth_path: String,
    pub auto_start: bool,
    pub backup_policy: BackupPolicy,
    pub startup_notice: Option<StartupNotice>,
    pub tray_enabled: bool,
    pub safe_mode: bool,
    pub configuration_drift: Option<ConfigurationDrift>,
    pub profiles: Vec<ProviderProfile>,
    pub model_catalogs: Vec<ModelCatalog>,
    pub checks: Vec<ValidationCheck>,
    pub activity: Vec<ActivityItem>,
    pub cost_calibrations: Vec<CostCalibration>,
    pub response_probes: Vec<ResponseProbeObservation>,
    pub backups: Vec<BackupItem>,
    pub configuration_protection: ConfigurationProtection,
    pub connection_environment: ConnectionEnvironment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEnvironmentLayer {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEnvironment {
    pub status: String,
    pub selected_layer_id: Option<String>,
    pub onboarding_completed: bool,
    pub detail: String,
    pub layers: Vec<ConnectionEnvironmentLayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoredConnectionEnvironment {
    #[serde(default)]
    pub(crate) selected_layer_id: Option<String>,
    #[serde(default)]
    pub(crate) setup_completed: bool,
    #[serde(default)]
    pub(crate) onboarding_completed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTransportOptions {
    pub proxy: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupNotice {
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupDiagnostic {
    pub(crate) created_at: String,
    pub(crate) phase: String,
    pub(crate) code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationProtection {
    pub baseline_ready: bool,
    pub baseline_status: String,
    pub baseline_detail: String,
    pub items: Vec<ConfigurationProtectionItem>,
    pub restore_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationProtectionItem {
    pub id: String,
    pub label: String,
    pub count: Option<usize>,
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationDrift {
    pub profile_id: String,
    pub profile_name: String,
    pub current_model: String,
    pub saved_model: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredProfile {
    pub(crate) name: String,
    pub(crate) base_url: String,
    #[serde(default)]
    pub(crate) api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) api_key_protected: String,
    pub(crate) model: String,
    /// Provider-specific presentation and migration preference. Only an
    /// explicitly selected/verified adapter may use provider-level command
    /// auth; ordinary profiles use the standard Bearer contract.
    #[serde(default = "default_auth_mode")]
    pub(crate) auth_mode: String,
    #[serde(default = "default_reasoning")]
    pub(crate) model_reasoning_effort: String,
    #[serde(default)]
    pub(crate) verified: bool,
    #[serde(default = "default_verification_status")]
    pub(crate) verification_status: String,
    #[serde(default)]
    pub(crate) verification_response_shape: Option<String>,
    #[serde(default)]
    pub(crate) default: bool,
    #[serde(default)]
    pub(crate) note: String,
    #[serde(default)]
    pub(crate) last_switched_at: Option<String>,
    #[serde(default)]
    pub(crate) last_verified_at: Option<String>,
    #[serde(default)]
    pub(crate) last_verification_detail: Option<String>,
    #[serde(default)]
    pub(crate) last_verification_stage: Option<String>,
    #[serde(default)]
    pub(crate) last_verification_http_status: Option<u16>,
    #[serde(default)]
    pub(crate) last_verification_provider_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LegacyProfile {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) base_url: String,
    #[serde(default)]
    pub(crate) api_key: String,
    #[serde(default)]
    pub(crate) model: String,
    #[serde(default = "default_reasoning")]
    pub(crate) model_reasoning_effort: String,
    #[serde(default)]
    pub(crate) default: bool,
    #[serde(default)]
    pub(crate) note: String,
}

#[derive(Debug, Clone)]
pub struct ProviderVerificationOutcome {
    pub(crate) verified: bool,
    pub(crate) status: String,
    pub(crate) detail: String,
    pub(crate) stage: String,
    pub(crate) http_status: Option<u16>,
    pub(crate) provider_code: Option<String>,
    pub(crate) response_shape: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCatalog {
    #[serde(default = "default_version")]
    pub(crate) version: String,
    pub(crate) profiles: Map<String, Value>,
    #[serde(default)]
    pub(crate) model_catalogs: Map<String, Value>,
    #[serde(default)]
    pub(crate) cost_calibrations: Vec<CostCalibration>,
    #[serde(default)]
    pub(crate) response_probes: Vec<ResponseProbeObservation>,
    #[serde(default)]
    pub(crate) profile_order: Vec<String>,
    #[serde(default)]
    pub(crate) auto_start: bool,
    #[serde(default = "default_backup_policy")]
    pub(crate) backup_policy: BackupPolicy,
    #[serde(default)]
    pub(crate) invariants: Value,
}

pub fn default_version() -> String {
    "0.1".to_string()
}

pub fn default_verification_status() -> String {
    "not_checked".to_string()
}

pub fn default_reasoning() -> String {
    "high".to_string()
}

pub fn default_auth_mode() -> String {
    "bearer_profile_key".to_string()
}

pub fn default_transaction_phase() -> String {
    "prepared".to_string()
}

pub fn default_sample_kind() -> String {
    "cold".to_string()
}

pub(crate) fn check(
    id: &str,
    label: &str,
    ok: bool,
    detail: &str,
    severity: &str,
) -> ValidationCheck {
    ValidationCheck {
        id: id.to_string(),
        label: label.to_string(),
        ok,
        detail: detail.to_string(),
        severity: severity.to_string(),
    }
}

pub(crate) fn validation_checks(config_text: &str) -> Vec<ValidationCheck> {
    let parsed: Result<toml::Value, _> = toml::from_str(config_text);
    let mut checks = Vec::new();

    match parsed {
        Ok(value) => {
            checks.push(check(
                "toml",
                "TOML 语法",
                true,
                "配置文件可以正常解析。",
                "required",
            ));
            let model_provider = value
                .get("model_provider")
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            let root_model = value
                .get("model")
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            let response_storage_disabled = value
                .get("disable_response_storage")
                .and_then(toml::Value::as_bool)
                .unwrap_or(false);
            checks.push(check(
                "root-model",
                "Codex 模型",
                !root_model.trim().is_empty(),
                if !root_model.trim().is_empty() {
                    "根配置中已设置 model。"
                } else {
                    "根配置缺少 model，Codex 可能无法确定默认模型。"
                },
                "warning",
            ));
            checks.push(check(
                "model-provider",
                "model_provider 已锁定",
                model_provider == "custom",
                if model_provider == "custom" {
                    "Codex 保持在 custom 服务商分组。"
                } else if model_provider.is_empty() {
                    "尚未选择服务商；保存并切换第一家服务商时会自动设置。"
                } else {
                    "model_provider 必须保持 custom，避免破坏历史记录和服务商分组行为。"
                },
                if model_provider.is_empty() {
                    "info"
                } else {
                    "warning"
                },
            ));
            checks.push(check(
                "disable-response-storage",
                "禁用 Response Storage",
                response_storage_disabled,
                if response_storage_disabled {
                    "disable_response_storage 已保持 true，第三方 responses 中转不会触发存储型压缩路径。"
                } else {
                    "必须写入 disable_response_storage = true，避免第三方中转站在上下文压缩时触发 502。"
                },
                "warning",
            ));
            let custom = value.get("model_providers").and_then(|v| v.get("custom"));
            checks.push(check(
                "custom-provider",
                "custom 服务商配置段",
                custom.is_some(),
                if custom.is_some() {
                    "[model_providers.custom] 存在。"
                } else {
                    "尚未添加服务商；保存并切换第一家服务商时会自动创建。"
                },
                if custom.is_some() { "warning" } else { "info" },
            ));
            let wire_api = custom
                .and_then(|v| v.get("wire_api"))
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            checks.push(check(
                "wire-api",
                "Responses 线路协议",
                wire_api == "responses",
                if wire_api == "responses" {
                    "wire_api 当前为 responses。"
                } else if custom.is_none() {
                    "尚未添加服务商；切换第一家服务商时会自动设置为 responses。"
                } else {
                    "wire_api 必须保持 responses，才能兼容 Codex 原生请求。"
                },
                if custom.is_none() { "info" } else { "warning" },
            ));
            let base_url = custom
                .and_then(|v| v.get("base_url"))
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            checks.push(check(
                "custom-base-url",
                "当前接口地址",
                base_url.starts_with("http"),
                if base_url.starts_with("http") {
                    "custom 服务商已配置 base_url。"
                } else if custom.is_none() {
                    "尚未添加服务商，因此当前没有接口地址。"
                } else {
                    "custom 服务商缺少有效 base_url。"
                },
                if custom.is_none() { "info" } else { "warning" },
            ));
            let requires_openai_auth = custom
                .and_then(|v| v.get("requires_openai_auth"))
                .and_then(toml::Value::as_bool)
                .unwrap_or(false);
            let env_key = custom
                .and_then(|v| v.get("env_key"))
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            let auth_command = custom
                .and_then(|v| v.get("auth"))
                .and_then(|v| v.get("command"))
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            // `requires_openai_auth = true` is itself a valid, visible
            // authentication contract. Newer Codex runtimes use it to
            // consume the selected key from auth.json; treating it as an
            // invisible warning would contradict the switcher's candidate
            // contract.
            let authentication_is_visible = !auth_command.trim().is_empty()
                || requires_openai_auth
                || (!requires_openai_auth && env_key.trim().is_empty());
            let authentication_detail = if !auth_command.trim().is_empty() {
                "当前服务商使用 provider 级 auth.command 读取密钥；切换器会保留该认证合同。"
            } else if requires_openai_auth && !env_key.trim().is_empty() {
                "当前认证由 Codex 登录和环境变量共同管理；切换器不会读取或改写它们，切换后请在新会话确认可用性。"
            } else if requires_openai_auth {
                "当前服务商使用 Codex 登录认证；切换器不会读取或改写登录信息，无法代替 Codex 确认登录状态。"
            } else if !env_key.trim().is_empty() {
                "当前服务商通过环境变量认证；切换器不会读取或改写环境变量，无法代替运行时确认其可用性。"
            } else {
                "当前服务商未声明认证方式；按 Codex 规则视为无需认证，不会要求或写入 api_key。"
            };
            checks.push(check(
                "custom-authentication-mode",
                "当前认证方式",
                authentication_is_visible,
                authentication_detail,
                "warning",
            ));
        }
        Err(err) => {
            checks.push(check(
                "toml",
                "TOML 语法",
                false,
                &err.to_string(),
                "required",
            ));
        }
    }

    checks
}

pub(crate) fn custom_authentication_risk(
    config_text: &str,
) -> Result<Option<String>, SwitcherError> {
    let config = toml::from_str::<toml::Value>(config_text)?;
    let custom = config
        .get("model_providers")
        .and_then(|providers| providers.get("custom"))
        .ok_or_else(|| {
            SwitcherError::Message("缺少 [model_providers.custom] 配置段。".to_string())
        })?;
    let requires_openai_auth = custom
        .get("requires_openai_auth")
        .and_then(toml::Value::as_bool)
        .unwrap_or(false);
    let env_key = custom
        .get("env_key")
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    let auth_command = custom
        .get("auth")
        .and_then(|auth| auth.get("command"))
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    Ok(if !auth_command.trim().is_empty() {
        None
    } else if requires_openai_auth && !env_key.trim().is_empty() {
        Some("当前认证由 Codex 登录和环境变量管理；切换器不会读取或改写认证，切换后请在新会话确认可用性。".to_string())
    } else if requires_openai_auth {
        Some(
            "当前认证由 Codex 登录管理；切换器不会读取或改写认证，切换后请在新会话确认可用性。"
                .to_string(),
        )
    } else if !env_key.trim().is_empty() {
        Some(
            "当前认证由环境变量管理；切换器不会读取或改写环境变量，切换后请在新会话确认可用性。"
                .to_string(),
        )
    } else {
        None
    })
}
