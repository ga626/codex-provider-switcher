//! Laboratory probes, cost calibration and model-catalog verification state.
//!
//! This module contains the pure response/cost bookkeeping used by the lab
//! commands. Network orchestration and Tauri command handlers remain in
//! `lib.rs`; keeping these helpers here makes the lab domain independently
//! testable without changing the command contract.

use super::*;

const COST_SCALE_DIGITS: u32 = 12;
const COST_SCALE: u128 = 1_000_000_000_000;

pub(crate) fn parse_fixed_decimal(value: &str, field_name: &str) -> Result<u128, SwitcherError> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.starts_with('+') {
        return Err(SwitcherError::Message(format!(
            "{field_name} 必须是大于 0 的十进制数。"
        )));
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
    let whole = whole
        .parse::<u128>()
        .map_err(|_| SwitcherError::Message(format!("{field_name} 数值过大，无法安全计算。")))?;
    let fraction_value = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<u128>()
            .map_err(|_| SwitcherError::Message(format!("{field_name} 数值无效。")))?
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

pub(crate) fn format_fixed_decimal(value: u128) -> String {
    let whole = value / COST_SCALE;
    let fraction = value % COST_SCALE;
    if fraction == 0 {
        return whole.to_string();
    }
    let fraction = format!("{fraction:0width$}", width = COST_SCALE_DIGITS as usize);
    format!("{whole}.{}", fraction.trim_end_matches('0'))
}

pub(crate) fn calculate_calibrated_cost(
    input: &CostCalibrationInput,
) -> Result<String, SwitcherError> {
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

pub(crate) fn probe_usage(body: &Value) -> Option<ProbeUsage> {
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
    let prompt_details = usage
        .get("input_tokens_details")
        .or_else(|| usage.get("prompt_tokens_details"));
    let completion_details = usage
        .get("output_tokens_details")
        .or_else(|| usage.get("completion_tokens_details"));
    let cached_tokens = prompt_details
        .and_then(Value::as_object)
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64);
    let cache_write_tokens = prompt_details
        .and_then(Value::as_object)
        .and_then(|details| details.get("cache_write_tokens"))
        .and_then(Value::as_u64);
    let reasoning_tokens = completion_details
        .and_then(Value::as_object)
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_u64);
    if input_tokens.is_none()
        && output_tokens.is_none()
        && total_tokens.is_none()
        && cached_tokens.is_none()
        && cache_write_tokens.is_none()
        && reasoning_tokens.is_none()
    {
        None
    } else {
        Some(ProbeUsage {
            input_tokens,
            output_tokens,
            total_tokens,
            cached_tokens,
            cache_write_tokens,
            reasoning_tokens,
        })
    }
}

fn numeric_cost(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.trim().to_string()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

pub(crate) fn response_cost_candidate(body: &Value) -> Option<(String, String)> {
    ["total_cost", "total_cost_usd", "cost"]
        .iter()
        .find_map(|key| {
            numeric_cost(body.get(*key)).map(|cost| (cost, "response_inline".to_string()))
        })
        .or_else(|| {
            body.get("usage").and_then(|usage| {
                ["cost", "total_cost", "total_cost_usd"]
                    .iter()
                    .find_map(|key| {
                        numeric_cost(usage.get(*key))
                            .map(|cost| (cost, "response_usage".to_string()))
                    })
            })
        })
}

pub(crate) fn response_header_cost(
    headers: &reqwest::header::HeaderMap,
) -> Option<(String, String)> {
    ["x-litellm-response-cost", "x-response-cost", "x-total-cost"]
        .iter()
        .find_map(|name| headers.get(*name).and_then(|value| value.to_str().ok()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| (value.to_string(), "response_header".to_string()))
}

pub(crate) fn response_header_id(headers: &reqwest::header::HeaderMap) -> Option<String> {
    ["x-request-id", "request-id"]
        .iter()
        .find_map(|name| headers.get(*name).and_then(|value| value.to_str().ok()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn push_probe_observation(
    catalog: &mut StoredCatalog,
    observation: ResponseProbeObservation,
) {
    catalog.response_probes.insert(0, observation);
    catalog.response_probes.truncate(100);
}

pub(crate) fn mark_catalog_model_verified(
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

pub(crate) fn invalidate_catalog_model_verifications(
    catalog: &mut StoredCatalog,
    provider_id: &str,
) {
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

pub(crate) fn preserve_catalog_model_verifications(
    previous: Option<&Value>,
    next: &mut ModelCatalog,
) {
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

pub(crate) fn preserve_previous_model_catalog(previous: Option<&Value>, next: &mut ModelCatalog) {
    if next.status == "ok" {
        return;
    }
    let Some(previous) = previous else {
        return;
    };
    let Ok(previous) = serde_json::from_value::<ModelCatalog>(previous.clone()) else {
        return;
    };
    if previous.base_url != next.base_url || previous.models.is_empty() {
        return;
    }
    let previous_count = previous.models.len();
    next.models = previous.models.clone();
    next.status = "stale".to_string();
    next.last_successful_at = previous.last_successful_at.or(previous.fetched_at.clone());
    let last_success = next.last_successful_at.as_deref().unwrap_or("未知时间");
    next.status_detail = format!(
        "{} 已保留上次成功目录（{} 个模型，最近成功于 {}）。",
        next.status_detail.trim_end_matches('。'),
        previous_count,
        last_success
    );
}
