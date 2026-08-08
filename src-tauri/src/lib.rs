use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_plugin_autostart::ManagerExt;
use thiserror::Error;

// Keep the existing data directory so installed users retain DPAPI-protected
// credentials, backups, and history when the visible product brand changes.
const APP_DIR_NAME: &str = "CodeX Provider Switcher";
const PROFILES_FILE: &str = "profiles.json";
const ACTIVITY_FILE: &str = "activity.json";
const BACKUPS_DIR: &str = "backups";
const INITIAL_BACKUP_LABEL: &str = "initial-install";
const PENDING_TRANSACTION_FILE: &str = "pending-config-transaction.json";
const SWITCH_PREFLIGHT_FILE: &str = "pending-switch-preflight.json";
const OPERATION_RECEIPTS_FILE: &str = "config-operation-receipts.json";
const STARTUP_DIAGNOSTICS_FILE: &str = "startup-diagnostics.json";
const CODEX_HOME_ENV: &str = "CODEX_PROVIDER_SWITCHER_CODEX_HOME";
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
    pub status: String,
    pub status_detail: String,
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
    pub usage: Option<ProbeUsage>,
    pub cost_candidate: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
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

fn default_backup_policy() -> BackupPolicy {
    BackupPolicy {
        automatic_limit: 3,
        manual_limit: 3,
    }
}

fn normalized_backup_limit(value: usize) -> usize {
    value.clamp(1, 10)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupManifest {
    schema_version: u8,
    created_at: String,
    reason: String,
    files: Vec<String>,
    #[serde(default)]
    missing_files: Vec<String>,
    #[serde(default)]
    post_change_fingerprint: Option<String>,
    #[serde(default)]
    snapshot_fingerprint: Option<String>,
    #[serde(default)]
    file_digests: BTreeMap<String, String>,
    #[serde(default)]
    retention_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingConfigTransaction {
    backup_id: String,
    reason: String,
    #[serde(default = "default_transaction_phase")]
    phase: String,
    #[serde(default)]
    before_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConfigOperationReceipt {
    id: String,
    backup_id: String,
    kind: String,
    created_at: String,
    before_fingerprint: String,
    after_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSwitchPreflight {
    operation_id: String,
    profile_id: String,
    created_at: String,
    expires_at: i64,
    fingerprint: String,
    candidate_fingerprint: String,
    risk_acknowledgement_required: bool,
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
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupNotice {
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StartupDiagnostic {
    created_at: String,
    phase: String,
    code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationProtection {
    pub baseline_ready: bool,
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
struct StoredProfile {
    name: String,
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key_protected: String,
    model: String,
    #[serde(default = "default_reasoning")]
    model_reasoning_effort: String,
    #[serde(default)]
    verified: bool,
    #[serde(default = "default_verification_status")]
    verification_status: String,
    #[serde(default)]
    verification_response_shape: Option<String>,
    #[serde(default)]
    default: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    last_switched_at: Option<String>,
    #[serde(default)]
    last_verified_at: Option<String>,
    #[serde(default)]
    last_verification_detail: Option<String>,
    #[serde(default)]
    last_verification_stage: Option<String>,
    #[serde(default)]
    last_verification_http_status: Option<u16>,
    #[serde(default)]
    last_verification_provider_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LegacyProfile {
    #[serde(default)]
    name: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default = "default_reasoning")]
    model_reasoning_effort: String,
    #[serde(default)]
    default: bool,
    #[serde(default)]
    note: String,
}

#[derive(Debug, Clone)]
struct ProviderVerificationOutcome {
    verified: bool,
    status: String,
    detail: String,
    stage: String,
    http_status: Option<u16>,
    provider_code: Option<String>,
    response_shape: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCatalog {
    #[serde(default = "default_version")]
    version: String,
    profiles: Map<String, Value>,
    #[serde(default)]
    model_catalogs: Map<String, Value>,
    #[serde(default)]
    cost_calibrations: Vec<CostCalibration>,
    #[serde(default)]
    response_probes: Vec<ResponseProbeObservation>,
    #[serde(default)]
    profile_order: Vec<String>,
    #[serde(default)]
    auto_start: bool,
    #[serde(default = "default_backup_policy")]
    backup_policy: BackupPolicy,
    #[serde(default)]
    invariants: Value,
}

fn default_version() -> String {
    "0.1".to_string()
}

fn default_verification_status() -> String {
    "not_checked".to_string()
}

fn default_reasoning() -> String {
    "high".to_string()
}

fn default_transaction_phase() -> String {
    "prepared".to_string()
}

fn now_label() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn short_time() -> String {
    Local::now().format("%H:%M").to_string()
}

fn codex_home() -> Result<PathBuf, SwitcherError> {
    if let Some(path) = env::var_os(CODEX_HOME_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let home = dirs::home_dir().ok_or(SwitcherError::MissingHome)?;
    Ok(home.join(".codex"))
}

fn config_path() -> Result<PathBuf, SwitcherError> {
    Ok(codex_home()?.join("config.toml"))
}

fn discovered_profile_configs() -> Result<Vec<PathBuf>, SwitcherError> {
    let home = codex_home()?;
    let entries = match fs::read_dir(&home) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".config.toml"))
        })
        .collect())
}

fn configuration_layer_check() -> ValidationCheck {
    match discovered_profile_configs() {
        Ok(paths) if paths.is_empty() => check(
            "configuration-layer",
            "配置写入位置",
            true,
            "将只写入当前 Codex 用户配置。",
            "required",
        ),
        Ok(paths) => check(
            "configuration-layer",
            "配置写入位置",
            false,
            &format!(
                "检测到 {} 个 Codex profile 配置。为避免修改错误位置，请先在 Codex 中确认使用的 profile；本版本不会猜测写入目标。",
                paths.len()
            ),
            "required",
        ),
        Err(error) => check(
            "configuration-layer",
            "配置写入位置",
            false,
            &format!("无法确认 Codex 配置位置：{error}"),
            "required",
        ),
    }
}

fn ensure_configuration_layer_is_unambiguous() -> Result<(), SwitcherError> {
    let paths = discovered_profile_configs()?;
    if paths.is_empty() {
        return Ok(());
    }
    Err(SwitcherError::Message(format!(
        "切换已阻止：检测到 {} 个 Codex profile 配置，本版本无法确认当前实际生效的写入目标。请先在 Codex 中确认 profile，避免修改错误配置。",
        paths.len()
    )))
}

fn auth_path() -> Result<PathBuf, SwitcherError> {
    Ok(codex_home()?.join("auth.json"))
}

fn app_data_dir() -> Result<PathBuf, SwitcherError> {
    if let Some(path) = env::var_os(APP_DATA_DIR_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let base = dirs::data_local_dir().ok_or(SwitcherError::MissingHome)?;
    Ok(base.join(APP_DIR_NAME))
}

fn profiles_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(PROFILES_FILE))
}

fn activity_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(ACTIVITY_FILE))
}

fn backups_dir() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(BACKUPS_DIR))
}

fn pending_transaction_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(PENDING_TRANSACTION_FILE))
}

fn switch_preflight_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(SWITCH_PREFLIGHT_FILE))
}

fn operation_receipts_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(OPERATION_RECEIPTS_FILE))
}

fn startup_diagnostics_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(STARTUP_DIAGNOSTICS_FILE))
}

fn ensure_dirs() -> Result<(), SwitcherError> {
    fs::create_dir_all(app_data_dir()?)?;
    fs::create_dir_all(backups_dir()?)?;
    Ok(())
}

fn begin_config_transaction(
    backup_id: &str,
    reason: &str,
    before_fingerprint: &str,
) -> Result<(), SwitcherError> {
    let transaction = PendingConfigTransaction {
        backup_id: backup_id.to_string(),
        reason: reason.to_string(),
        phase: default_transaction_phase(),
        before_fingerprint: before_fingerprint.to_string(),
    };
    write_bytes_atomically(
        &pending_transaction_path()?,
        serde_json::to_string_pretty(&transaction)?.as_bytes(),
    )
}

fn update_config_transaction_phase(phase: &str) -> Result<(), SwitcherError> {
    let path = pending_transaction_path()?;
    let text = fs::read_to_string(&path)?;
    let mut transaction: PendingConfigTransaction = serde_json::from_str(&text)?;
    transaction.phase = phase.to_string();
    write_bytes_atomically(
        &path,
        serde_json::to_string_pretty(&transaction)?.as_bytes(),
    )
}

fn complete_config_transaction() -> Result<(), SwitcherError> {
    let path = pending_transaction_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn load_operation_receipts() -> Result<Vec<ConfigOperationReceipt>, SwitcherError> {
    let path = operation_receipts_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&fs::read_to_string(path)?).map_err(SwitcherError::from)
}

fn record_operation_receipt(receipt: ConfigOperationReceipt) -> Result<(), SwitcherError> {
    let mut receipts = load_operation_receipts()?;
    receipts.push(receipt);
    receipts.drain(..receipts.len().saturating_sub(100));
    write_bytes_atomically(
        &operation_receipts_path()?,
        serde_json::to_string_pretty(&receipts)?.as_bytes(),
    )
}

fn current_owned_fingerprint() -> Result<String, SwitcherError> {
    owned_configuration_fingerprint(
        &fs::read_to_string(config_path()?)?,
        &fs::read_to_string(auth_path()?)?,
    )
}

fn current_state_is_safe_to_restore(manifest: &BackupManifest) -> Result<(), SwitcherError> {
    let current = current_owned_fingerprint()?;
    if manifest.snapshot_fingerprint.as_deref() == Some(current.as_str()) {
        return Ok(());
    }
    let receipts = load_operation_receipts()?;
    let latest = receipts.last().ok_or_else(|| {
        SwitcherError::Message(
            "当前服务商设置没有可验证的 Signalman 变更回执，已停止自动恢复。".to_string(),
        )
    })?;
    if latest.after_fingerprint != current {
        return Err(SwitcherError::Message(
            "检测到服务商或认证设置在上次 Signalman 操作后发生变化；已停止自动恢复。".to_string(),
        ));
    }
    Ok(())
}

fn protect_secret(bytes: &[u8]) -> Result<String, SwitcherError> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Cryptography::{
                CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };

        let mut input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(SwitcherError::Message("Windows 凭据保护失败。".to_string()));
        }
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(BASE64.encode(protected))
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err(SwitcherError::Message(
            "当前平台不支持 Windows 凭据保护。".to_string(),
        ))
    }
}

fn unprotect_secret(value: &str) -> Result<Vec<u8>, SwitcherError> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Cryptography::{
                CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };

        let mut encrypted = BASE64
            .decode(value)
            .map_err(|_| SwitcherError::Message("受保护凭据格式无效。".to_string()))?;
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(SwitcherError::Message(
                "无法解锁本机受保护凭据。请在原 Windows 用户下恢复或从备份迁移。".to_string(),
            ));
        }
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(plain)
    }
    #[cfg(not(windows))]
    {
        let _ = value;
        Err(SwitcherError::Message(
            "当前平台不支持 Windows 凭据保护。".to_string(),
        ))
    }
}

fn protect_file(source: &Path, destination: &Path) -> Result<(), SwitcherError> {
    let raw = fs::read(source)?;
    write_bytes_atomically(destination, protect_secret(&raw)?.as_bytes())
}

