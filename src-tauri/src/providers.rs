//! Provider-facing pure helpers.
//!
//! Keep response parsing and model metadata independent from filesystem and
//! Tauri command concerns. The public application state stays in `lib.rs` for
//! now, so this is a deliberately small first extraction rather than a broad
//! provider rewrite.

use crate::{
    default_auth_mode, default_verification_status, ModelCatalog, ProviderModel,
    ProviderVerificationOutcome, StoredProfile,
};
use chrono::Local;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;

use super::{
    configure_http_client, is_isolated_development_fixture, response_header_id, SwitcherError,
};

#[derive(Debug, Clone, Default)]
pub(crate) struct ModelCatalogMetadata {
    pub(crate) http_status: Option<u16>,
    pub(crate) provider_code: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) retry_after_seconds: Option<u64>,
}

/// Versioned provider capability registry.  The registry is deliberately
/// small and conservative: ordinary OpenAI-compatible providers share one
/// contract, while a provider-specific command is only selected for the
/// documented ModelFlare adapter.  Unknown providers never inherit a command
/// or a guessed credential field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderAdapter {
    pub(crate) id: &'static str,
    pub(crate) version: &'static str,
    pub(crate) auth_mode: &'static str,
    pub(crate) wire_api: &'static str,
}

const STANDARD_BEARER_ADAPTER: ProviderAdapter = ProviderAdapter {
    id: "standard_bearer",
    version: "1",
    auth_mode: "bearer_profile_key",
    wire_api: "responses",
};

const MODELFLARE_COMMAND_ADAPTER: ProviderAdapter = ProviderAdapter {
    id: "modelflare_command",
    version: "1",
    auth_mode: "provider_command",
    wire_api: "responses",
};

pub(crate) fn provider_adapter(
    name: &str,
    base_url: &str,
    explicit_auth_mode: Option<&str>,
) -> ProviderAdapter {
    let exact_modelflare = preferred_auth_mode(name, base_url) == "provider_command";
    // Never let a persisted/free-form auth_mode opt an arbitrary endpoint into
    // auth.command. The command is a product-owned compatibility adapter and
    // is selected only after the endpoint has been proven to be ModelFlare.
    let _ = explicit_auth_mode;
    if exact_modelflare {
        MODELFLARE_COMMAND_ADAPTER
    } else {
        STANDARD_BEARER_ADAPTER
    }
}

/// Select the authentication contract for a provider without touching storage
/// or the desktop command boundary. Provider-specific rules live here so
/// profile migration and persistence can share the same decision.
pub(crate) fn preferred_auth_mode(name: &str, base_url: &str) -> String {
    let host = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    // Keep the name argument for API compatibility, but never let a display
    // name alone activate a privileged command adapter.
    let _ = name;
    if host.as_deref() == Some("modelflare.dev") {
        "provider_command".to_string()
    } else {
        default_auth_mode()
    }
}

pub(crate) fn uses_provider_command_auth(profile: &StoredProfile) -> bool {
    // `auth.command` is a provider capability, not a consequence of having a
    // saved key.  Keep the explicit profile choice for migrations and use the
    // verified ModelFlare host match as the compatibility bridge for profiles
    // created before the adapter metadata existed.  All other providers use
    // the standard Bearer contract and must not inherit this command.
    provider_adapter(&profile.name, &profile.base_url, Some(&profile.auth_mode)).auth_mode
        == "provider_command"
}

pub(crate) fn is_modelflare_profile(profile: &StoredProfile) -> bool {
    preferred_auth_mode(&profile.name, &profile.base_url) == "provider_command"
}

pub(crate) fn modelflare_permission_hint(profile: &StoredProfile) -> &'static str {
    if is_modelflare_profile(profile) {
        " ModelFlare 要求 API Key 属于包含 gpt-5.6-sol 的非 default 分组；auth.command 只解决取钥匙，不会授予模型权限。"
    } else {
        ""
    }
}

pub(crate) fn build_model_catalog(
    provider_id: &str,
    profile: &StoredProfile,
    status: &str,
    detail: &str,
    models: Vec<ProviderModel>,
    fetched_at: String,
) -> ModelCatalog {
    build_model_catalog_with_metadata(
        provider_id,
        profile,
        status,
        detail,
        models,
        fetched_at,
        ModelCatalogMetadata::default(),
    )
}

