use chrono::Local;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::BTreeSet, env, fs, path::PathBuf, time::Duration};
use thiserror::Error;

const APP_DIR_NAME: &str = "CodeX Provider Switcher";
const PROFILES_FILE: &str = "profiles.json";
const ACTIVITY_FILE: &str = "activity.json";
const BACKUPS_DIR: &str = "backups";
const CODEX_HOME_ENV: &str = "CODEX_PROVIDER_SWITCHER_CODEX_HOME";
const APP_DATA_DIR_ENV: &str = "CODEX_PROVIDER_SWITCHER_APP_DATA_DIR";
const RELEASES_API_ENV: &str = "CODEX_PROVIDER_SWITCHER_RELEASES_API";
const RELEASES_API_URL: &str =
    "https://api.github.com/repos/ga626/codex-provider-switcher/releases?per_page=20";

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
pub struct BackupItem {
    pub id: String,
    pub time: String,
    pub label: String,
    pub files: usize,
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
    pub tray_enabled: bool,
    pub safe_mode: bool,
    pub profiles: Vec<ProviderProfile>,
    pub model_catalogs: Vec<ModelCatalog>,
    pub checks: Vec<ValidationCheck>,
    pub activity: Vec<ActivityItem>,
    pub backups: Vec<BackupItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProfile {
    name: String,
    base_url: String,
    api_key: String,
    model: String,
    #[serde(default = "default_reasoning")]
    model_reasoning_effort: String,
    #[serde(default)]
    verified: bool,
    #[serde(default = "default_verification_status")]
    verification_status: String,
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

#[derive(Debug, Clone)]
struct ProviderVerificationOutcome {
    verified: bool,
    status: String,
    detail: String,
    stage: String,
    http_status: Option<u16>,
    provider_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCatalog {
    #[serde(default = "default_version")]
    version: String,
    profiles: Map<String, Value>,
    #[serde(default)]
    model_catalogs: Map<String, Value>,
    #[serde(default)]
    auto_start: bool,
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

fn ensure_dirs() -> Result<(), SwitcherError> {
    fs::create_dir_all(app_data_dir()?)?;
    fs::create_dir_all(backups_dir()?)?;
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
    let mut profiles = Map::new();
    profiles.insert(
        "owl".to_string(),
        json!({
            "name": "OWL",
            "base_url": "https://api.owlai.tech/v1",
            "api_key": "",
            "model": "",
            "model_reasoning_effort": "high",
            "verified": false,
            "default": true,
            "note": "Default baseline."
        }),
    );
    Ok(StoredCatalog {
        version: default_version(),
        profiles,
        model_catalogs: Map::new(),
        auto_start: false,
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
    let path = profiles_path()?;
    if !path.exists() {
        let catalog = seed_catalog_from_existing()?;
        save_catalog(&catalog)?;
        return Ok(catalog);
    }
    let text = fs::read_to_string(path)?;
    let mut catalog: StoredCatalog = serde_json::from_str(&text)?;
    normalize_catalog(&mut catalog);
    Ok(catalog)
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
}

fn save_catalog(catalog: &StoredCatalog) -> Result<(), SwitcherError> {
    ensure_dirs()?;
    let text = serde_json::to_string_pretty(catalog)?;
    fs::write(profiles_path()?, text)?;
    Ok(())
}

fn read_config() -> Result<String, SwitcherError> {
    Ok(fs::read_to_string(config_path()?)?)
}

fn current_profile_id(catalog: &StoredCatalog, config_text: &str) -> String {
    for (id, value) in &catalog.profiles {
        if let Ok(profile) = serde_json::from_value::<StoredProfile>(value.clone()) {
            if config_text.contains(&format!("base_url = \"{}\"", profile.base_url)) {
                return id.to_string();
            }
        }
    }
    "unknown".to_string()
}

fn catalog_profiles(catalog: &StoredCatalog, current_id: &str) -> Vec<ProviderProfile> {
    catalog
        .profiles
        .iter()
        .filter_map(|(id, value)| {
            serde_json::from_value::<StoredProfile>(value.clone())
                .ok()
                .map(|profile| ProviderProfile {
                    id: id.clone(),
                    name: profile.name,
                    base_url: profile.base_url,
                    model: profile.model,
                    reasoning_effort: profile.model_reasoning_effort,
                    note: profile.note,
                    verified: profile.verified && profile.verification_status == "verified",
                    verification_status: profile.verification_status,
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
                "required",
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
                "required",
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
                "required",
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
                "required",
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
                "required",
            ));
            let api_key = custom
                .and_then(|v| v.get("api_key"))
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            checks.push(check(
                "custom-api-key",
                "当前认证密钥",
                !api_key.trim().is_empty(),
                if !api_key.trim().is_empty() {
                    "custom 服务商已配置 api_key。"
                } else {
                    "custom 服务商缺少 api_key，切换后无法认证。"
                },
                "required",
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

fn check(id: &str, label: &str, ok: bool, detail: &str, severity: &str) -> ValidationCheck {
    ValidationCheck {
        id: id.to_string(),
        label: label.to_string(),
        ok,
        detail: detail.to_string(),
        severity: severity.to_string(),
    }
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
        let files = fs::read_dir(&path)?
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .count();
        let label = entry.file_name().to_string_lossy().to_string();
        let metadata = entry.metadata()?;
        let modified = metadata.modified().ok();
        let time = modified
            .map(|_| label.trim_start_matches("before-").to_string())
            .unwrap_or_else(now_label);
        items.push(BackupItem {
            id: label.clone(),
            time,
            label,
            files,
        });
    }
    items.sort_by(|a, b| b.label.cmp(&a.label));
    Ok(items)
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
        tray_enabled: false,
        safe_mode: true,
        profiles,
        model_catalogs: catalog_model_catalogs(&catalog),
        checks: validation_checks(&config),
        activity: load_activity()?,
        backups: list_backups()?,
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
                &format!("模型目录响应不是有效 JSON：{err}"),
                Vec::new(),
            ));
        }
    };
    let models = parse_provider_models(&body);

    if models.is_empty() {
        return Ok(build_model_catalog(
            provider_id,
            profile,
            "empty_models",
            "provider 返回了空模型列表。",
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
    }
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
        .timeout(Duration::from_secs(25))
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
            Ok(body) if body.get("error").is_none() && body.get("id").is_some() => {
                verification_outcome(
                    true,
                    "verified",
                    "authenticated_response_probe",
                    "已完成真实、已认证的 Responses 请求；服务可用。本次检查不会写入 Codex 配置。",
                    Some(status.as_u16()),
                    None,
                )
            }
            Ok(_) => verification_outcome(
                false,
                "protocol_incompatible",
                "response_format",
                "服务商返回了 JSON，但缺少 Responses 响应标识，未确认可用性。",
                Some(status.as_u16()),
                None,
            ),
            Err(_) => verification_outcome(
                false,
                "protocol_incompatible",
                "response_format",
                "服务商探针没有返回兼容的 JSON 响应，未确认可用性。",
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

fn create_backup() -> Result<PathBuf, SwitcherError> {
    let label = format!("before-{}", Local::now().format("%Y%m%d-%H%M%S"));
    let dir = backups_dir()?.join(label);
    fs::create_dir_all(&dir)?;
    let config = config_path()?;
    let mut files = Vec::new();
    if config.exists() {
        fs::copy(&config, dir.join("config.toml"))?;
        files.push("config.toml");
    }
    let auth = auth_path()?;
    if auth.exists() {
        fs::copy(&auth, dir.join("auth.json"))?;
        files.push("auth.json");
    }
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&json!({
            "schema_version": 1,
            "created_at": now_label(),
            "reason": "before_switch",
            "files": files,
        }))?,
    )?;
    Ok(dir)
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

fn switch_config(profile: &StoredProfile) -> Result<(), SwitcherError> {
    let original = read_config()?;
    let _backup = create_backup()?;
    let mut lines: Vec<String> = original.lines().map(ToString::to_string).collect();

    upsert_root_string(&mut lines, "model", &profile.model);
    upsert_root_string(&mut lines, "model_provider", "custom");
    upsert_root_bool(&mut lines, "disable_response_storage", true);

    let start = lines
        .iter()
        .position(|line| line.trim() == "[model_providers.custom]")
        .ok_or_else(|| {
            SwitcherError::Message("缺少 [model_providers.custom] 配置段。".to_string())
        })?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(idx, _)| idx)
        .unwrap_or(lines.len());

    let provider_lines = vec![
        "[model_providers.custom]".to_string(),
        format!("name = \"{}\"", profile.name),
        "wire_api = \"responses\"".to_string(),
        "requires_openai_auth = true".to_string(),
        format!("base_url = \"{}\"", profile.base_url),
        format!("api_key = \"{}\"", profile.api_key),
    ];
    lines.splice(start..end, provider_lines);
    let next_config = lines.join("\r\n");
    let checks = validation_checks(&next_config);
    if checks
        .iter()
        .any(|check| !check.ok && check.severity == "required")
    {
        return Err(SwitcherError::Message(
            "写入前配置验证失败；备份已保留。".to_string(),
        ));
    }
    fs::write(config_path()?, next_config)?;
    write_auth_key(&profile.api_key)?;
    Ok(())
}

fn write_auth_key(api_key: &str) -> Result<(), SwitcherError> {
    let path = auth_path()?;
    let mut value = if path.exists() {
        serde_json::from_str::<Value>(&fs::read_to_string(&path)?)?
    } else {
        json!({})
    };
    value["OPENAI_API_KEY"] = Value::String(api_key.to_string());
    fs::write(path, serde_json::to_string_pretty(&value)?)?;
    Ok(())
}

#[tauri::command]
fn load_state() -> Result<AppState, SwitcherError> {
    load_state_core()
}

#[tauri::command]
fn check_for_update() -> Result<UpdateInfo, SwitcherError> {
    check_for_update_core()
}

pub fn load_state_core() -> Result<AppState, SwitcherError> {
    app_state()
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
    let stored = StoredProfile {
        name: profile.name.trim().to_string(),
        base_url: profile.base_url.trim().to_string(),
        api_key,
        model: profile.model.trim().to_string(),
        model_reasoning_effort: existing_profile
            .as_ref()
            .map(|p| p.model_reasoning_effort.clone())
            .unwrap_or_else(default_reasoning),
        verified: false,
        verification_status: default_verification_status(),
        default: existing_profile
            .as_ref()
            .map(|p| p.default)
            .unwrap_or(false),
        note: profile.note.trim().to_string(),
        last_switched_at: existing_profile
            .as_ref()
            .and_then(|p| p.last_switched_at.clone()),
        last_verified_at: None,
        last_verification_detail: Some("保存后尚未运行真实服务商检查。".to_string()),
        last_verification_stage: Some("profile".to_string()),
        last_verification_http_status: None,
        last_verification_provider_code: None,
    };
    let display_name = stored.name.clone();
    catalog.profiles.insert(id, serde_json::to_value(stored)?);
    invalidate_catalog_model_verifications(&mut catalog, &profile.id);
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已保存"),
        "服务商信息已更新；已清除旧验证，需要重新运行真实服务商检查。",
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
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("{display_name} 已删除"),
        "该服务商已从切换目录移除；当前和默认服务商不会被删除。",
        "warning",
    )
}

#[tauri::command]
fn switch_profile(profile_id: String) -> Result<AppState, SwitcherError> {
    switch_profile_core(profile_id)
}

pub fn switch_profile_core(profile_id: String) -> Result<AppState, SwitcherError> {
    let mut catalog = load_catalog()?;
    let value = catalog
        .profiles
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| SwitcherError::Message("未找到服务商配置。".to_string()))?;
    let mut profile: StoredProfile = serde_json::from_value(value)?;
    let display_name = profile.name.clone();
    let verification = verify_provider_auth_probe(&profile);
    if !verification.verified {
        let detail = verification.detail.clone();
        apply_verification(&mut profile, verification);
        catalog
            .profiles
            .insert(profile_id, serde_json::to_value(profile)?);
        save_catalog(&catalog)?;
        push_activity(
            "切换已阻止",
            &format!("{display_name} 未通过实时服务商验证：{detail}"),
            "warning",
        )?;
        return Err(SwitcherError::Message(format!("切换已阻止：{detail}")));
    }
    apply_verification(&mut profile, verification);
    mark_catalog_model_verified(&mut catalog, &profile_id, &profile.model)?;
    if profile.model.trim().is_empty() {
        let detail = "缺少 Codex 使用的模型名称；服务商已验证，但不能写入空模型。";
        catalog
            .profiles
            .insert(profile_id, serde_json::to_value(profile)?);
        save_catalog(&catalog)?;
        push_activity("切换已阻止", detail, "warning")?;
        return Err(SwitcherError::Message(format!("切换已阻止：{detail}")));
    }
    switch_config(&profile)?;
    profile.last_switched_at = Some(now_label());
    catalog
        .profiles
        .insert(profile_id, serde_json::to_value(profile)?);
    save_catalog(&catalog)?;
    app_state_with_activity(
        &format!("已切换到 {display_name}"),
        "已写入 Codex config.toml/auth.json，并生成回滚备份。",
        "success",
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
            "验证完成",
            &format!("{display_name} 已通过真实、已认证的服务端探针。"),
            "success",
        )
    } else {
        app_state_with_activity(
            "验证需要处理",
            &format!("{display_name} 未通过真实服务商验证：{detail}"),
            "warning",
        )
    }
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
fn toggle_auto_start(enabled: bool) -> Result<AppState, SwitcherError> {
    toggle_auto_start_core(enabled)
}

pub fn toggle_auto_start_core(_enabled: bool) -> Result<AppState, SwitcherError> {
    Err(SwitcherError::Message(
        "开机自启动尚未接入 Windows 启动项读写；当前版本不开放这个主功能。".to_string(),
    ))
}

#[tauri::command]
fn restore_latest_backup() -> Result<AppState, SwitcherError> {
    restore_latest_backup_core()
}

pub fn restore_latest_backup_core() -> Result<AppState, SwitcherError> {
    let backups = list_backups()?;
    let latest = backups
        .first()
        .ok_or_else(|| SwitcherError::Message("当前没有可恢复的备份。".to_string()))?;
    let backup_dir = backups_dir()?.join(&latest.label);
    let backup_config = backup_dir.join("config.toml");
    let backup_auth = backup_dir.join("auth.json");
    let auth_restored = backup_auth.exists();

    if !backup_config.exists() {
        return Err(SwitcherError::Message(
            "最近备份缺少 config.toml。".to_string(),
        ));
    }

    fs::copy(backup_config, config_path()?)?;
    if auth_restored {
        fs::copy(backup_auth, auth_path()?)?;
    }

    app_state_with_activity(
        "已恢复最近备份",
        &format!(
            "已从 {} 恢复 config.toml{}。",
            latest.label,
            if auth_restored { " 和 auth.json" } else { "" }
        ),
        "success",
    )
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_state,
            check_for_update,
            save_profile,
            delete_profile,
            switch_profile,
            verify_profile,
            refresh_models,
            set_default_profile,
            toggle_auto_start,
            restore_latest_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running CodeX Provider Switcher");
}