fn write_bytes_atomically(destination: &Path, bytes: &[u8]) -> Result<(), SwitcherError> {
    let parent = destination
        .parent()
        .ok_or_else(|| SwitcherError::Message("无法定位配置文件的父目录。".to_string()))?;
    fs::create_dir_all(parent)?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| SwitcherError::Message("配置文件名无效。".to_string()))?;
    let temporary = parent.join(format!(
        ".{name}.signalman-write-{}-{}.tmp",
        std::process::id(),
        Local::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = replace_file_atomically(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> Result<(), SwitcherError> {
    if !destination.exists() {
        fs::rename(temporary, destination)?;
        return Ok(());
    }
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        return Err(SwitcherError::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> Result<(), SwitcherError> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[derive(Debug, Clone)]
struct FileSnapshot {
    exists: bool,
    bytes: Vec<u8>,
}

fn capture_file(path: &Path) -> Result<FileSnapshot, SwitcherError> {
    if path.exists() {
        Ok(FileSnapshot {
            exists: true,
            bytes: fs::read(path)?,
        })
    } else {
        Ok(FileSnapshot {
            exists: false,
            bytes: Vec::new(),
        })
    }
}

fn restore_file_snapshot(path: &Path, snapshot: &FileSnapshot) -> Result<(), SwitcherError> {
    if snapshot.exists {
        write_bytes_atomically(path, &snapshot.bytes)
    } else if path.exists() {
        fs::remove_file(path)?;
        Ok(())
    } else {
        Ok(())
    }
}

fn migrate_legacy_backups() -> Result<(), SwitcherError> {
    let dir = backups_dir()?;
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        for name in ["config.toml", "auth.json"] {
            let plain = entry.path().join(name);
            let protected = entry.path().join(format!("{name}{PROTECTED_FILE_SUFFIX}"));
            if plain.exists() && !protected.exists() {
                protect_file(&plain, &protected)?;
                fs::remove_file(plain)?;
            }
        }
        let manifest_path = entry.path().join("manifest.json");
        let Ok(text) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(mut manifest) = serde_json::from_str::<BackupManifest>(&text) else {
            continue;
        };
        if manifest.schema_version >= 4 {
            continue;
        }
        let config_protected = entry.path().join("config.toml.dpapi");
        let auth_protected = entry.path().join("auth.json.dpapi");
        if !config_protected.exists() || !auth_protected.exists() {
            continue;
        }
        let config_protected_bytes = fs::read(&config_protected)?;
        let auth_protected_bytes = fs::read(&auth_protected)?;
        let config = String::from_utf8(unprotect_secret(&String::from_utf8_lossy(
            &config_protected_bytes,
        ))?)
        .map_err(|_| SwitcherError::Message("旧恢复点中的设置文件不是 UTF-8 文本。".to_string()))?;
        let auth = String::from_utf8(unprotect_secret(&String::from_utf8_lossy(
            &auth_protected_bytes,
        ))?)
        .map_err(|_| SwitcherError::Message("旧恢复点中的认证文件不是 UTF-8 文本。".to_string()))?;
        manifest.schema_version = 4;
        manifest.files = vec![
            "config.toml.dpapi".to_string(),
            "auth.json.dpapi".to_string(),
        ];
        manifest.missing_files.clear();
        manifest.file_digests = BTreeMap::from([
            (
                "config.toml.dpapi".to_string(),
                bytes_digest(&config_protected_bytes),
            ),
            (
                "auth.json.dpapi".to_string(),
                bytes_digest(&auth_protected_bytes),
            ),
        ]);
        manifest.snapshot_fingerprint = Some(owned_configuration_fingerprint(&config, &auth)?);
        write_bytes_atomically(
            &manifest_path,
            serde_json::to_string_pretty(&manifest)?.as_bytes(),
        )?;
    }
    Ok(())
}

fn normalize_id(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn seed_catalog_from_existing() -> Result<StoredCatalog, SwitcherError> {
    Ok(StoredCatalog {
        version: default_version(),
        profiles: Map::new(),
        model_catalogs: Map::new(),
        cost_calibrations: Vec::new(),
        response_probes: Vec::new(),
        profile_order: Vec::new(),
        auto_start: false,
        backup_policy: default_backup_policy(),
        invariants: default_invariants(),
    })
}

fn default_invariants() -> Value {
    json!({
        "model_provider": "custom",
        "protected_sections": [
            "projects",
            "features",
            "desktop",
            "memories",
            "mcp_servers",
            "plugins",
            "windows",
            "hooks.state",
            "marketplaces"
        ],
        "protected_field_count": {
            "hook_trusted_hashes": 4
        }
    })
}

fn load_catalog() -> Result<StoredCatalog, SwitcherError> {
    ensure_dirs()?;
    recover_pending_config_transaction()?;
    ensure_initial_backup()?;
    let path = profiles_path()?;
    if !path.exists() {
        let mut catalog = seed_catalog_from_existing()?;
        hydrate_catalog_secrets(&mut catalog)?;
        save_catalog(&catalog)?;
        return Ok(catalog);
    }
    let text = fs::read_to_string(path)?;
    let mut catalog: StoredCatalog = parse_json_document(&text)?;
    normalize_catalog(&mut catalog);
    let migrated = hydrate_catalog_secrets(&mut catalog)?;
    migrate_legacy_backups()?;
    if migrated {
        save_catalog(&catalog)?;
    }
    Ok(catalog)
}

fn parse_json_document<T>(document: &str) -> Result<T, SwitcherError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(document.trim_start_matches('\u{feff}')).map_err(SwitcherError::from)
}

fn hydrate_catalog_secrets(catalog: &mut StoredCatalog) -> Result<bool, SwitcherError> {
    let mut migrated = false;
    for value in catalog.profiles.values_mut() {
        let mut profile: StoredProfile = serde_json::from_value(value.clone())?;
        if !profile.api_key_protected.is_empty() {
            profile.api_key = String::from_utf8(unprotect_secret(&profile.api_key_protected)?)
                .map_err(|_| SwitcherError::Message("受保护凭据不是 UTF-8 文本。".to_string()))?;
        } else if !profile.api_key.is_empty() {
            migrated = true;
        }
        *value = serde_json::to_value(profile)?;
    }
    Ok(migrated)
}

fn normalize_catalog(catalog: &mut StoredCatalog) {
    let protected_empty = catalog
        .invariants
        .get("protected_sections")
        .and_then(Value::as_array)
        .map(|items| items.is_empty())
        .unwrap_or(true);
    if protected_empty {
        catalog.invariants = default_invariants();
    }
    catalog
        .profile_order
        .retain(|id| catalog.profiles.contains_key(id));
    for id in catalog.profiles.keys() {
        if !catalog.profile_order.contains(id) {
            catalog.profile_order.push(id.clone());
        }
    }
}

fn save_catalog(catalog: &StoredCatalog) -> Result<(), SwitcherError> {
    ensure_dirs()?;
    let mut persisted = catalog.clone();
    for value in persisted.profiles.values_mut() {
        let mut profile: StoredProfile = serde_json::from_value(value.clone())?;
        if !profile.api_key.trim().is_empty() {
            profile.api_key_protected = protect_secret(profile.api_key.as_bytes())?;
        }
        profile.api_key.clear();
        *value = serde_json::to_value(profile)?;
    }
    let text = serde_json::to_string_pretty(&persisted)?;
    fs::write(profiles_path()?, text)?;
    Ok(())
}

fn legacy_profile_entries(document: &str) -> Result<Vec<(String, LegacyProfile)>, SwitcherError> {
    let root: Value = serde_json::from_str(document)?;
    let profiles = root.get("profiles").unwrap_or(&root);
    let entries = match profiles {
        Value::Object(items) => items
            .iter()
            .map(|(id, value)| {
                serde_json::from_value::<LegacyProfile>(value.clone())
                    .map(|profile| (id.clone(), profile))
                    .map_err(SwitcherError::from)
            })
            .collect::<Result<Vec<_>, _>>()?,
        Value::Array(items) => items
            .iter()
            .map(|value| {
                let profile = serde_json::from_value::<LegacyProfile>(value.clone())?;
                Ok((normalize_id(&profile.name), profile))
            })
            .collect::<Result<Vec<_>, SwitcherError>>()?,
        _ => {
            return Err(SwitcherError::Message(
                "旧版 profiles.json 的结构无法识别。".to_string(),
            ));
        }
    };

    if entries.is_empty() {
        return Err(SwitcherError::Message(
            "旧版 profiles.json 中没有可导入的服务商。".to_string(),
        ));
    }

    Ok(entries)
}

fn legacy_profile_matches(
    profile_id: &str,
    profile: &StoredProfile,
    legacy_id: &str,
    legacy: &LegacyProfile,
) -> bool {
    profile_id == legacy_id
        || normalize_id(&profile.name) == normalize_id(&legacy.name)
        || (!profile.base_url.trim().is_empty()
            && profile
                .base_url
                .trim()
                .eq_ignore_ascii_case(legacy.base_url.trim()))
}

fn unique_profile_id(catalog: &StoredCatalog, preferred: &str) -> String {
    let base = if preferred.trim().is_empty() {
        "legacy-provider".to_string()
    } else {
        normalize_id(preferred)
    };
    if !catalog.profiles.contains_key(&base) {
        return base;
    }

    for index in 2.. {
        let candidate = format!("{base}-{index}");
        if !catalog.profiles.contains_key(&candidate) {
            return candidate;
        }
    }
    unreachable!("unbounded profile identifier search")
}

fn merge_legacy_profile_document(
    catalog: &mut StoredCatalog,
    document: &str,
) -> Result<usize, SwitcherError> {
    let mut imported = 0;
    let has_default = catalog.profiles.values().any(|value| {
        serde_json::from_value::<StoredProfile>(value.clone())
            .map(|profile| profile.default)
            .unwrap_or(false)
    });

    for (legacy_id, legacy) in legacy_profile_entries(document)? {
        if legacy.api_key.trim().is_empty() {
            continue;
        }

        let matching_id = catalog.profiles.iter().find_map(|(id, value)| {
            let profile = serde_json::from_value::<StoredProfile>(value.clone()).ok()?;
            legacy_profile_matches(id, &profile, &legacy_id, &legacy).then(|| id.clone())
        });

        if let Some(profile_id) = matching_id {
            let value = catalog
                .profiles
                .get(&profile_id)
                .cloned()
                .ok_or_else(|| SwitcherError::Message("服务商目录读取失败。".to_string()))?;
            let mut profile: StoredProfile = serde_json::from_value(value)?;
            if profile.api_key.trim().is_empty() && profile.api_key_protected.trim().is_empty() {
                profile.api_key = legacy.api_key.trim().to_string();
                catalog
                    .profiles
                    .insert(profile_id, serde_json::to_value(profile)?);
                imported += 1;
            }
            continue;
        }

        let profile_id = unique_profile_id(catalog, &legacy_id);
        let profile = StoredProfile {
            name: legacy.name.trim().to_string(),
            base_url: legacy.base_url.trim().to_string(),
            api_key: legacy.api_key.trim().to_string(),
            api_key_protected: String::new(),
            model: legacy.model.trim().to_string(),
            model_reasoning_effort: legacy.model_reasoning_effort,
            verified: false,
            verification_status: default_verification_status(),
            verification_response_shape: None,
            default: legacy.default && !has_default,
            note: legacy.note.trim().to_string(),
            last_switched_at: None,
            last_verified_at: None,
            last_verification_detail: Some(
                "已从旧版目录恢复凭据；请重新运行服务商可用性测试。".to_string(),
            ),
            last_verification_stage: Some("profile".to_string()),
            last_verification_http_status: None,
            last_verification_provider_code: None,
        };
        catalog
            .profiles
            .insert(profile_id, serde_json::to_value(profile)?);
        imported += 1;
    }

    Ok(imported)
}

fn backup_catalog_before_legacy_import() -> Result<(), SwitcherError> {
    let source = profiles_path()?;
    if !source.exists() {
        return Ok(());
    }
    let directory = app_data_dir()?.join("legacy-profile-imports");
    fs::create_dir_all(&directory)?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let destination = directory.join(format!(
        "profiles-before-import-{stamp}.json{PROTECTED_FILE_SUFFIX}"
    ));
    protect_file(&source, &destination)
}

pub fn import_legacy_profile_document_core(document: String) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let imported = merge_legacy_profile_document(&mut catalog, &document)?;
    if imported == 0 {
        return app_state_with_activity(
            "未发现可恢复凭据",
            "旧版目录没有可填补的 API 密钥；现有已保护凭据保持不变。",
            "info",
        );
    }

    backup_catalog_before_legacy_import()?;
    save_catalog(&catalog)?;
    app_state_with_activity(
        "已恢复旧版服务商凭据",
        &format!("已安全导入 {imported} 条本机凭据并使用 Windows 凭据保护保存；旧版文件未被修改。请重新运行可用性测试。"),
        "success",
    )
}

fn read_config() -> Result<String, SwitcherError> {
    Ok(fs::read_to_string(config_path()?)?)
}

fn current_profile_id(catalog: &StoredCatalog, config_text: &str) -> String {
    let custom = toml::from_str::<toml::Value>(config_text)
        .ok()
        .and_then(|config| {
            config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("custom"))
                .cloned()
        });
    let current_name = custom
        .as_ref()
        .and_then(|provider| provider.get("name"))
        .and_then(toml::Value::as_str);
    let current_base_url = custom
        .as_ref()
        .and_then(|provider| provider.get("base_url"))
        .and_then(toml::Value::as_str);
    let matches = catalog
        .profiles
        .iter()
        .filter_map(|(id, value)| {
            serde_json::from_value::<StoredProfile>(value.clone())
                .ok()
                .map(|profile| (id, profile))
        })
        .filter(|(_, profile)| Some(profile.base_url.as_str()) == current_base_url)
        .collect::<Vec<_>>();
    if let Some(name) = current_name {
        if let Some((id, _)) = matches.iter().find(|(_, profile)| profile.name == name) {
            return (*id).to_string();
        }
    }
    if matches.len() == 1 {
        return matches[0].0.to_string();
    }
    "unknown".to_string()
}

fn catalog_profiles(catalog: &StoredCatalog, current_id: &str) -> Vec<ProviderProfile> {
    catalog
        .profile_order
        .iter()
        .filter_map(|id| {
            catalog
                .profiles
                .get(id)
                .cloned()
                .and_then(|value| serde_json::from_value::<StoredProfile>(value).ok())
                .map(|profile| ProviderProfile {
                    id: id.clone(),
                    name: profile.name,
                    base_url: profile.base_url,
                    model: profile.model,
                    reasoning_effort: profile.model_reasoning_effort,
                    note: profile.note,
                    verified: profile.verified && profile.verification_status == "verified",
                    verification_status: profile.verification_status,
                    verification_response_shape: profile.verification_response_shape,
                    is_default: profile.default,
                    active: id == current_id,
                    has_api_key: !profile.api_key.trim().is_empty(),
                    last_switched_at: profile.last_switched_at,
                    last_verified_at: profile.last_verified_at,
                    last_verification_detail: profile.last_verification_detail,
                    last_verification_stage: profile.last_verification_stage,
                    last_verification_http_status: profile.last_verification_http_status,
                    last_verification_provider_code: profile.last_verification_provider_code,
                })
        })
        .collect()
}

fn catalog_model_catalogs(catalog: &StoredCatalog) -> Vec<ModelCatalog> {
    catalog
        .model_catalogs
        .iter()
        .filter_map(|(_, value)| serde_json::from_value::<ModelCatalog>(value.clone()).ok())
        .collect()
}

fn validation_checks(config_text: &str) -> Vec<ValidationCheck> {
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
                } else {
                    "model_provider 必须保持 custom，避免破坏历史记录和服务商分组行为。"
                },
                "warning",
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
                    "缺少 [model_providers.custom]，无法安全切换服务商。"
                },
                "required",
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
                } else {
                    "wire_api 必须保持 responses，才能兼容 Codex 原生请求。"
                },
                "warning",
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
                } else {
                    "custom 服务商缺少有效 base_url。"
                },
                "warning",
            ));
            let requires_openai_auth = custom
                .and_then(|v| v.get("requires_openai_auth"))
                .and_then(toml::Value::as_bool)
                .unwrap_or(false);
            let env_key = custom
                .and_then(|v| v.get("env_key"))
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            let authentication_is_visible = !requires_openai_auth && env_key.trim().is_empty();
            let authentication_detail = if requires_openai_auth && !env_key.trim().is_empty() {
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

fn app_validation_checks(config_text: &str) -> Vec<ValidationCheck> {
    let mut checks = validation_checks(config_text);
    checks.push(configuration_layer_check());
    checks
}

fn custom_authentication_risk(config_text: &str) -> Result<Option<String>, SwitcherError> {
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
    Ok(if requires_openai_auth && !env_key.trim().is_empty() {
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

const PROTECTED_CONFIGURATION_AREAS: [(&str, &str, &[&str]); 8] = [
    ("projects", "项目设置", &["projects"]),
    ("features", "功能偏好", &["features"]),
    ("desktop", "桌面设置", &["desktop"]),
    ("memories", "记忆设置", &["memories"]),
    ("mcp-servers", "MCP 服务", &["mcp_servers"]),
    ("plugins", "插件设置", &["plugins"]),
    ("hooks", "自动化规则", &["hooks"]),
    ("marketplaces", "插件市场", &["marketplaces"]),
];

fn toml_value_at<'a>(value: &'a toml::Value, path: &[&str]) -> Option<&'a toml::Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

fn configuration_protection(config_text: &str) -> ConfigurationProtection {
    let parsed = toml::from_str::<toml::Value>(config_text).ok();
    let baseline_ready = healthy_baseline_backup().is_ok();
    let mut items = PROTECTED_CONFIGURATION_AREAS
        .iter()
        .map(|(id, label, path)| {
            let value = parsed
                .as_ref()
                .and_then(|config| toml_value_at(config, path));
            let count = value
                .and_then(toml::Value::as_table)
                .map(|table| table.len());
            let configured = value.is_some();
            ConfigurationProtectionItem {
                id: (*id).to_string(),
                label: (*label).to_string(),
                count,
                state: if configured {
                    "protected"
                } else {
                    "not_configured"
                }
                .to_string(),
                detail: if let Some(count) = count {
                    format!("已设置 {count} 项，切换时会保留。")
                } else if configured {
                    "已设置，切换时会保留。".to_string()
                } else {
                    "未设置；切换不会创建或修改。".to_string()
                },
            }
        })
        .collect::<Vec<_>>();
    items.push(ConfigurationProtectionItem {
        id: "history".to_string(),
        label: "聊天与历史记录".to_string(),
        count: None,
        state: "outside_write_scope".to_string(),
        detail: "不属于本工具读写范围，不会读取或改写。".to_string(),
    });
    items.push(ConfigurationProtectionItem {
        id: "windows".to_string(),
        label: "Windows 设置".to_string(),
        count: parsed
            .as_ref()
            .and_then(|config| config.get("windows"))
            .and_then(toml::Value::as_table)
            .map(|table| table.len()),
        state: "protected".to_string(),
        detail: "切换时会保留。".to_string(),
    });
    ConfigurationProtection {
        baseline_ready,
        baseline_detail: if baseline_ready {
            "首次启动基线备份已验证。恢复只回退服务商配置，不会改写当前 Codex 登录信息。"
                .to_string()
        } else {
            "首次启动基线备份尚未通过完整性检查；应用不会允许切换服务商。".to_string()
        },
        items,
        restore_detail: "只恢复服务商设置；其他内容保持不变。".to_string(),
    }
}

fn protected_sections_match(before: &str, after: &str) -> Result<bool, SwitcherError> {
    let before = toml::from_str::<toml::Value>(before)?;
    let after = toml::from_str::<toml::Value>(after)?;
    Ok(PROTECTED_CONFIGURATION_AREAS
        .iter()
        .all(|(_, _, path)| toml_value_at(&before, path) == toml_value_at(&after, path))
        && toml_value_at(&before, &["windows"]) == toml_value_at(&after, &["windows"]))
}

fn only_provider_owned_configuration_changed(
    before: &str,
    after: &str,
) -> Result<bool, SwitcherError> {
    let mut before = toml::from_str::<toml::Value>(before)?;
    let mut after = toml::from_str::<toml::Value>(after)?;
    for key in [
        "model",
        "model_provider",
        "model_reasoning_effort",
        "disable_response_storage",
    ] {
        before.as_table_mut().and_then(|table| table.remove(key));
        after.as_table_mut().and_then(|table| table.remove(key));
    }
    for value in [&mut before, &mut after] {
        if let Some(custom) = value
            .get_mut("model_providers")
            .and_then(|providers| providers.get_mut("custom"))
            .and_then(toml::Value::as_table_mut)
        {
            for key in [
                "name",
                "wire_api",
                "base_url",
                "api_key",
                "env_key",
                "requires_openai_auth",
                "experimental_bearer_token",
            ] {
                custom.remove(key);
            }
        }
    }
    Ok(before == after)
}

fn owned_configuration_fingerprint(
    config_text: &str,
    auth_text: &str,
) -> Result<String, SwitcherError> {
    let config = toml::from_str::<toml::Value>(config_text)?;
    let custom = config
        .get("model_providers")
        .and_then(|value| value.get("custom"));
    let auth = serde_json::from_str::<Value>(auth_text)?;
    let snapshot = json!({
        "model": config.get("model"),
        "model_provider": config.get("model_provider"),
        "disable_response_storage": config.get("disable_response_storage"),
        "custom": custom.map(|value| json!({
            "name": value.get("name"),
            "wire_api": value.get("wire_api"),
            "requires_openai_auth": value.get("requires_openai_auth"),
            "base_url": value.get("base_url"),
            "api_key": value.get("api_key"),
        })),
        "auth_openai_key": auth.get("OPENAI_API_KEY"),
    });
    let bytes = serde_json::to_vec(&snapshot)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn bytes_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn backup_manifest_health(
    backup_dir: &Path,
    manifest: &BackupManifest,
) -> Result<(), SwitcherError> {
    if manifest.schema_version < 4 {
        return Err(SwitcherError::Message(
            "恢复点使用旧格式，无法自动验证完整性。".to_string(),
        ));
    }
    for file_name in ["config.toml.dpapi", "auth.json.dpapi"] {
        if !manifest.files.iter().any(|file| file == file_name) {
            return Err(SwitcherError::Message(
                "恢复点缺少完整的服务商设置。".to_string(),
            ));
        }
        let protected = fs::read(backup_dir.join(file_name))?;
        let expected_digest = manifest
            .file_digests
            .get(file_name)
            .ok_or_else(|| SwitcherError::Message("恢复点缺少完整性摘要。".to_string()))?;
        if bytes_digest(&protected) != *expected_digest {
            return Err(SwitcherError::Message("恢复点完整性校验失败。".to_string()));
        }
    }
    let config = String::from_utf8(unprotect_secret(&fs::read_to_string(
        backup_dir.join("config.toml.dpapi"),
    )?)?)
    .map_err(|_| SwitcherError::Message("恢复点中的设置文件不是 UTF-8 文本。".to_string()))?;
    let auth = String::from_utf8(unprotect_secret(&fs::read_to_string(
        backup_dir.join("auth.json.dpapi"),
    )?)?)
    .map_err(|_| SwitcherError::Message("恢复点中的认证文件不是 UTF-8 文本。".to_string()))?;
    let fingerprint = owned_configuration_fingerprint(&config, &auth)?;
    if manifest.snapshot_fingerprint.as_deref() != Some(fingerprint.as_str()) {
        return Err(SwitcherError::Message(
            "恢复点与记录的配置摘要不一致。".to_string(),
        ));
    }
    Ok(())
}

fn healthy_baseline_backup() -> Result<(), SwitcherError> {
    let (backup_dir, manifest) = read_backup_manifest(INITIAL_BACKUP_LABEL)?;
    backup_manifest_health(&backup_dir, &manifest)
}

fn check(id: &str, label: &str, ok: bool, detail: &str, severity: &str) -> ValidationCheck {
    ValidationCheck {
        id: id.to_string(),
        label: label.to_string(),
        ok,
        detail: detail.to_string(),
        severity: severity.to_string(),
    }
}

fn validate_backup_id(backup_id: &str) -> Result<(), SwitcherError> {
    if backup_id.contains('/') || backup_id.contains('\\') || backup_id.contains("..") {
        return Err(SwitcherError::Message("恢复点标识无效。".to_string()));
    }
    Ok(())
}

fn read_backup_manifest(backup_id: &str) -> Result<(PathBuf, BackupManifest), SwitcherError> {
    validate_backup_id(backup_id)?;
    let backup_dir = backups_dir()?.join(backup_id);
    let manifest: BackupManifest =
        serde_json::from_str(&fs::read_to_string(backup_dir.join("manifest.json"))?)
            .map_err(|_| SwitcherError::Message("恢复点说明损坏，已拒绝恢复。".to_string()))?;
    backup_manifest_health(&backup_dir, &manifest)?;
    Ok((backup_dir, manifest))
}

fn record_backup_post_change(backup_dir: &Path, fingerprint: &str) -> Result<(), SwitcherError> {
    let manifest_path = backup_dir.join("manifest.json");
    let mut manifest: BackupManifest = serde_json::from_str(&fs::read_to_string(&manifest_path)?)?;
    manifest.post_change_fingerprint = Some(fingerprint.to_string());
    write_bytes_atomically(
        &manifest_path,
        serde_json::to_string_pretty(&manifest)?.as_bytes(),
    )
}

fn required_toml_string(value: &toml::Value, key: &str) -> Result<String, SwitcherError> {
    value
        .get(key)
        .and_then(toml::Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| SwitcherError::Message(format!("恢复点缺少必要的 {key} 设置，已拒绝恢复。")))
}

fn required_toml_bool(value: &toml::Value, key: &str) -> Result<bool, SwitcherError> {
    value
        .get(key)
        .and_then(toml::Value::as_bool)
        .ok_or_else(|| SwitcherError::Message(format!("恢复点缺少必要的 {key} 设置，已拒绝恢复。")))
}

fn optional_toml_bool(value: &toml::Value, key: &str) -> Option<bool> {
    value.get(key).and_then(toml::Value::as_bool)
}

fn restored_owned_files(
    backup_dir: &Path,
    manifest: &BackupManifest,
) -> Result<(String, Option<String>), SwitcherError> {
    if !manifest
        .files
        .iter()
        .any(|file| file == "config.toml.dpapi")
        || !manifest.files.iter().any(|file| file == "auth.json.dpapi")
    {
        return Err(SwitcherError::Message(
            "恢复点不包含完整的服务商设置，已拒绝恢复。".to_string(),
        ));
    }
    let backup_config = String::from_utf8(unprotect_secret(&fs::read_to_string(
        backup_dir.join("config.toml.dpapi"),
    )?)?)
    .map_err(|_| SwitcherError::Message("恢复点中的设置文件不是 UTF-8 文本。".to_string()))?;
    let backup_config_value = toml::from_str::<toml::Value>(&backup_config)?;
    let backup_custom = backup_config_value
        .get("model_providers")
        .and_then(|providers| providers.get("custom"))
        .ok_or_else(|| SwitcherError::Message("恢复点缺少服务商设置，已拒绝恢复。".to_string()))?;
    let current_config = read_config()?;
    let mut lines = current_config
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    upsert_root_string(
        &mut lines,
        "model",
        &required_toml_string(&backup_config_value, "model")?,
    );
    upsert_root_string(
        &mut lines,
        "model_provider",
        &required_toml_string(&backup_config_value, "model_provider")?,
    );
    remove_root_key(&mut lines, "model_reasoning_effort");
    if let Some(reasoning_effort) = backup_config_value
        .get("model_reasoning_effort")
        .and_then(toml::Value::as_str)
    {
        upsert_root_string(&mut lines, "model_reasoning_effort", reasoning_effort);
    }
    upsert_root_bool(
        &mut lines,
        "disable_response_storage",
        required_toml_bool(&backup_config_value, "disable_response_storage")?,
    );
    let start = lines
        .iter()
        .position(|line| line.trim() == "[model_providers.custom]")
        .ok_or_else(|| {
            SwitcherError::Message("当前 Codex 设置缺少服务商段，已拒绝恢复。".to_string())
        })?;
    let mut end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    for key in ["name", "wire_api", "base_url"] {
        upsert_section_string(
            &mut lines,
            start,
            &mut end,
            key,
            &required_toml_string(backup_custom, key)?,
        );
    }
    remove_section_key(&mut lines, start, &mut end, "api_key");
    for key in ["env_key", "experimental_bearer_token"] {
        remove_section_key(&mut lines, start, &mut end, key);
    }
    remove_section_key(&mut lines, start, &mut end, "requires_openai_auth");
    if let Some(value) = optional_toml_bool(backup_custom, "requires_openai_auth") {
        upsert_section_bool(&mut lines, start, &mut end, "requires_openai_auth", value);
    }
    let next_config = lines.join("\r\n");
    if !protected_sections_match(&current_config, &next_config)? {
        return Err(SwitcherError::Message(
            "恢复已阻止：检测到 MCP、插件、项目或其他受保护设置会被改动。".to_string(),
        ));
    }
    let backup_auth_text = String::from_utf8(unprotect_secret(&fs::read_to_string(
        backup_dir.join("auth.json.dpapi"),
    )?)?)
    .map_err(|_| SwitcherError::Message("恢复点中的认证文件不是 UTF-8 文本。".to_string()))?;
    let backup_auth = serde_json::from_str::<Value>(&backup_auth_text)
        .map_err(|_| SwitcherError::Message("恢复点中的认证文件不是有效 JSON。".to_string()))?;
    let mut current_auth = serde_json::from_str::<Value>(&fs::read_to_string(auth_path()?)?)?;
    let backup_key = backup_auth.get("OPENAI_API_KEY").cloned();
    let current_auth_object = current_auth.as_object_mut().ok_or_else(|| {
        SwitcherError::Message("当前认证文件不是 JSON 对象，已拒绝恢复。".to_string())
    })?;
    if let Some(key) = backup_key {
        current_auth_object.insert("OPENAI_API_KEY".to_string(), key);
    } else {
        current_auth_object.remove("OPENAI_API_KEY");
    }
    Ok((
        next_config,
        Some(serde_json::to_string_pretty(&current_auth)?),
    ))
}

fn recover_pending_config_transaction() -> Result<(), SwitcherError> {
    let path = pending_transaction_path()?;
    if !path.exists() {
        return Ok(());
    }
    let transaction: PendingConfigTransaction = serde_json::from_str(&fs::read_to_string(&path)?)
        .map_err(|_| {
        SwitcherError::Message("检测到损坏的配置事务回执；已拒绝继续写入。".to_string())
    })?;
    let (backup_dir, manifest) = read_backup_manifest(&transaction.backup_id)?;
    let (next_config, next_auth) = restored_owned_files(&backup_dir, &manifest).map_err(|_| {
        SwitcherError::Message(
            "检测到未完成的配置写入，但无法安全构造恢复内容；请勿继续切换。".to_string(),
        )
    })?;
    write_bytes_atomically(&config_path()?, next_config.as_bytes()).map_err(|_| {
        SwitcherError::Message("检测到未完成的配置写入，但自动恢复失败；请勿继续切换。".to_string())
    })?;
    if let Some(next_auth) = next_auth {
        write_bytes_atomically(&auth_path()?, next_auth.as_bytes()).map_err(|_| {
            SwitcherError::Message(
                "检测到未完成的认证写入，但自动恢复失败；请勿继续切换。".to_string(),
            )
        })?;
    }
    complete_config_transaction()
}

fn list_backups() -> Result<Vec<BackupItem>, SwitcherError> {
    let dir = backups_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let file_names = fs::read_dir(&path)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|file_type| file_type.is_file())
                    .unwrap_or(false)
            })
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>();
        let files = file_names.len();
        let file_categories = backup_file_categories(&file_names);
        let label = entry.file_name().to_string_lossy().to_string();
        let metadata = entry.metadata()?;
        let modified = metadata.modified().ok();
        let fallback_time = modified
            .map(|_| label.trim_start_matches("before-").to_string())
            .unwrap_or_else(now_label);
        let manifest = fs::read_to_string(path.join("manifest.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<BackupManifest>(&text).ok());
        let (kind, retention_managed, restore_ready, restore_detail) = match manifest.as_ref() {
            Some(manifest) if !manifest.retention_managed && manifest.reason != "initial_install" => (
                "legacy_backup".to_string(),
                false,
                false,
                "这是旧版恢复目录，未纳入当前保留规则。不会自动删除；请先核对创建时间和文件数，再决定是否整理。".to_string(),
            ),
            Some(manifest) => match backup_manifest_health(&path, manifest) {
                Ok(()) => (
                    manifest.reason.clone(),
                    manifest.retention_managed,
                    true,
                    "需输入“恢复”确认；检测到外部修改时会停止，不会覆盖 MCP、插件和项目设置。"
                        .to_string(),
                ),
                Err(error) => (
                    manifest.reason.clone(),
                    manifest.retention_managed,
                    false,
                    format!("这个恢复点未通过完整性检查，无法自动恢复：{error}"),
                ),
            },
            None => (
                "invalid_backup".to_string(),
                false,
                false,
                "这是未完成或旧格式的备份目录，不是可恢复点；请在恢复中心的整理流程中查看。"
                    .to_string(),
            ),
        };
        items.push(BackupItem {
            id: label.clone(),
            time: manifest
                .as_ref()
                .map(|manifest| manifest.created_at.clone())
                .unwrap_or(fallback_time),
            label,
            files,
            file_categories,
            kind,
            retention_managed,
            restore_ready,
            restore_detail,
        });
    }
    items.sort_by(|a, b| {
        let a_initial = a.kind == "initial_install";
        let b_initial = b.kind == "initial_install";
        a_initial
            .cmp(&b_initial)
            .then_with(|| b.label.cmp(&a.label))
    });
    Ok(items)
}

fn backup_file_categories(file_names: &[String]) -> Vec<String> {
    let mut categories = BTreeSet::new();
    for file_name in file_names {
        let file_name = file_name.to_ascii_lowercase();
        if file_name.starts_with("config.toml") {
            categories.insert("Codex 设置".to_string());
        } else if file_name.starts_with("auth.json") {
            categories.insert("本机登录信息".to_string());
        } else if file_name.starts_with("profiles.json") {
            categories.insert("服务商目录".to_string());
        } else if file_name == "manifest.json" {
            categories.insert("恢复说明".to_string());
        }
    }
    categories.into_iter().collect()
}

fn activity_seed() -> ActivityItem {
    ActivityItem {
        id: "startup".to_string(),
        time: short_time(),
        title: "工作台已加载".to_string(),
        detail: "已从本地服务商目录和 Codex 配置读取状态。".to_string(),
        tone: "info".to_string(),
    }
}

fn load_activity() -> Result<Vec<ActivityItem>, SwitcherError> {
    ensure_dirs()?;
    let path = activity_path()?;
    if !path.exists() {
        return Ok(vec![activity_seed()]);
    }
    let text = fs::read_to_string(path)?;
    let mut items: Vec<ActivityItem> =
        serde_json::from_str(&text).unwrap_or_else(|_| vec![activity_seed()]);
    if items.is_empty() {
        items.push(activity_seed());
    }
    Ok(items)
}

fn save_activity(items: &[ActivityItem]) -> Result<(), SwitcherError> {
    ensure_dirs()?;
    fs::write(activity_path()?, serde_json::to_string_pretty(items)?)?;
    Ok(())
}

fn push_activity(title: &str, detail: &str, tone: &str) -> Result<(), SwitcherError> {
    let mut items = load_activity()?;
    items.insert(
        0,
        ActivityItem {
            id: format!("{}-{}", tone, Local::now().timestamp_millis()),
            time: short_time(),
            title: title.to_string(),
            detail: detail.to_string(),
            tone: tone.to_string(),
        },
    );
    items.truncate(50);
    save_activity(&items)
}

fn app_state_with_activity(
    title: &str,
    detail: &str,
    tone: &str,
) -> Result<AppState, SwitcherError> {
    push_activity(title, detail, tone)?;
    app_state()
}

fn app_state() -> Result<AppState, SwitcherError> {
    let catalog = load_catalog()?;
    let config = read_config().unwrap_or_default();
    let current_id = current_profile_id(&catalog, &config);
    let profiles = catalog_profiles(&catalog, &current_id);
    Ok(AppState {
        runtime_mode: "tauri_native".to_string(),
        current_profile_id: current_id,
        config_path: config_path()?.display().to_string(),
        auth_path: auth_path()?.display().to_string(),
        auto_start: catalog.auto_start,
        backup_policy: catalog.backup_policy.clone(),
        startup_notice: None,
        tray_enabled: false,
        safe_mode: true,
        configuration_drift: configuration_drift(&catalog, &config),
        profiles,
        model_catalogs: catalog_model_catalogs(&catalog),
        checks: app_validation_checks(&config),
        activity: load_activity()?,
        cost_calibrations: catalog.cost_calibrations.clone(),
        response_probes: catalog.response_probes.clone(),
        backups: list_backups()?,
        configuration_protection: configuration_protection(&config),
    })
}

fn startup_error_code(error: &SwitcherError) -> String {
    match error {
        SwitcherError::Io(io_error) => {
            format!("backup-io-{:?}", io_error.kind()).to_ascii_lowercase()
        }
        SwitcherError::Json(_) => "backup-auth-json".to_string(),
        SwitcherError::Toml(_) => "backup-config-toml".to_string(),
        SwitcherError::MissingHome => "backup-user-directory".to_string(),
        SwitcherError::Message(_) => "backup-safety-check".to_string(),
    }
}

fn record_startup_diagnostic(notice: &StartupNotice) {
    let Ok(path) = startup_diagnostics_path() else {
        return;
    };
    let mut diagnostics = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<StartupDiagnostic>>(&text).ok())
        .unwrap_or_default();
    diagnostics.insert(
        0,
        StartupDiagnostic {
            created_at: now_label(),
            phase: "daily_backup".to_string(),
            code: notice.code.clone(),
        },
    );
    diagnostics.truncate(20);
    let Ok(bytes) = serde_json::to_vec_pretty(&diagnostics) else {
        return;
    };
    let _ = write_bytes_atomically(&path, &bytes);
}

fn load_catalog_read_only() -> StoredCatalog {
    let Ok(path) = profiles_path() else {
        return seed_catalog_from_existing().unwrap_or_else(|_| StoredCatalog {
            version: default_version(),
            profiles: Map::new(),
            model_catalogs: Map::new(),
            cost_calibrations: Vec::new(),
            response_probes: Vec::new(),
            profile_order: Vec::new(),
            auto_start: false,
            backup_policy: default_backup_policy(),
            invariants: default_invariants(),
        });
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_json_document::<StoredCatalog>(&text).ok())
        .unwrap_or_else(|| {
            seed_catalog_from_existing().unwrap_or_else(|_| StoredCatalog {
                version: default_version(),
                profiles: Map::new(),
                model_catalogs: Map::new(),
                cost_calibrations: Vec::new(),
                response_probes: Vec::new(),
                profile_order: Vec::new(),
                auto_start: false,
                backup_policy: default_backup_policy(),
                invariants: default_invariants(),
            })
        })
}

fn startup_safe_state(notice: StartupNotice) -> Result<AppState, SwitcherError> {
    let catalog = load_catalog_read_only();
    let config = read_config().unwrap_or_default();
    let current_id = current_profile_id(&catalog, &config);
    Ok(AppState {
        runtime_mode: "tauri_native".to_string(),
        current_profile_id: current_id.clone(),
        config_path: config_path()?.display().to_string(),
        auth_path: auth_path()?.display().to_string(),
        auto_start: false,
        backup_policy: catalog.backup_policy.clone(),
        startup_notice: Some(notice),
        tray_enabled: false,
        safe_mode: true,
        configuration_drift: configuration_drift(&catalog, &config),
        profiles: catalog_profiles(&catalog, &current_id),
        model_catalogs: catalog_model_catalogs(&catalog),
        checks: app_validation_checks(&config),
        activity: load_activity().unwrap_or_else(|_| vec![activity_seed()]),
        cost_calibrations: catalog.cost_calibrations.clone(),
        response_probes: catalog.response_probes.clone(),
        backups: list_backups().unwrap_or_default(),
        configuration_protection: configuration_protection(&config),
    })
}

fn ensure_daily_backup() -> Result<bool, SwitcherError> {
    if ensure_initial_backup()? {
        return Ok(false);
    }
    let label = format!("daily-{}", Local::now().format("%Y%m%d"));
    if backups_dir()?.join(&label).join("manifest.json").exists() {
        return Ok(false);
    }
    create_backup_with_label(&label, "daily")?;
    Ok(true)
}

fn current_config_model(config_text: &str) -> Option<String> {
    toml::from_str::<toml::Value>(config_text)
        .ok()
        .and_then(|value| {
            value
                .get("model")
                .and_then(toml::Value::as_str)
                .map(ToString::to_string)
        })
}

fn configuration_drift(catalog: &StoredCatalog, config_text: &str) -> Option<ConfigurationDrift> {
    let profile_id = current_profile_id(catalog, config_text);
    if profile_id == "unknown" {
        return None;
    }
    let profile = catalog
        .profiles
        .get(&profile_id)
        .and_then(|value| serde_json::from_value::<StoredProfile>(value.clone()).ok())?;
    let current_model = current_config_model(config_text)?;
    if current_model.trim().is_empty() || current_model == profile.model {
        return None;
    }
    Some(ConfigurationDrift {
        profile_id,
        profile_name: profile.name,
        saved_model: profile.model,
        current_model: current_model.clone(),
        detail: format!("Codex 当前模型为 {current_model}，与保存的服务商模型不同。同步只更新切换器目录，不会写入 Codex 配置。"),
    })
}

fn model_tags(model_id: &str) -> Vec<String> {
    let id = model_id.to_ascii_lowercase();
    let mut tags = Vec::new();
    if id.contains("embedding") {
        tags.push("embedding".to_string());
    }
    if id.contains("audio") || id.contains("transcribe") || id.contains("tts") {
        tags.push("audio".to_string());
    }
    if id.contains("image") || id.contains("vision") || id.contains("vl") {
        tags.push("vision".to_string());
    }
    if id.contains("reason") || id.contains("thinking") || id.contains("o1") || id.contains("o3") {
        tags.push("reasoning".to_string());
    }
    if id.contains("gpt") || id.contains("chat") || id.contains("codex") {
        tags.push("responses-candidate".to_string());
    }
    tags
}

fn model_id_from_value(item: &Value) -> Option<String> {
    item.as_str()
        .or_else(|| item.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
}

fn parse_provider_models(body: &Value) -> Vec<ProviderModel> {
    let mut seen = BTreeSet::new();
    let empty = Vec::new();
    let items = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .or_else(|| body.as_array())
        .unwrap_or(&empty);
    let mut models = items
        .iter()
        .filter_map(model_id_from_value)
        .filter(|id| seen.insert(id.to_ascii_lowercase()))
        .map(|id| ProviderModel {
            tags: model_tags(&id),
            id,
            aliases: Vec::new(),
            source: "provider_models_api".to_string(),
            verified_for_responses: "unknown".to_string(),
        })
        .collect::<Vec<_>>();
    models.sort_by(|a, b| a.id.to_ascii_lowercase().cmp(&b.id.to_ascii_lowercase()));
    models
}

#[cfg(test)]
mod tests {
    use super::*;

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

fn build_model_catalog(
    provider_id: &str,
    profile: &StoredProfile,
    status: &str,
    detail: &str,
    models: Vec<ProviderModel>,
) -> ModelCatalog {
    ModelCatalog {
        provider_id: provider_id.to_string(),
        base_url: profile.base_url.clone(),
        fetched_at: Some(now_label()),
        status: status.to_string(),
        status_detail: detail.to_string(),
        models,
    }
}

fn fetch_provider_models(
    provider_id: &str,
    profile: &StoredProfile,
) -> Result<ModelCatalog, SwitcherError> {
    if profile.api_key.trim().is_empty() {
        return Ok(build_model_catalog(
            provider_id,
            profile,
            "missing_key",
            "缺少 API 密钥，无法刷新模型目录。",
            Vec::new(),
        ));
    }

    let base_url = profile.base_url.trim().trim_end_matches('/');
    if !base_url.starts_with("http") {
        return Ok(build_model_catalog(
            provider_id,
            profile,
            "provider_error",
            "接口地址无效，必须以 http 或 https 开头。",
            Vec::new(),
        ));
    }

    let url = format!("{base_url}/models");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|err| SwitcherError::Message(format!("创建 HTTP client 失败：{err}")))?;
    let response = match client.get(url).bearer_auth(profile.api_key.trim()).send() {
        Ok(response) => response,
        Err(err) => {
            return Ok(build_model_catalog(
                provider_id,
                profile,
                "network_error",
                &format!("模型目录请求失败：{err}"),
                Vec::new(),
            ));
        }
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("未知")
        .to_string();
    let final_url = response.url().to_string();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(build_model_catalog(
            provider_id,
            profile,
            "unauthorized",
            "API key 无效或权限不足，provider 拒绝返回模型列表。",
            Vec::new(),
        ));
    }
    if !status.is_success() {
        return Ok(build_model_catalog(
            provider_id,
            profile,
            "provider_error",
            &format!("provider 返回 HTTP {status}。"),
            Vec::new(),
        ));
    }

    let body: Value = match response.json() {
        Ok(value) => value,
        Err(err) => {
            return Ok(build_model_catalog(
                provider_id,
                profile,
                "provider_error",
                &format!(
                    "模型目录响应不是有效 JSON（content-type: {content_type}，最终地址: {final_url}）：{err}"
                ),
                Vec::new(),
            ));
        }
    };
    let models = parse_provider_models(&body);

    if models.is_empty() {
        let shape = if body.get("data").and_then(Value::as_array).is_some() {
            "data"
        } else if body.get("models").and_then(Value::as_array).is_some() {
            "models"
        } else if body.is_array() {
            "top_level_array"
        } else {
            "unknown_object"
        };
        return Ok(build_model_catalog(
            provider_id,
            profile,
            "empty_models",
            &format!(
                "provider 返回空模型列表（形状: {shape}，content-type: {content_type}，最终地址: {final_url}）。"
            ),
            Vec::new(),
        ));
    }

    Ok(build_model_catalog(
        provider_id,
        profile,
        "ok",
        &format!(
            "已刷新中转站实际返回的 {} 个模型；不会自动改写当前模型。",
            models.len()
        ),
        models,
    ))
}

fn verification_outcome(
    verified: bool,
    status: &str,
    stage: &str,
    detail: &str,
    http_status: Option<u16>,
    provider_code: Option<String>,
) -> ProviderVerificationOutcome {
    ProviderVerificationOutcome {
        verified,
        status: status.to_string(),
        detail: detail.to_string(),
        stage: stage.to_string(),
        http_status,
        provider_code,
        response_shape: None,
    }
}

fn inference_outcome(
    response_shape: &str,
    detail: &str,
    http_status: u16,
) -> ProviderVerificationOutcome {
    ProviderVerificationOutcome {
        verified: true,
        status: "verified".to_string(),
        detail: detail.to_string(),
        stage: "inference".to_string(),
        http_status: Some(http_status),
        provider_code: None,
        response_shape: Some(response_shape.to_string()),
    }
}

fn nonempty_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

fn has_provider_error(body: &Value) -> bool {
    body.get("error").is_some_and(|error| !error.is_null())
}

fn has_compatible_response_output(body: &Value) -> bool {
    if nonempty_text(body.get("output_text"))
        || nonempty_text(body.get("content"))
        || body
            .get("message")
            .is_some_and(|message| nonempty_text(message.get("content")))
    {
        return true;
    }

    if body
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|output| {
            output.iter().any(|item| {
                nonempty_text(item.get("text"))
                    || nonempty_text(item.get("content"))
                    || item
                        .get("content")
                        .and_then(Value::as_array)
                        .is_some_and(|content| {
                            content.iter().any(|part| nonempty_text(part.get("text")))
                        })
            })
        })
    {
        return true;
    }

    body.get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                nonempty_text(choice.get("text"))
                    || choice
                        .get("message")
                        .is_some_and(|message| nonempty_text(message.get("content")))
            })
        })
}