pub(crate) fn build_model_catalog_with_metadata(
    provider_id: &str,
    profile: &StoredProfile,
    status: &str,
    detail: &str,
    models: Vec<ProviderModel>,
    fetched_at: String,
    metadata: ModelCatalogMetadata,
) -> ModelCatalog {
    ModelCatalog {
        provider_id: provider_id.to_string(),
        base_url: profile.base_url.clone(),
        fetched_at: Some(fetched_at.clone()),
        last_successful_at: (status == "ok").then_some(fetched_at),
        status: status.to_string(),
        status_detail: detail.to_string(),
        http_status: metadata.http_status,
        provider_code: metadata.provider_code,
        request_id: metadata.request_id,
        retry_after_seconds: metadata.retry_after_seconds,
        models,
    }
}

fn now_label() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn build_model_catalog_now(
    provider_id: &str,
    profile: &StoredProfile,
    status: &str,
    detail: &str,
    models: Vec<ProviderModel>,
) -> ModelCatalog {
    build_model_catalog(provider_id, profile, status, detail, models, now_label())
}

fn build_model_catalog_with_metadata_now(
    provider_id: &str,
    profile: &StoredProfile,
    status: &str,
    detail: &str,
    models: Vec<ProviderModel>,
    metadata: ModelCatalogMetadata,
) -> ModelCatalog {
    build_model_catalog_with_metadata(
        provider_id,
        profile,
        status,
        detail,
        models,
        now_label(),
        metadata,
    )
}

pub(crate) fn compact_provider_error(error_body: &str) -> Option<String> {
    let compact = error_body.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.trim();
    if compact.is_empty() {
        return None;
    }
    let mut result = compact.chars().take(240).collect::<String>();
    if compact.chars().count() > 240 {
        result.push('…');
    }
    Some(result)
}

pub(crate) fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

pub(crate) fn model_catalog_http_detail(
    status: reqwest::StatusCode,
    body: &str,
    request_id: Option<&str>,
    retry_after: Option<u64>,
) -> (String, Option<String>) {
    let provider_code = provider_error_code(body);
    let mut detail = format!("服务商返回 HTTP {status}");
    if let Some(code) = provider_code.as_deref() {
        detail.push_str(&format!("（错误码：{code}）"));
    }
    if let Some(seconds) = retry_after {
        detail.push_str(&format!("；请等待约 {seconds} 秒后再试"));
    }
    if let Some(request_id) = request_id {
        detail.push_str(&format!("；请求编号：{request_id}"));
    }
    if let Some(body) = compact_provider_error(body) {
        detail.push_str(&format!("；服务商说明：{body}"));
    }
    (detail, provider_code)
}

