//! Application-state and startup orchestration.
//!
//! This layer composes storage and domain helpers into the `AppState` returned
//! to the desktop and local development backend. It deliberately does not
//! change the JSON contract; it only gives startup/activity concerns a stable
//! home while command adapters remain in `commands.rs`.

use super::*;

pub(crate) fn current_profile_id(catalog: &StoredCatalog, config_text: &str) -> String {
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

pub(crate) fn catalog_profiles(catalog: &StoredCatalog, current_id: &str) -> Vec<ProviderProfile> {
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

pub(crate) fn catalog_model_catalogs(catalog: &StoredCatalog) -> Vec<ModelCatalog> {
    catalog
        .model_catalogs
        .iter()
        .filter_map(|(_, value)| serde_json::from_value::<ModelCatalog>(value.clone()).ok())
        .collect()
}

pub(crate) fn current_config_model(config_text: &str) -> Option<String> {
    toml::from_str::<toml::Value>(config_text)
        .ok()
        .and_then(|value| {
            value
                .get("model")
                .and_then(toml::Value::as_str)
                .map(ToString::to_string)
        })
}

pub(crate) fn configuration_drift(
    catalog: &StoredCatalog,
    config_text: &str,
) -> Option<ConfigurationDrift> {
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

pub(crate) fn app_validation_checks(config_text: &str) -> Vec<ValidationCheck> {
    let mut checks = validation_checks(config_text);
    checks.push(configuration_layer_check());
    checks
}

pub(crate) fn activity_seed() -> ActivityItem {
    ActivityItem {
        id: "startup".to_string(),
        time: short_time(),
        title: "工作台已加载".to_string(),
        detail: "已从本地服务商目录和 Codex 配置读取状态。".to_string(),
        tone: "info".to_string(),
        occurred_at: now_label(),
        event_name: "workspace.loaded".to_string(),
        result: "info".to_string(),
        next_step: "如需继续操作，请从服务商工作区开始。".to_string(),
        subject: None,
        correlation_id: None,
        operation_kind: "workspace".to_string(),
        operation_key: "workspace.loaded".to_string(),
        problem_key: None,
        stages: vec![ActivityStage {
            state: "completed".to_string(),
            title: "工作台已准备好".to_string(),
            detail: "已从本地服务商目录和 Codex 配置读取状态。".to_string(),
        }],
        diagnostics: Vec::new(),
    }
}

fn activity_operation_kind(event_name: &str, title: &str) -> &'static str {
    let event_name = event_name.to_ascii_lowercase();
    if event_name.contains("verification") {
        "verification"
    } else if event_name.contains("model_catalog") {
        "model_catalog"
    } else if event_name.contains("switch") {
        "switch"
    } else if title.contains("恢复") {
        "restore"
    } else if title.contains("备份") {
        "backup"
    } else {
        "workspace"
    }
}

fn activity_stage_title(kind: &str) -> &'static str {
    match kind {
        "verification" => "开始检查服务商可用性",
        "model_catalog" => "开始读取模型目录",
        "switch" => "开始准备切换",
        "restore" => "开始恢复配置",
        "backup" => "开始创建恢复点",
        _ => "开始处理本次操作",
    }
}

fn activity_problem_key(
    kind: &str,
    provider_name: Option<&str>,
    diagnostics: &[ActivityDiagnostic],
    result: &str,
    tone: &str,
) -> Option<String> {
    let needs_attention = matches!(result, "failure" | "warning") || matches!(tone, "warning" | "danger");
    if !needs_attention {
        return None;
    }
    let provider = provider_name.unwrap_or("workspace").trim().to_ascii_lowercase();
    let cause = diagnostics
        .iter()
        .find(|item| matches!(item.key.as_str(), "provider.error_code" | "http.status_code" | "verification.status" | "model_catalog.status"))
        .map(|item| item.value.trim().to_ascii_lowercase().replace(char::is_whitespace, "-"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "attention".to_string());
    Some(format!("{provider}:{kind}:{cause}"))
}

fn activity_stages(
    kind: &str,
    _title: &str,
    detail: &str,
    result: &str,
    tone: &str,
    diagnostics: &[ActivityDiagnostic],
) -> Vec<ActivityStage> {
    let mut stages = vec![ActivityStage {
        state: "completed".to_string(),
        title: activity_stage_title(kind).to_string(),
        detail: "本次操作已开始，正在等待本机与服务商检查完成。".to_string(),
    }];

    for diagnostic in diagnostics {
        let state = if diagnostic.key == "http.status_code" && diagnostic.value.parse::<u16>().map(|status| status >= 400).unwrap_or(false) {
            "failed"
        } else if matches!(diagnostic.key.as_str(), "provider.error_code" | "verification.status")
            && !matches!(diagnostic.value.as_str(), "verified" | "success" | "ok" | "passed")
        {
            "attention"
        } else {
            "completed"
        };
        let stage_title = match diagnostic.key.as_str() {
            "verification.stage" => "检查环节已返回",
            "verification.status" => "可用性结果已返回",
            "http.status_code" => "服务商响应已返回",
            "provider.error_code" => "服务商说明了错误原因",
            "model_catalog.count" => "已读取模型目录",
            "switch.rollback_backup_created" => "已创建恢复点",
            "switch.protected_fields_verified" => "受保护设置已核对",
            _ => diagnostic.label.as_str(),
        };
        stages.push(ActivityStage {
            state: state.to_string(),
            title: stage_title.to_string(),
            detail: format!("{}：{}", diagnostic.label, diagnostic.value),
        });
    }

    let terminal_state = if result == "failure" || tone == "danger" {
        "failed"
    } else if result == "warning" || tone == "warning" {
        let explicitly_unconfirmed = detail.contains("超时")
            || diagnostics
                .iter()
                .any(|item| item.value.to_ascii_lowercase().contains("unconfirmed"));
        if explicitly_unconfirmed {
            "unconfirmed"
        } else {
            "attention"
        }
    } else {
        "completed"
    };
    let terminal_title = match terminal_state {
        "failed" => "本次操作未完成",
        "unconfirmed" => "等待结束，结果尚未确认",
        "attention" => "本次操作需要处理",
        _ => "本次操作已完成",
    };
    stages.push(ActivityStage {
        state: terminal_state.to_string(),
        title: terminal_title.to_string(),
        detail: detail.to_string(),
    });
    stages
}

pub(crate) fn load_activity() -> Result<Vec<ActivityItem>, SwitcherError> {
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

pub(crate) fn save_activity(items: &[ActivityItem]) -> Result<(), SwitcherError> {
    ensure_dirs()?;
    fs::write(activity_path()?, serde_json::to_string_pretty(items)?)?;
    Ok(())
}

pub(crate) fn push_activity(title: &str, detail: &str, tone: &str) -> Result<(), SwitcherError> {
    push_activity_diagnostics(
        title,
        detail,
        tone,
        "workspace.operation",
        tone,
        "可在此查看最近操作；如需排查，请展开诊断详情。",
        None,
        None,
        Vec::new(),
    )
}

pub(crate) fn diagnostic_field(
    key: &str,
    label: &str,
    value: impl AsRef<str>,
) -> Option<ActivityDiagnostic> {
    const SENSITIVE_MARKERS: [&str; 9] = [
        "api_key",
        "apikey",
        "authorization",
        "bearer ",
        "token",
        "secret",
        "password",
        "cookie",
        "auth.json",
    ];
    let key = key.trim();
    let raw = value.as_ref().trim();
    if key.is_empty() || raw.is_empty() {
        return None;
    }
    let key_lower = key.to_ascii_lowercase();
    let value_lower = raw.to_ascii_lowercase();
    if SENSITIVE_MARKERS
        .iter()
        .any(|marker| key_lower.contains(marker) || value_lower.contains(marker))
    {
        return None;
    }
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let value = if normalized.chars().count() > 160 {
        format!("{}…", normalized.chars().take(159).collect::<String>())
    } else {
        normalized
    };
    Some(ActivityDiagnostic {
        key: key.to_string(),
        label: label.trim().to_string(),
        value,
    })
}

pub(crate) fn push_activity_diagnostics(
    title: &str,
    detail: &str,
    tone: &str,
    event_name: &str,
    result: &str,
    next_step: &str,
    provider_name: Option<&str>,
    model: Option<&str>,
    diagnostics: Vec<ActivityDiagnostic>,
) -> Result<(), SwitcherError> {
    let mut items = load_activity()?;
    let occurred_at = now_label();
    let correlation_id = format!("diag-{}", Local::now().timestamp_millis());
    let operation_kind = activity_operation_kind(event_name, title);
    let provider_name = provider_name.map(str::trim).filter(|value| !value.is_empty());
    let operation_key = format!(
        "{}:{}",
        provider_name.unwrap_or("workspace").to_ascii_lowercase(),
        operation_kind
    );
    let problem_key = activity_problem_key(operation_kind, provider_name, &diagnostics, result, tone);
    let stages = activity_stages(operation_kind, title, detail, result, tone, &diagnostics);
    items.insert(
        0,
        ActivityItem {
            id: format!("{}-{}", tone, Local::now().timestamp_millis()),
            time: short_time(),
            title: title.to_string(),
            detail: detail.to_string(),
            tone: tone.to_string(),
            occurred_at,
            event_name: event_name.trim().to_string(),
            result: result.trim().to_string(),
            next_step: next_step.trim().to_string(),
            subject: match (provider_name, model) {
                (None, None) => None,
                (provider_name, model) => Some(ActivitySubject {
                    provider_name: provider_name
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string),
                    model: model
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string),
                }),
            },
            correlation_id: Some(correlation_id),
            operation_kind: operation_kind.to_string(),
            operation_key,
            problem_key,
            stages,
            diagnostics,
        },
    );
    items.truncate(200);
    save_activity(&items)
}

pub(crate) fn app_state_with_activity(
    title: &str,
    detail: &str,
    tone: &str,
) -> Result<AppState, SwitcherError> {
    push_activity(title, detail, tone)?;
    app_state()
}

pub(crate) fn app_state_with_activity_diagnostics(
    title: &str,
    detail: &str,
    tone: &str,
    event_name: &str,
    result: &str,
    next_step: &str,
    provider_name: Option<&str>,
    model: Option<&str>,
    diagnostics: Vec<ActivityDiagnostic>,
) -> Result<AppState, SwitcherError> {
    push_activity_diagnostics(
        title,
        detail,
        tone,
        event_name,
        result,
        next_step,
        provider_name,
        model,
        diagnostics,
    )?;
    app_state()
}

pub(crate) fn connection_environment_state() -> ConnectionEnvironment {
    let record = load_connection_environment_record();
    match configuration_layer_candidates() {
        Ok(layers) => {
            let selected_valid = record
                .selected_layer_id
                .as_ref()
                .is_some_and(|selected| layers.iter().any(|(id, _, _)| id == selected));
            let status = if record.setup_completed && selected_valid {
                "ready"
            } else if layers.len() > 1 {
                "needs_selection"
            } else {
                "needs_setup"
            };
            let detail = match status {
                "ready" => "已准备连接环境。切换时仅写入当前选择配置层的服务商字段。",
                "needs_selection" => {
                    "发现多个 Codex 配置层。请选择本次要管理的配置层，程序不会猜测。"
                }
                _ => {
                    "首次使用前请准备连接环境。程序会创建恢复点，并保留项目、MCP、插件与历史设置。"
                }
            }
            .to_string();
            ConnectionEnvironment {
                status: status.to_string(),
                selected_layer_id: record.selected_layer_id.clone(),
                // Existing installations completed setup before this field
                // existed. Treat them as onboarded to avoid re-showing the
                // first-run flow after a normal upgrade.
                onboarding_completed: record.onboarding_completed || record.setup_completed,
                detail,
                layers: layers
                    .into_iter()
                    .map(|(id, path, label)| ConnectionEnvironmentLayer {
                        selected: record
                            .selected_layer_id
                            .as_ref()
                            .is_some_and(|selected| selected == &id),
                        id,
                        label,
                        detail: format!(
                            "{}。",
                            path.file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("config.toml")
                        ),
                    })
                    .collect(),
            }
        }
        Err(error) => ConnectionEnvironment {
            status: "error".to_string(),
            selected_layer_id: record.selected_layer_id,
            onboarding_completed: record.onboarding_completed || record.setup_completed,
            detail: format!("无法读取 Codex 配置层：{error}"),
            layers: Vec::new(),
        },
    }
}

pub(crate) fn app_state() -> Result<AppState, SwitcherError> {
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
        connection_environment: connection_environment_state(),
    })
}

pub(crate) fn startup_error_code(error: &SwitcherError) -> String {
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

pub(crate) fn record_startup_diagnostic(notice: &StartupNotice) {
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

pub(crate) fn load_catalog_read_only() -> StoredCatalog {
    let fallback = || {
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
    };
    let Ok(path) = profiles_path() else {
        return fallback();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_json_document::<StoredCatalog>(&text).ok())
        .unwrap_or_else(fallback)
}

pub(crate) fn startup_safe_state(notice: StartupNotice) -> Result<AppState, SwitcherError> {
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
        connection_environment: connection_environment_state(),
    })
}

pub(crate) fn ensure_daily_backup() -> Result<bool, SwitcherError> {
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