fn provider_probe_endpoint(base_url: &str, probe_path: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    let mut url = reqwest::Url::parse(trimmed)
        .map_err(|_| "接口地址不是有效的 http 或 https URL。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("接口地址必须以 http 或 https 开头。".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("接口地址不能包含查询参数或页面锚点。".to_string());
    }
    let base_path = url.path().trim_end_matches('/').to_string();
    if base_path.ends_with("/responses") || base_path.ends_with("/models") {
        return Err("接口地址应填写 API 基地址，不应包含 /responses 或 /models。".to_string());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    url.join(probe_path)
        .map(|endpoint| endpoint.to_string())
        .map_err(|_| "无法由接口地址构造服务商探针路径。".to_string())
}

fn provider_error_code(error_body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(error_body).ok()?;
    value
        .get("error")
        .and_then(|error| {
            error
                .get("code")
                .or_else(|| error.get("type"))
                .and_then(Value::as_str)
        })
        .or_else(|| value.get("code").and_then(Value::as_str))
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(ToString::to_string)
}

fn transport_failure_outcome(err: &reqwest::Error) -> ProviderVerificationOutcome {
    if err.is_timeout() {
        return verification_outcome(
            false,
            "timeout",
            "transport",
            "服务商响应超时，尚未确认可用性。",
            None,
            None,
        );
    }
    if err.is_connect() {
        return verification_outcome(
            false,
            "network_error",
            "transport",
            "无法建立连接；请检查 DNS、网络、TLS 或代理链路。",
            None,
            None,
        );
    }
    verification_outcome(
        false,
        "transport_error",
        "transport",
        "服务商请求在传输过程中失败，尚未确认可用性。",
        None,
        None,
    )
}

fn verify_provider_auth_probe(profile: &StoredProfile) -> ProviderVerificationOutcome {
    if profile.api_key.trim().is_empty() {
        return verification_outcome(
            false,
            "missing_key",
            "profile",
            "缺少 API 密钥，无法发送真实服务商请求。",
            None,
            None,
        );
    }
    if profile.model.trim().is_empty() {
        return verification_outcome(
            false,
            "invalid_profile",
            "profile",
            "缺少默认模型，无法发送与 Codex 相同的 Responses 请求。",
            None,
            None,
        );
    }
    let endpoint = match provider_probe_endpoint(&profile.base_url, "responses") {
        Ok(endpoint) => endpoint,
        Err(detail) => {
            return verification_outcome(false, "invalid_profile", "profile", &detail, None, None)
        }
    };

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return verification_outcome(
                false,
                "transport_error",
                "transport",
                &format!("创建验证连接失败：{err}"),
                None,
                None,
            );
        }
    };
    let request = client
        .post(endpoint)
        .bearer_auth(profile.api_key.trim())
        .json(&json!({
            "model": profile.model.trim(),
            "input": "Reply with OK.",
            "max_output_tokens": 16,
            "store": false,
        }));
    let response = match request.send() {
        Ok(response) => response,
        Err(err) => return transport_failure_outcome(&err),
    };

    let status = response.status();
    if status.is_success() {
        return match response.json::<Value>() {
            Ok(body) if has_provider_error(&body) => {
                provider_failure_outcome(Some(status.as_u16()), &body.to_string())
            }
            Ok(body) if body.get("id").is_some() => inference_outcome(
                "standard_responses",
                "可用性测试已通过：当前模型返回了标准 Responses 结果。本次检查不会写入 Codex 配置。",
                status.as_u16(),
            ),
            Ok(body) if has_compatible_response_output(&body) => inference_outcome(
                "compatible_response",
                "可用性测试已通过：当前模型返回了可识别的兼容响应。标准 Responses 形状尚未完全确认。",
                status.as_u16(),
            ),
            Ok(_) => verification_outcome(
                false,
                "response_shape_unconfirmed",
                "response_shape",
                "服务端已响应并返回 JSON，但本工具尚不能从中确认模型输出；这不代表服务商不能被 Codex 使用。",
                Some(status.as_u16()),
                None,
            ),
            Err(_) => verification_outcome(
                false,
                "response_unparseable",
                "response_shape",
                "服务端已响应，但返回内容无法按 JSON 解析；本工具无法确认模型输出。",
                Some(status.as_u16()),
                None,
            ),
        };
    }

    let error_body = response.text().unwrap_or_default();
    provider_failure_outcome(Some(status.as_u16()), &error_body)
}