pub(crate) fn verification_outcome(
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

pub(crate) fn inference_outcome(
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

pub(crate) fn provider_failure_outcome(
    http_status: Option<u16>,
    error_body: &str,
) -> ProviderVerificationOutcome {
    let error_text = error_body.to_ascii_lowercase();
    let provider_code = provider_error_code(error_body);
    let has_billing_signal = ["insufficient", "quota", "balance", "credit", "余额", "额度"]
        .iter()
        .any(|signal| error_text.contains(signal));
    let has_model_signal = [
        "model_not_found",
        "model not found",
        "no available channel",
        "model unavailable",
        "不存在此模型",
        "模型不存在",
    ]
    .iter()
    .any(|signal| error_text.contains(signal));
    let (status, stage, detail) = if has_billing_signal || http_status == Some(402) {
        (
            "billing_unavailable",
            "billing",
            "服务商余额、额度或配额不足，无法完成实际请求。",
        )
    } else if has_model_signal {
        (
            "endpoint_or_model_unavailable",
            "endpoint",
            "服务商入口可达，但当前模型或模型分组不可用；请从模型目录选择可用模型后重试。",
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

pub(crate) fn apply_verification(
    profile: &mut StoredProfile,
    outcome: ProviderVerificationOutcome,
    verified_at: String,
) {
    profile.verified = outcome.verified;
    profile.verification_status = outcome.status;
    profile.last_verified_at = Some(verified_at);
    profile.last_verification_detail = Some(outcome.detail);
    profile.last_verification_stage = Some(outcome.stage);
    profile.last_verification_http_status = outcome.http_status;
    profile.last_verification_provider_code = outcome.provider_code;
    profile.verification_response_shape = outcome.response_shape;
}

pub(crate) fn reset_profile_verification(profile: &mut StoredProfile, detail: &str) {
    profile.verified = false;
    profile.verification_status = default_verification_status();
    profile.verification_response_shape = None;
    profile.last_verified_at = None;
    profile.last_verification_detail = Some(detail.to_string());
    profile.last_verification_stage = Some("profile".to_string());
    profile.last_verification_http_status = None;
    profile.last_verification_provider_code = None;
}

pub(crate) fn model_tags(model_id: &str) -> Vec<String> {
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

pub(crate) fn parse_provider_models(body: &Value) -> Vec<ProviderModel> {
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

pub(crate) fn provider_probe_endpoint(base_url: &str, probe_path: &str) -> Result<String, String> {
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

pub(crate) fn has_provider_error(body: &Value) -> bool {
    body.get("error").is_some_and(|error| !error.is_null())
}

fn nonempty_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

pub(crate) fn has_compatible_response_output(body: &Value) -> bool {
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

pub(crate) fn provider_error_code(error_body: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::{
        build_model_catalog, has_compatible_response_output, has_provider_error,
        preferred_auth_mode, provider_adapter, provider_error_code, provider_failure_outcome,
        provider_probe_endpoint,
    };
    use crate::StoredProfile;
    use serde_json::json;

    #[test]
    fn builds_model_and_response_endpoints_from_api_base_url() {
        assert_eq!(
            provider_probe_endpoint("https://provider.example/v1", "models").unwrap(),
            "https://provider.example/v1/models"
        );
        assert_eq!(
            provider_probe_endpoint("https://provider.example/v1/", "responses").unwrap(),
            "https://provider.example/v1/responses"
        );
    }

    #[test]
    fn rejects_a_resource_endpoint_as_a_provider_base_url() {
        let error = provider_probe_endpoint("https://provider.example/v1/models", "models")
            .expect_err("a concrete resource endpoint is not a provider base URL");
        assert!(error.contains("不应包含 /responses 或 /models"));
    }

    #[test]
    fn rejects_non_http_and_query_urls() {
        assert!(provider_probe_endpoint("file:///provider", "models")
            .expect_err("file URLs are unsafe provider endpoints")
            .contains("http 或 https"));
        assert!(
            provider_probe_endpoint("https://provider.example/v1?debug=1", "models")
                .expect_err("query strings make endpoint composition ambiguous")
                .contains("查询参数")
        );
    }

    #[test]
    fn adapter_registry_only_uses_exact_modelflare_host() {
        assert_eq!(
            provider_adapter("ModelFlare", "https://modelflare.dev/v1", None).id,
            "modelflare_command"
        );
        assert_eq!(
            preferred_auth_mode("ModelFlare", "https://example.com/v1"),
            "bearer_profile_key"
        );
        assert_eq!(
            provider_adapter("Any name", "https://example.com/v1", None).id,
            "standard_bearer"
        );
        assert_eq!(
            provider_adapter(
                "Any name",
                "https://example.com/v1",
                Some("provider_command")
            )
            .id,
            "standard_bearer"
        );
    }

    #[test]
    fn recognizes_common_compatible_response_shapes_without_accepting_blank_text() {
        assert!(has_compatible_response_output(&json!({
            "output": [{ "content": [{ "text": "OK" }] }]
        })));
        assert!(has_compatible_response_output(&json!({
            "choices": [{ "message": { "content": "OK" } }]
        })));
        assert!(!has_compatible_response_output(
            &json!({ "output_text": "  " })
        ));
    }

    #[test]
    fn extracts_provider_error_codes_from_common_envelopes() {
        assert!(has_provider_error(
            &json!({ "error": { "code": "rate_limit" } })
        ));
        assert_eq!(
            provider_error_code(r#"{ "error": { "code": "rate_limit" } }"#),
            Some("rate_limit".to_string())
        );
        assert_eq!(
            provider_error_code(r#"{ "code": "insufficient_quota" }"#),
            Some("insufficient_quota".to_string())
        );
    }

    #[test]
    fn classifies_provider_failures_without_network_or_storage() {
        let outcome = provider_failure_outcome(Some(429), r#"{"error":{"code":"rate_limit"}}"#);
        assert_eq!(outcome.status, "rate_limited");
        assert_eq!(outcome.stage, "provider");
        assert_eq!(outcome.provider_code.as_deref(), Some("rate_limit"));

        let billing = provider_failure_outcome(Some(402), "insufficient quota");
        assert_eq!(billing.status, "billing_unavailable");
        assert_eq!(billing.stage, "billing");

        let model = provider_failure_outcome(
            Some(403),
            r#"{"error":{"code":"upstream_error","message":"不存在此模型！"}}"#,
        );
        assert_eq!(model.status, "endpoint_or_model_unavailable");
        assert_eq!(model.stage, "endpoint");
    }

    #[test]
    fn builds_catalog_metadata_without_changing_public_shape() {
        let profile = StoredProfile {
            name: "Fixture".to_string(),
            base_url: "https://provider.example/v1".to_string(),
            api_key: "development-placeholder".to_string(),
            api_key_protected: String::new(),
            model: "gpt-test".to_string(),
            auth_mode: "bearer_profile_key".to_string(),
            model_reasoning_effort: "high".to_string(),
            verified: false,
            verification_status: "not_checked".to_string(),
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
        let catalog = build_model_catalog(
            "fixture",
            &profile,
            "ok",
            "已刷新 1 个模型",
            vec![crate::ProviderModel {
                id: "gpt-test".to_string(),
                aliases: Vec::new(),
                source: "fixture".to_string(),
                tags: vec!["responses-candidate".to_string()],
                verified_for_responses: "unknown".to_string(),
            }],
            "2026-08-21 00:00:00".to_string(),
        );
        assert_eq!(catalog.provider_id, "fixture");
        assert_eq!(
            catalog.last_successful_at.as_deref(),
            Some("2026-08-21 00:00:00")
        );
        assert_eq!(catalog.models.len(), 1);
    }
}

pub(crate) fn fetch_provider_models(
    provider_id: &str,
    profile: &StoredProfile,
) -> Result<ModelCatalog, SwitcherError> {
    if profile.api_key.trim().is_empty() {
        return Ok(build_model_catalog_now(
            provider_id,
            profile,
            "missing_key",
            "缺少 API 密钥，无法刷新模型目录。",
            Vec::new(),
        ));
    }

    let base_url = profile.base_url.trim().trim_end_matches('/');
    if !base_url.starts_with("http") {
        return Ok(build_model_catalog_now(
            provider_id,
            profile,
            "provider_error",
            "接口地址无效，必须以 http 或 https 开头。",
            Vec::new(),
        ));
    }

    let url = format!("{base_url}/models");
    let client = configure_http_client(
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(18))
            .http1_only(),
    )
    .build()
    .map_err(|err| SwitcherError::Message(format!("创建 HTTP client 失败：{err}")))?;
    let mut response = None;
    let mut last_error = None;
    for attempt in 0..2 {
        match client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, "Signalman-AI/0.10")
            .bearer_auth(profile.api_key.trim())
            .send()
        {
            Ok(value) => {
                response = Some(value);
                break;
            }
            Err(err) => {
                let retryable = err.is_timeout() || err.is_connect();
                last_error = Some(err);
                if retryable && attempt < 1 {
                    std::thread::sleep(Duration::from_millis(350));
                    continue;
                }
                break;
            }
        }
    }
    let response = match response {
        Some(response) => response,
        None => {
            let error = last_error
                .map(|err| err.to_string())
                .unwrap_or_else(|| "未知传输错误".to_string());
            let mut detail = format!("模型目录请求失败：{error}（已对连接/超时做有限重试）。");
            if base_url.contains("a6api.com") && !base_url.contains("api.a6api.com") {
                detail.push_str(
                    " A6 官方文档当前推荐地址为 https://api.a6api.com/v1，请核对服务商配置。 ",
                );
            }
            return Ok(build_model_catalog_now(
                provider_id,
                profile,
                "network_error",
                detail.trim(),
                Vec::new(),
            ));
        }
    };

    let status = response.status();
    let headers = response.headers().clone();
    let request_id = response_header_id(&headers);
    let retry_after = retry_after_seconds(&headers);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("未知")
        .to_string();
    let final_url = response.url().to_string();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        let body = response.text().unwrap_or_default();
        let (mut detail, provider_code) =
            model_catalog_http_detail(status, &body, request_id.as_deref(), retry_after);
        detail.push_str("；请检查 API key 和服务商权限。");
        detail.push_str(modelflare_permission_hint(profile));
        return Ok(build_model_catalog_with_metadata_now(
            provider_id,
            profile,
            "unauthorized",
            &detail,
            Vec::new(),
            ModelCatalogMetadata {
                http_status: Some(status.as_u16()),
                provider_code,
                request_id,
                retry_after_seconds: retry_after,
            },
        ));
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        let (detail, provider_code) =
            model_catalog_http_detail(status, &body, request_id.as_deref(), retry_after);
        let status_name = match status.as_u16() {
            429 => "rate_limited",
            code if code >= 500 => "service_error",
            _ => "provider_error",
        };
        return Ok(build_model_catalog_with_metadata_now(
            provider_id,
            profile,
            status_name,
            &detail,
            Vec::new(),
            ModelCatalogMetadata {
                http_status: Some(status.as_u16()),
                provider_code,
                request_id,
                retry_after_seconds: retry_after,
            },
        ));
    }

    let body: Value = match response.json() {
        Ok(value) => value,
        Err(err) => {
            return Ok(build_model_catalog_with_metadata_now(
                provider_id,
                profile,
                "provider_error",
                &format!(
                    "模型目录响应不是有效 JSON（content-type: {content_type}，最终地址: {final_url}）：{err}"
                ),
                Vec::new(),
                ModelCatalogMetadata {
                    http_status: Some(status.as_u16()),
                    request_id,
                    retry_after_seconds: retry_after,
                    ..ModelCatalogMetadata::default()
                },
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
        return Ok(build_model_catalog_with_metadata_now(
            provider_id,
            profile,
            "empty_models",
            &format!(
                "provider 返回空模型列表（形状: {shape}，content-type: {content_type}，最终地址: {final_url}）。"
            ),
            Vec::new(),
            ModelCatalogMetadata {
                http_status: Some(status.as_u16()),
                request_id,
                retry_after_seconds: retry_after,
                ..ModelCatalogMetadata::default()
            },
        ));
    }

    Ok(build_model_catalog_with_metadata_now(
        provider_id,
        profile,
        "ok",
        &format!(
            "已刷新中转站实际返回的 {} 个模型；不会自动改写当前模型。",
            models.len()
        ),
        models,
        ModelCatalogMetadata {
            http_status: Some(status.as_u16()),
            request_id,
            retry_after_seconds: retry_after,
            ..ModelCatalogMetadata::default()
        },
    ))
}

fn transport_failure_outcome(err: &reqwest::Error, base_url: &str) -> ProviderVerificationOutcome {
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
        let detail = if base_url.contains("a6api.com") && !base_url.contains("api.a6api.com") {
            "无法建立连接；请检查 DNS、网络、TLS 或代理链路。A6 官方文档当前推荐地址为 https://api.a6api.com/v1，请核对服务商配置。"
        } else {
            "无法建立连接；请检查 DNS、网络、TLS 或代理链路。"
        };
        return verification_outcome(false, "network_error", "transport", detail, None, None);
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

pub(crate) fn verify_provider_auth_probe(profile: &StoredProfile) -> ProviderVerificationOutcome {
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
    if is_isolated_development_fixture(profile) {
        return inference_outcome(
            "standard_responses",
            "服务商已返回可识别的 Responses 输出。",
            200,
        );
    }
    let endpoint = match provider_probe_endpoint(&profile.base_url, "responses") {
        Ok(endpoint) => endpoint,
        Err(detail) => {
            return verification_outcome(false, "invalid_profile", "profile", &detail, None, None)
        }
    };

    let client = match configure_http_client(
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .http1_only(),
    )
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
        Err(err) => return transport_failure_outcome(&err, &profile.base_url),
    };

    let status = response.status();
    let response_headers = response.headers().clone();
    if status.is_success() {
        return match response.json::<Value>() {
            Ok(body) if has_provider_error(&body) => {
                enrich_provider_failure_detail(
                    provider_failure_outcome(Some(status.as_u16()), &body.to_string()),
                    &response_headers,
                    &body.to_string(),
                )
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
    let mut outcome = enrich_provider_failure_detail(
        provider_failure_outcome(Some(status.as_u16()), &error_body),
        &response_headers,
        &error_body,
    );
    outcome.detail.push_str(modelflare_permission_hint(profile));
    outcome
}

fn enrich_provider_failure_detail(
    mut outcome: ProviderVerificationOutcome,
    headers: &reqwest::header::HeaderMap,
    error_body: &str,
) -> ProviderVerificationOutcome {
    if let Some(code) = provider_error_code(error_body) {
        outcome.detail.push_str(&format!("错误码：{code}。"));
    }
    if let Some(seconds) = retry_after_seconds(headers) {
        outcome
            .detail
            .push_str(&format!("请等待约 {seconds} 秒后再试。"));
    }
    if let Some(request_id) = response_header_id(headers) {
        outcome
            .detail
            .push_str(&format!("请求编号：{request_id}。"));
    }
    if let Some(body) = compact_provider_error(error_body) {
        outcome.detail.push_str(&format!("服务商说明：{body}"));
    }
    outcome
}
