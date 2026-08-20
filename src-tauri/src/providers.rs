//! Provider-facing pure helpers.
//!
//! Keep response parsing and model metadata independent from filesystem and
//! Tauri command concerns. The public application state stays in `lib.rs` for
//! now, so this is a deliberately small first extraction rather than a broad
//! provider rewrite.

use crate::ProviderModel;
use serde_json::Value;
use std::collections::BTreeSet;

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
        has_compatible_response_output, has_provider_error, provider_error_code,
        provider_probe_endpoint,
    };
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
}