fn provider_failure_outcome(
    http_status: Option<u16>,
    error_body: &str,
) -> ProviderVerificationOutcome {
    let error_text = error_body.to_ascii_lowercase();
    let provider_code = provider_error_code(error_body);
    let has_billing_signal = ["insufficient", "quota", "balance", "credit", "余额", "额度"]
        .iter()
        .any(|signal| error_text.contains(signal));
    let (status, stage, detail) = if has_billing_signal || http_status == Some(402) {
        (
            "billing_unavailable",
            "billing",
            "服务商余额、额度或配额不足，无法完成实际请求。",
        )
    } else {
        match http_status {
            Some(401 | 403) => (
                "unauthorized",
                "authentication",
                "API 密钥无效、权限不足或服务商拒绝了该请求。",
            ),
            Some(404 | 405) => (
                "endpoint_or_model_unavailable",
                "endpoint",
                "接口路径或当前模型不可用，服务商拒绝了 Responses 请求。",
            ),
            Some(400 | 415 | 422) => (
                "request_incompatible",
                "request",
                "服务商拒绝了认证探针请求。",
            ),
            Some(429) => (
                "rate_limited",
                "provider",
                "服务商当前限流，尚未确认可用性。",
            ),
            Some(code) if code >= 500 => (
                "service_error",
                "provider",
                "服务商发生服务端错误，尚未确认可用性。",
            ),
            None => (
                "protocol_incompatible",
                "response_format",
                "服务商返回了错误响应，但响应形状不兼容。",
            ),
            _ => (
                "provider_error",
                "provider",
                "服务商返回错误载荷，未确认可用性。",
            ),
        }
    };
    verification_outcome(false, status, stage, detail, http_status, provider_code)
}

fn apply_verification(profile: &mut StoredProfile, outcome: ProviderVerificationOutcome) {
    profile.verified = outcome.verified;
    profile.verification_status = outcome.status;
    profile.last_verified_at = Some(now_label());
    profile.last_verification_detail = Some(outcome.detail);
    profile.last_verification_stage = Some(outcome.stage);
    profile.last_verification_http_status = outcome.http_status;
    profile.last_verification_provider_code = outcome.provider_code;
    profile.verification_response_shape = outcome.response_shape;
}

fn reset_profile_verification(profile: &mut StoredProfile, detail: &str) {
    profile.verified = false;
    profile.verification_status = default_verification_status();
    profile.verification_response_shape = None;
    profile.last_verified_at = None;
    profile.last_verification_detail = Some(detail.to_string());
    profile.last_verification_stage = Some("profile".to_string());
    profile.last_verification_http_status = None;
    profile.last_verification_provider_code = None;
}

const COST_SCALE_DIGITS: u32 = 12;
const COST_SCALE: u128 = 1_000_000_000_000;

fn parse_fixed_decimal(value: &str, field_name: &str) -> Result<u128, SwitcherError> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.starts_with('+') {
        return Err(SwitcherError::Message(format!("{field_name} 必须是大于 0 的十进制数。")));
    }
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > COST_SCALE_DIGITS as usize
    {
        return Err(SwitcherError::Message(format!(
            "{field_name} 必须是最多 {COST_SCALE_DIGITS} 位小数的正十进制数。"
        )));
    }
    let whole = whole.parse::<u128>().map_err(|_| {
        SwitcherError::Message(format!("{field_name} 数值过大，无法安全计算。"))
    })?;
    let fraction_value = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<u128>().map_err(|_| {
            SwitcherError::Message(format!("{field_name} 数值无效。"))
        })?
    };
    let fraction_scale = 10_u128.pow(COST_SCALE_DIGITS - fraction.len() as u32);
    let scaled = whole
        .checked_mul(COST_SCALE)
        .and_then(|value| value.checked_add(fraction_value.checked_mul(fraction_scale)?))
        .ok_or_else(|| SwitcherError::Message(format!("{field_name} 数值过大，无法安全计算。")))?;
    if scaled == 0 {
        return Err(SwitcherError::Message(format!("{field_name} 必须大于 0。")));
    }
    Ok(scaled)
}

fn format_fixed_decimal(value: u128) -> String {
    let whole = value / COST_SCALE;
    let fraction = value % COST_SCALE;
    if fraction == 0 {
        return whole.to_string();
    }
    let fraction = format!("{fraction:0width$}", width = COST_SCALE_DIGITS as usize);
    format!("{whole}.{}", fraction.trim_end_matches('0'))
}

fn calculate_calibrated_cost(input: &CostCalibrationInput) -> Result<String, SwitcherError> {
    let paid = parse_fixed_decimal(&input.paid_cny, "实付金额")?;
    let credit = parse_fixed_decimal(&input.consumable_credit, "可消费额度")?;
    let debit = parse_fixed_decimal(&input.debit_credit, "后台最终扣费")?;
    let result = paid
        .checked_mul(debit)
        .ok_or_else(|| SwitcherError::Message("费用计算溢出，请缩小输入数值。".to_string()))?
        / credit;
    if result == 0 {
        return Err(SwitcherError::Message(
            "计算结果过小，无法在当前精度下保存。请提高输入精度。".to_string(),
        ));
    }
    Ok(format_fixed_decimal(result))
}

fn probe_usage(body: &Value) -> Option<ProbeUsage> {
    let usage = body.get("usage")?.as_object()?;
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(Value::as_u64);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(Value::as_u64);
    let total_tokens = usage.get("total_tokens").and_then(Value::as_u64);
    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        None
    } else {
        Some(ProbeUsage {
            input_tokens,
            output_tokens,
            total_tokens,
        })
    }
}

fn response_cost_candidate(body: &Value) -> Option<String> {
    ["total_cost", "total_cost_usd", "cost"]
        .iter()
        .find_map(|key| match body.get(*key) {
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
            Some(Value::Number(value)) => Some(value.to_string()),
            _ => None,
        })
}

fn response_header_id(headers: &reqwest::header::HeaderMap) -> Option<String> {
    ["x-request-id", "request-id"]
        .iter()
        .find_map(|name| headers.get(*name).and_then(|value| value.to_str().ok()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn push_probe_observation(catalog: &mut StoredCatalog, observation: ResponseProbeObservation) {
    catalog.response_probes.insert(0, observation);
    catalog.response_probes.truncate(100);
}

fn mark_catalog_model_verified(
    catalog: &mut StoredCatalog,
    provider_id: &str,
    model_id: &str,
) -> Result<(), SwitcherError> {
    let Some(value) = catalog.model_catalogs.get(provider_id).cloned() else {
        return Ok(());
    };
    let Ok(mut model_catalog) = serde_json::from_value::<ModelCatalog>(value) else {
        return Ok(());
    };
    if model_catalog.status != "ok" {
        return Ok(());
    }
    if let Some(model) = model_catalog
        .models
        .iter_mut()
        .find(|model| model.id.eq_ignore_ascii_case(model_id.trim()))
    {
        model.verified_for_responses = "verified".to_string();
        catalog.model_catalogs.insert(
            provider_id.to_string(),
            serde_json::to_value(model_catalog)?,
        );
    }
    Ok(())
}

fn invalidate_catalog_model_verifications(catalog: &mut StoredCatalog, provider_id: &str) {
    let Some(value) = catalog.model_catalogs.get(provider_id).cloned() else {
        return;
    };
    let Ok(mut model_catalog) = serde_json::from_value::<ModelCatalog>(value) else {
        return;
    };
    for model in &mut model_catalog.models {
        model.verified_for_responses = "unknown".to_string();
    }
    if let Ok(value) = serde_json::to_value(model_catalog) {
        catalog
            .model_catalogs
            .insert(provider_id.to_string(), value);
    }
}

fn preserve_catalog_model_verifications(previous: Option<&Value>, next: &mut ModelCatalog) {
    let Some(previous) = previous else {
        return;
    };
    let Ok(previous) = serde_json::from_value::<ModelCatalog>(previous.clone()) else {
        return;
    };
    if previous.status != "ok" || previous.base_url != next.base_url {
        return;
    }
    for model in &mut next.models {
        if previous.models.iter().any(|previous_model| {
            previous_model.id.eq_ignore_ascii_case(&model.id)
                && previous_model.verified_for_responses == "verified"
        }) {
            model.verified_for_responses = "verified".to_string();
        }
    }
}

fn normalized_release_version(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

pub fn check_for_update_core() -> Result<UpdateInfo, SwitcherError> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let current = Version::parse(&current_version)
        .map_err(|err| SwitcherError::Message(format!("当前应用版本无效：{err}")))?;
    let releases_url = env::var(RELEASES_API_ENV).unwrap_or_else(|_| RELEASES_API_URL.to_string());
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| SwitcherError::Message(format!("创建更新检查连接失败：{err}")))?;
    let response = client
        .get(releases_url)
        .header("User-Agent", "CodeX-Provider-Switcher")
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|err| SwitcherError::Message(format!("无法连接更新服务：{err}")))?;
    if !response.status().is_success() {
        return Err(SwitcherError::Message(format!(
            "更新服务返回 HTTP {}。",
            response.status()
        )));
    }
    let releases: Vec<GithubRelease> = response
        .json()
        .map_err(|err| SwitcherError::Message(format!("更新信息格式无效：{err}")))?;
    let latest = releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            normalized_release_version(&release.tag_name).map(|version| (version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .ok_or_else(|| SwitcherError::Message("更新服务没有可用版本。".to_string()))?;
    let download_url = latest
        .1
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.contains("windows-x64") && name.ends_with("-setup.exe")
        })
        .map(|asset| asset.browser_download_url.clone());

    Ok(UpdateInfo {
        current_version,
        latest_version: latest.0.to_string(),
        available: latest.0 > current,
        release_url: latest.1.html_url,
        download_url,
        published_at: latest.1.published_at,
    })
}

fn create_backup_with_label(label: &str, reason: &str) -> Result<PathBuf, SwitcherError> {
    let backup_root = backups_dir()?;
    fs::create_dir_all(&backup_root)?;
    let dir = backup_root.join(label);
    if dir.exists() {
        return Err(SwitcherError::Message(
            "恢复点标识已存在，已拒绝覆盖现有备份。".to_string(),
        ));
    }
    let mut staging = BackupStaging::new(backup_root.join(format!(
        ".{label}-{}-{}.staging",
        std::process::id(),
        Local::now().timestamp_nanos_opt().unwrap_or_default()
    )));
    fs::create_dir(&staging.path)?;
    let sources = [("config.toml", config_path()?), ("auth.json", auth_path()?)];
    let mut files = Vec::new();
    let mut missing_files = Vec::new();
    let mut file_digests = BTreeMap::new();
    for (name, source) in sources {
        if source.exists() {
            let protected_name = format!("{name}{PROTECTED_FILE_SUFFIX}");
            protect_file(&source, &staging.path.join(&protected_name))?;
            let protected = fs::read(staging.path.join(&protected_name))?;
            file_digests.insert(protected_name.clone(), bytes_digest(&protected));
            files.push(protected_name);
        } else {
            missing_files.push(name.to_string());
        }
    }
    let snapshot_fingerprint = if missing_files.is_empty() {
        Some(owned_configuration_fingerprint(
            &fs::read_to_string(config_path()?)?,
            &fs::read_to_string(auth_path()?)?,
        )?)
    } else {
        None
    };
    let manifest = BackupManifest {
        schema_version: 4,
        created_at: now_label(),
        reason: reason.to_string(),
        files,
        missing_files,
        post_change_fingerprint: None,
        snapshot_fingerprint,
        file_digests,
        retention_managed: true,
    };
    write_bytes_atomically(
        &staging.path.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?.as_bytes(),
    )?;
    if manifest.missing_files.is_empty() {
        backup_manifest_health(&staging.path, &manifest)?;
    }
    fs::rename(&staging.path, &dir)?;
    staging.commit();
    let _ = prune_managed_backups(reason, label);
    Ok(dir)
}

fn pending_backup_id() -> Option<String> {
    let text = fs::read_to_string(pending_transaction_path().ok()?).ok()?;
    serde_json::from_str::<PendingConfigTransaction>(&text)
        .ok()
        .map(|transaction| transaction.backup_id)
}

fn backup_retention_bucket(reason: &str, policy: &BackupPolicy) -> Option<(&'static str, usize)> {
    match reason {
        "daily" | "before_switch" | "before_restore" => {
            Some(("automatic", normalized_backup_limit(policy.automatic_limit)))
        }
        "manual" => Some(("manual", normalized_backup_limit(policy.manual_limit))),
        _ => None,
    }
}

fn prune_managed_backups(
    created_reason: &str,
    protected_label: &str,
) -> Result<usize, SwitcherError> {
    let policy = load_catalog()?.backup_policy;
    let Some((bucket, limit)) = backup_retention_bucket(created_reason, &policy) else {
        return Ok(0);
    };
    let pending = pending_backup_id();
    let mut candidates = Vec::new();
    for entry in fs::read_dir(backups_dir()?)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let Ok(text) = fs::read_to_string(path.join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<BackupManifest>(&text) else {
            continue;
        };
        let Some((candidate_bucket, _)) = backup_retention_bucket(&manifest.reason, &policy) else {
            continue;
        };
        if manifest.retention_managed && candidate_bucket == bucket {
            candidates.push((entry.file_name().to_string_lossy().to_string(), path));
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    if let Some(index) = candidates
        .iter()
        .position(|(label, _)| label == protected_label)
    {
        let protected = candidates.remove(index);
        candidates.insert(0, protected);
    }
    let mut removed = 0;
    for (label, path) in candidates.into_iter().skip(limit) {
        if label == protected_label || pending.as_deref() == Some(label.as_str()) {
            continue;
        }
        if fs::remove_dir_all(path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn managed_manual_backup_count() -> Result<usize, SwitcherError> {
    Ok(fs::read_dir(backups_dir()?)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| fs::read_to_string(entry.path().join("manifest.json")).ok())
        .filter_map(|text| serde_json::from_str::<BackupManifest>(&text).ok())
        .filter(|manifest| manifest.reason == "manual" && manifest.retention_managed)
        .count())
}

struct BackupStaging {
    path: PathBuf,
    committed: bool,
}

impl BackupStaging {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for BackupStaging {
    fn drop(&mut self) {
        if !self.committed && self.path.exists() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn ensure_initial_backup() -> Result<bool, SwitcherError> {
    let initial_dir = backups_dir()?.join(INITIAL_BACKUP_LABEL);
    if initial_dir.join("manifest.json").exists() {
        return Ok(false);
    }
    create_backup_with_label(INITIAL_BACKUP_LABEL, "initial_install")?;
    Ok(true)
}

fn create_backup() -> Result<PathBuf, SwitcherError> {
    ensure_initial_backup()?;
    let label = unique_backup_label("before");
    create_backup_with_label(&label, "before_switch")
}

fn unique_backup_label(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        std::process::id(),
        Local::now().timestamp_subsec_micros()
    )
}

fn replace_root_kv(line: &str, key: &str, value: &str) -> Option<String> {
    if line.trim_start().starts_with(&format!("{key} =")) {
        Some(format!("{key} = \"{value}\""))
    } else {
        None
    }
}

fn root_section_end(lines: &[String]) -> usize {
    lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len())
}

fn upsert_root_string(lines: &mut Vec<String>, key: &str, value: &str) {
    let root_end = root_section_end(lines);
    for line in lines.iter_mut().take(root_end) {
        if let Some(next) = replace_root_kv(line, key, value) {
            *line = next;
            return;
        }
    }
    let insert_at = lines
        .iter()
        .take(root_end)
        .position(|line| line.trim_start().starts_with("model_provider ="))
        .map(|idx| idx + 1)
        .unwrap_or(root_end);
    lines.insert(insert_at, format!("{key} = \"{value}\""));
}

fn upsert_root_bool(lines: &mut Vec<String>, key: &str, value: bool) {
    let root_end = root_section_end(lines);
    for line in lines.iter_mut().take(root_end) {
        if line.trim_start().starts_with(&format!("{key} =")) {
            *line = format!("{key} = {}", if value { "true" } else { "false" });
            return;
        }
    }
    let insert_at = lines
        .iter()
        .take(root_end)
        .position(|line| line.trim_start().starts_with("model ="))
        .map(|idx| idx + 1)
        .unwrap_or(root_end);
    lines.insert(
        insert_at,
        format!("{key} = {}", if value { "true" } else { "false" }),
    );
}

fn remove_root_key(lines: &mut Vec<String>, key: &str) {
    let root_end = root_section_end(lines);
    let prefix = format!("{key} ");
    let mut index = 0usize;
    lines.retain(|line| {
        let retain = index >= root_end || !line.trim_start().starts_with(&prefix);
        index += 1;
        retain
    });
}

fn upsert_section_string(
    lines: &mut Vec<String>,
    start: usize,
    end: &mut usize,
    key: &str,
    value: &str,
) {
    let replacement = format!("{key} = {}", toml::Value::String(value.to_string()));
    for line in lines.iter_mut().take(*end).skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed
            .strip_prefix(key)
            .is_some_and(|suffix| suffix.trim_start().starts_with('='))
        {
            *line = replacement;
            return;
        }
    }
    lines.insert(*end, replacement);
    *end += 1;
}

fn upsert_section_bool(
    lines: &mut Vec<String>,
    start: usize,
    end: &mut usize,
    key: &str,
    value: bool,
) {
    let replacement = format!("{key} = {}", if value { "true" } else { "false" });
    for line in lines.iter_mut().take(*end).skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed
            .strip_prefix(key)
            .is_some_and(|suffix| suffix.trim_start().starts_with('='))
        {
            *line = replacement;
            return;
        }
    }
    lines.insert(*end, replacement);
    *end += 1;
}

fn remove_section_key(lines: &mut Vec<String>, start: usize, end: &mut usize, key: &str) {
    if let Some(index) = lines
        .iter()
        .enumerate()
        .take(*end)
        .skip(start + 1)
        .find_map(|(index, line)| {
            line.trim_start()
                .strip_prefix(key)
                .is_some_and(|suffix| suffix.trim_start().starts_with('='))
                .then_some(index)
        })
    {
        lines.remove(index);
        *end -= 1;
    }
}

fn build_next_config(original: &str, profile: &StoredProfile) -> Result<String, SwitcherError> {
    let mut lines: Vec<String> = original.lines().map(ToString::to_string).collect();
    toml::from_str::<toml::Value>(original)?;
    let uses_profile_credential = !profile.api_key.trim().is_empty();

    upsert_root_string(&mut lines, "model", &profile.model);
    upsert_root_string(&mut lines, "model_provider", "custom");
    upsert_root_string(
        &mut lines,
        "model_reasoning_effort",
        &profile.model_reasoning_effort,
    );
    upsert_root_bool(&mut lines, "disable_response_storage", true);

    let start = lines
        .iter()
        .position(|line| line.trim() == "[model_providers.custom]")
        .ok_or_else(|| {
            SwitcherError::Message("缺少 [model_providers.custom] 配置段。".to_string())
        })?;
    let mut end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(idx, _)| idx)
        .unwrap_or(lines.len());

    upsert_section_string(&mut lines, start, &mut end, "name", &profile.name);
    upsert_section_string(&mut lines, start, &mut end, "wire_api", "responses");
    upsert_section_bool(
        &mut lines,
        start,
        &mut end,
        "requires_openai_auth",
        !uses_profile_credential,
    );
    upsert_section_string(&mut lines, start, &mut end, "base_url", &profile.base_url);
    for key in ["api_key", "env_key", "experimental_bearer_token"] {
        remove_section_key(&mut lines, start, &mut end, key);
    }
    let next_config = lines.join("\r\n");
    let checks = validation_checks(&next_config);
    if checks
        .iter()
        .any(|check| !check.ok && check.severity == "required")
    {
        return Err(SwitcherError::Message("写入前配置验证失败。".to_string()));
    }
    if !protected_sections_match(original, &next_config)?
        || !only_provider_owned_configuration_changed(original, &next_config)?
    {
        return Err(SwitcherError::Message(
            "切换已阻止：检测到 MCP、插件、项目或其他受保护设置会被改动。".to_string(),
        ));
    }
    Ok(next_config)
}

fn build_next_auth(original: &str, profile: &StoredProfile) -> Result<String, SwitcherError> {
    let mut auth = serde_json::from_str::<Value>(original)?;
    let object = auth.as_object_mut().ok_or_else(|| {
        SwitcherError::Message("auth.json 必须是 JSON 对象，无法安全写入。".to_string())
    })?;
    if profile.api_key.trim().is_empty() {
        return Ok(serde_json::to_string_pretty(&auth)?);
    }
    object.insert(
        "OPENAI_API_KEY".to_string(),
        Value::String(profile.api_key.trim().to_string()),
    );
    Ok(serde_json::to_string_pretty(&auth)?)
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
    let original_auth_text = fs::read_to_string(&auth)?;
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
    let fingerprint = owned_configuration_fingerprint(&next_config, &next_auth)?;
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

#[tauri::command]
fn check_for_update() -> Result<UpdateInfo, SwitcherError> {
    check_for_update_core()
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
    let id = if profile.id.trim().is_empty() {
        normalize_id(&profile.name)
    } else {
        profile.id.trim().to_string()
    };
    if id.is_empty() {
        return Err(SwitcherError::Message("服务商名称不能为空。".to_string()));
    }
    if profile.name.trim().is_empty() {
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
        catalog.profile_order.push(id);
    }
    invalidate_catalog_model_verifications(&mut catalog, &profile.id);
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
    apply_verification(&mut profile, verification);
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

#[tauri::command]
fn verify_profile(profile_id: String) -> Result<AppState, SwitcherError> {
    verify_profile_core(profile_id)
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
    apply_verification(&mut profile, verification);
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

#[tauri::command]
fn run_response_probe(profile_id: String) -> Result<AppState, SwitcherError> {
    run_response_probe_core(profile_id)
}

pub fn run_response_probe_core(profile_id: String) -> Result<AppState, SwitcherError> {
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
    if profile.model.trim().is_empty() {
        return Err(SwitcherError::Message(
            "缺少默认模型，无法运行返回能力探针。".to_string(),
        ));
    }
    let endpoint = provider_probe_endpoint(&profile.base_url, "responses")
        .map_err(SwitcherError::Message)?;
    let observed_at = now_label();
    let mut observation = ResponseProbeObservation {
        id: format!("response-probe-{}", Local::now().timestamp_millis()),
        provider_id: profile_id.clone(),
        provider_name: profile.name.clone(),
        model: profile.model.clone(),
        probe_version: "response-observation-v1".to_string(),
        observed_at: observed_at.clone(),
        status: "failed".to_string(),
        http_status: None,
        request_id: None,
        response_id: None,
        usage: None,
        cost_candidate: None,
        detail: "探针未完成。".to_string(),
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| SwitcherError::Message(format!("创建探针连接失败：{err}")))?;
    let response = client
        .post(endpoint)
        .bearer_auth(profile.api_key.trim())
        .json(&json!({
            "model": profile.model.trim(),
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
            if response.status().is_success() {
                match response.json::<Value>() {
                    Ok(body) => {
                        observation.response_id = body
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string);
                        observation.usage = probe_usage(&body);
                        observation.cost_candidate = response_cost_candidate(&body);
                        if observation.cost_candidate.is_some() {
                            observation.status = "final_cost_inline".to_string();
                            observation.detail = "响应中返回了费用候选字段；仍需核对平台币种和账单规则后再用于费用校准。".to_string();
                        } else if observation.usage.is_some() {
                            observation.status = "usage_only".to_string();
                            observation.detail = "响应包含用量字段，可与服务商后台日志交叉核对。".to_string();
                        } else if observation.request_id.is_some() || observation.response_id.is_some() {
                            observation.status = "correlation_only".to_string();
                            observation.detail = "已获得关联 ID，可到服务商后台定位本次调用。".to_string();
                        } else {
                            observation.status = "no_signal".to_string();
                            observation.detail = "服务商已响应，但没有返回可安全保存的费用、用量或关联线索。".to_string();
                        }
                    }
                    Err(_) => {
                        observation.detail = "服务商已响应，但返回体无法按 JSON 解析；未保存完整响应。".to_string();
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
            observation.detail = "无法建立服务商连接；请检查网络、DNS、TLS 或代理链路。".to_string();
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
        if succeeded && status != "no_signal" { "success" } else { "warning" },
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
fn refresh_models(profile_id: String) -> Result<AppState, SwitcherError> {
    refresh_models_core(profile_id)
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
    let mut model_catalog = fetch_provider_models(&profile_id, &profile)?;
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
        .invoke_handler(tauri::generate_handler![
            load_state,
            check_for_update,
            save_profile,
            delete_profile,
            reorder_profiles,
            prepare_switch,
            switch_profile,
            verify_profile,
            run_response_probe,
            save_cost_calibration,
            refresh_models,
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

    fn calibration_input(paid_cny: &str, consumable_credit: &str, debit_credit: &str) -> CostCalibrationInput {
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
        assert!(calculate_calibrated_cost(&calibration_input("1.0000000000001", "1", "1")).is_err());
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
