//! Filesystem, profile storage, backup and protected-secret boundaries.
//!
//! This module owns persistence mechanics; business orchestration remains in the
//! service layer and the public command contract stays unchanged.

use super::*;

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

pub(crate) fn now_label() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

pub(crate) fn short_time() -> String {
    Local::now().format("%H:%M").to_string()
}

pub(crate) fn backup_manifest_health(
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
    if backup_snapshot_fingerprint_match(manifest, &config, &auth)?.is_none() {
        return Err(SwitcherError::Message(
            "恢复点与记录的配置摘要不一致。".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn healthy_baseline_backup() -> Result<(), SwitcherError> {
    let backup_dir = backups_dir()?.join(INITIAL_BACKUP_LABEL);
    let manifest: BackupManifest = serde_json::from_str(&fs::read_to_string(
        backup_dir.join("manifest.json"),
    )?)
    .map_err(|_| SwitcherError::Message("首次启动基线备份说明损坏，已停止切换。".to_string()))?;

    // A truly new Codex home has no files to encrypt yet. The manifest is still
    // a valid audit record; switching may proceed and will create the first
    // complete backup before writing a provider.
    if is_empty_initial_backup(&manifest) {
        return Ok(());
    }

    backup_manifest_health(&backup_dir, &manifest)
}

pub(crate) fn is_empty_initial_backup(manifest: &BackupManifest) -> bool {
    manifest.reason == "initial_install"
        && manifest.files.is_empty()
        && manifest.snapshot_fingerprint.is_none()
        && manifest
            .missing_files
            .iter()
            .any(|file| file == "config.toml")
        && manifest
            .missing_files
            .iter()
            .any(|file| file == "auth.json")
}

pub(crate) fn empty_initial_baseline() -> bool {
    let Ok(backup_dir) = backups_dir() else {
        return false;
    };
    let Ok(text) = fs::read_to_string(backup_dir.join(INITIAL_BACKUP_LABEL).join("manifest.json"))
    else {
        return false;
    };
    serde_json::from_str::<BackupManifest>(&text)
        .map(|manifest| is_empty_initial_backup(&manifest))
        .unwrap_or(false)
}

pub(crate) fn restorable_baseline_backup() -> Result<bool, SwitcherError> {
    let backup_dir = backups_dir()?.join(INITIAL_BACKUP_LABEL);
    let manifest: BackupManifest =
        serde_json::from_str(&fs::read_to_string(backup_dir.join("manifest.json"))?)
            .map_err(|_| SwitcherError::Message("首次启动基线备份说明损坏。".to_string()))?;
    if is_empty_initial_backup(&manifest) {
        return Ok(false);
    }
    backup_manifest_health(&backup_dir, &manifest)?;
    Ok(true)
}

pub(crate) fn validate_backup_id(backup_id: &str) -> Result<(), SwitcherError> {
    if backup_id.contains('/') || backup_id.contains('\\') || backup_id.contains("..") {
        return Err(SwitcherError::Message("恢复点标识无效。".to_string()));
    }
    Ok(())
}

pub(crate) fn read_backup_manifest(
    backup_id: &str,
) -> Result<(PathBuf, BackupManifest), SwitcherError> {
    validate_backup_id(backup_id)?;
    let backup_dir = backups_dir()?.join(backup_id);
    let manifest: BackupManifest =
        serde_json::from_str(&fs::read_to_string(backup_dir.join("manifest.json"))?)
            .map_err(|_| SwitcherError::Message("恢复点说明损坏，已拒绝恢复。".to_string()))?;
    backup_manifest_health(&backup_dir, &manifest)?;
    Ok((backup_dir, manifest))
}

pub(crate) fn record_backup_post_change(
    backup_dir: &Path,
    fingerprint: &str,
) -> Result<(), SwitcherError> {
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

pub(crate) fn restored_owned_files(
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
    remove_section(&mut lines, "[model_providers.custom.auth]");
    if let Some(auth_lines) = section_block(&backup_config, "[model_providers.custom.auth]") {
        let insert_at = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim_start().starts_with('['))
            .map(|(index, _)| index)
            .unwrap_or(lines.len());
        lines.splice(insert_at..insert_at, auth_lines);
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

pub(crate) fn recover_pending_config_transaction() -> Result<(), SwitcherError> {
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

pub(crate) fn list_backups() -> Result<Vec<BackupItem>, SwitcherError> {
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
            Some(manifest) if is_empty_initial_backup(manifest) => (
                manifest.reason.clone(),
                manifest.retention_managed,
                false,
                "首次启动时还没有完整的 Codex 配置；这是状态记录，不是可恢复的配置快照。完成首次配置后才会生成可恢复备份。".to_string(),
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

pub(crate) fn backup_file_categories(file_names: &[String]) -> Vec<String> {
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

pub(crate) fn read_config() -> Result<String, SwitcherError> {
    let path = config_path()?;
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn read_auth() -> Result<String, SwitcherError> {
    let path = auth_path()?;
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn toml_value_at<'a>(value: &'a toml::Value, path: &[&str]) -> Option<&'a toml::Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

pub(crate) fn configuration_protection(config_text: &str) -> ConfigurationProtection {
    let parsed = toml::from_str::<toml::Value>(config_text).ok();
    let baseline_ready = restorable_baseline_backup().unwrap_or(false);
    let baseline_status = if baseline_ready {
        "ready"
    } else if empty_initial_baseline() {
        "empty"
    } else {
        "blocked"
    };
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
        baseline_status: baseline_status.to_string(),
        baseline_detail: if baseline_status == "ready" {
            "首次启动基线备份已验证。恢复只回退服务商配置，不会改写当前 Codex 登录信息。"
                .to_string()
        } else if baseline_status == "empty" {
            "首次启动时还没有完整的 Codex 配置；这是状态记录。保存并切换第一家服务商后会自动生成可恢复备份。".to_string()
        } else {
            "首次启动基线备份尚未通过完整性检查；应用不会允许切换服务商。".to_string()
        },
        items,
        restore_detail: "只恢复服务商设置；其他内容保持不变。".to_string(),
    }
}

pub(crate) fn protected_sections_match(before: &str, after: &str) -> Result<bool, SwitcherError> {
    let before = toml::from_str::<toml::Value>(before)?;
    let after = toml::from_str::<toml::Value>(after)?;
    Ok(PROTECTED_CONFIGURATION_AREAS
        .iter()
        .all(|(_, _, path)| toml_value_at(&before, path) == toml_value_at(&after, path))
        && toml_value_at(&before, &["windows"]) == toml_value_at(&after, &["windows"]))
}

pub(crate) fn only_provider_owned_configuration_changed(
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
            custom.remove("auth");
        }
        let remove_empty_custom = value
            .get("model_providers")
            .and_then(|providers| providers.get("custom"))
            .and_then(toml::Value::as_table)
            .is_some_and(|custom| custom.is_empty());
        if remove_empty_custom {
            value
                .get_mut("model_providers")
                .and_then(toml::Value::as_table_mut)
                .expect("model providers is a table")
                .remove("custom");
        }
        let remove_empty_providers = value
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .is_some_and(|providers| providers.is_empty());
        if remove_empty_providers {
            value
                .as_table_mut()
                .expect("TOML root is always a table")
                .remove("model_providers");
        }
    }
    Ok(before == after)
}

pub(crate) fn owned_configuration_fingerprint(
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
            "auth": value.get("auth"),
        })),
        "auth_openai_key": auth.get("OPENAI_API_KEY"),
    });
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&snapshot)?)
    ))
}

pub(crate) fn owned_configuration_fingerprint_v1(
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
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&snapshot)?)
    ))
}

pub(crate) fn backup_snapshot_fingerprint_match(
    manifest: &BackupManifest,
    config_text: &str,
    auth_text: &str,
) -> Result<Option<u8>, SwitcherError> {
    let Some(expected) = manifest.snapshot_fingerprint.as_deref() else {
        return Ok(None);
    };
    if owned_configuration_fingerprint(config_text, auth_text)? == expected {
        return Ok(Some(CURRENT_BACKUP_FINGERPRINT_VERSION));
    }
    if manifest.fingerprint_version < CURRENT_BACKUP_FINGERPRINT_VERSION
        && owned_configuration_fingerprint_v1(config_text, auth_text)? == expected
    {
        return Ok(Some(1));
    }
    Ok(None)
}

pub(crate) fn bytes_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn non_empty_environment_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn resolve_codex_home(
    development_override: Option<PathBuf>,
    codex_override: Option<PathBuf>,
    user_home: PathBuf,
) -> PathBuf {
    development_override
        .or(codex_override)
        .unwrap_or_else(|| user_home.join(".codex"))
}

pub(crate) fn codex_home() -> Result<PathBuf, SwitcherError> {
    let user_home = dirs::home_dir().ok_or(SwitcherError::MissingHome)?;
    Ok(resolve_codex_home(
        non_empty_environment_path(CODEX_HOME_ENV),
        non_empty_environment_path(OFFICIAL_CODEX_HOME_ENV),
        user_home,
    ))
}

pub(crate) fn root_config_path() -> Result<PathBuf, SwitcherError> {
    Ok(codex_home()?.join("config.toml"))
}

pub(crate) fn connection_environment_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(CONNECTION_ENVIRONMENT_FILE))
}

pub(crate) fn load_connection_environment_record() -> StoredConnectionEnvironment {
    let Ok(path) = connection_environment_path() else {
        return StoredConnectionEnvironment::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return StoredConnectionEnvironment::default();
    };
    parse_json_document(&text).unwrap_or_default()
}

pub(crate) fn save_connection_environment_record(
    record: &StoredConnectionEnvironment,
) -> Result<(), SwitcherError> {
    ensure_dirs()?;
    write_bytes_atomically(
        &connection_environment_path()?,
        serde_json::to_string_pretty(record)?.as_bytes(),
    )
}

pub(crate) fn configuration_layer_candidates(
) -> Result<Vec<(String, PathBuf, String)>, SwitcherError> {
    let root = root_config_path()?;
    let mut layers = vec![(
        "user-config".to_string(),
        root,
        "当前 Codex 用户配置".to_string(),
    )];
    for path in discovered_profile_configs()? {
        let Some(name) = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        layers.push((
            format!("profile:{name}"),
            path,
            format!("Profile 配置 · {name}"),
        ));
    }
    Ok(layers)
}

pub(crate) fn config_path() -> Result<PathBuf, SwitcherError> {
    let record = load_connection_environment_record();
    let candidates = configuration_layer_candidates()?;
    if let Some(selected) = record.selected_layer_id {
        if let Some((_, path, _)) = candidates.into_iter().find(|(id, _, _)| id == &selected) {
            return Ok(path);
        }
    }
    root_config_path()
}

pub(crate) fn discovered_profile_configs() -> Result<Vec<PathBuf>, SwitcherError> {
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

pub(crate) fn configuration_layer_check() -> ValidationCheck {
    match configuration_layer_candidates() {
        Err(error) => check(
            "configuration-layer",
            "配置写入位置",
            false,
            &format!("无法确认 Codex 配置位置：{error}"),
            "required",
        ),
        Ok(layers) => {
            let record = load_connection_environment_record();
            let selected_valid = record
                .selected_layer_id
                .as_ref()
                .is_some_and(|selected| layers.iter().any(|(id, _, _)| id == selected));
            check(
                "configuration-layer",
                "连接环境",
                record.setup_completed && selected_valid,
                if record.setup_completed && selected_valid {
                    "已选择并准备安全写入的 Codex 配置层。"
                } else if layers.len() > 1 {
                    "检测到多个 Codex 配置层。请在“开始使用”中选择本次要管理的配置层；程序不会猜测。"
                } else {
                    "首次使用前请先准备连接环境；程序会创建恢复点并只写入服务商所需字段。"
                },
                "required",
            )
        }
    }
}

pub(crate) fn ensure_configuration_layer_is_unambiguous() -> Result<(), SwitcherError> {
    let record = load_connection_environment_record();
    let valid = record.selected_layer_id.as_ref().is_some_and(|selected| {
        configuration_layer_candidates()
            .map(|layers| layers.iter().any(|(id, _, _)| id == selected))
            .unwrap_or(false)
    });
    if record.setup_completed && valid {
        return Ok(());
    }
    Err(SwitcherError::Message(
        "切换已阻止：请先在“开始使用”中选择并准备要管理的 Codex 配置层。程序不会猜测写入位置。"
            .to_string(),
    ))
}

pub(crate) fn auth_path() -> Result<PathBuf, SwitcherError> {
    Ok(codex_home()?.join("auth.json"))
}

pub(crate) fn app_data_dir() -> Result<PathBuf, SwitcherError> {
    if let Some(path) = env::var_os(APP_DATA_DIR_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let base = dirs::data_local_dir().ok_or(SwitcherError::MissingHome)?;
    Ok(base.join(APP_DIR_NAME))
}

pub(crate) fn profiles_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(PROFILES_FILE))
}

pub(crate) fn activity_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(ACTIVITY_FILE))
}

pub(crate) fn backups_dir() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(BACKUPS_DIR))
}

pub(crate) fn pending_transaction_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(PENDING_TRANSACTION_FILE))
}

pub(crate) fn switch_preflight_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(SWITCH_PREFLIGHT_FILE))
}

pub(crate) fn operation_receipts_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(OPERATION_RECEIPTS_FILE))
}

pub(crate) fn startup_diagnostics_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(STARTUP_DIAGNOSTICS_FILE))
}

pub(crate) fn ensure_dirs() -> Result<(), SwitcherError> {
    fs::create_dir_all(app_data_dir()?)?;
    fs::create_dir_all(backups_dir()?)?;
    Ok(())
}

pub(crate) fn begin_config_transaction(
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

pub(crate) fn update_config_transaction_phase(phase: &str) -> Result<(), SwitcherError> {
    let path = pending_transaction_path()?;
    let text = fs::read_to_string(&path)?;
    let mut transaction: PendingConfigTransaction = serde_json::from_str(&text)?;
    transaction.phase = phase.to_string();
    write_bytes_atomically(
        &path,
        serde_json::to_string_pretty(&transaction)?.as_bytes(),
    )
}

pub(crate) fn complete_config_transaction() -> Result<(), SwitcherError> {
    let path = pending_transaction_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn load_operation_receipts() -> Result<Vec<ConfigOperationReceipt>, SwitcherError> {
    let path = operation_receipts_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&fs::read_to_string(path)?).map_err(SwitcherError::from)
}

pub(crate) fn record_operation_receipt(
    receipt: ConfigOperationReceipt,
) -> Result<(), SwitcherError> {
    let mut receipts = load_operation_receipts()?;
    receipts.push(receipt);
    receipts.drain(..receipts.len().saturating_sub(100));
    write_bytes_atomically(
        &operation_receipts_path()?,
        serde_json::to_string_pretty(&receipts)?.as_bytes(),
    )
}

pub(crate) fn current_owned_fingerprint() -> Result<String, SwitcherError> {
    owned_configuration_fingerprint(
        &fs::read_to_string(config_path()?)?,
        &fs::read_to_string(auth_path()?)?,
    )
}

pub(crate) fn current_state_is_safe_to_restore(
    manifest: &BackupManifest,
) -> Result<(), SwitcherError> {
    let config = fs::read_to_string(config_path()?)?;
    let auth = fs::read_to_string(auth_path()?)?;
    if backup_snapshot_fingerprint_match(manifest, &config, &auth)?.is_some() {
        return Ok(());
    }
    let current = owned_configuration_fingerprint(&config, &auth)?;
    let legacy_current = (manifest.fingerprint_version < CURRENT_BACKUP_FINGERPRINT_VERSION)
        .then(|| owned_configuration_fingerprint_v1(&config, &auth))
        .transpose()?;
    let receipts = load_operation_receipts()?;
    let latest = receipts.last().ok_or_else(|| {
        SwitcherError::Message(
            "当前服务商设置没有可验证的 Signalman 变更回执，已停止自动恢复。".to_string(),
        )
    })?;
    let current_matches_receipt = latest.after_fingerprint == current
        || (latest.fingerprint_version < CURRENT_BACKUP_FINGERPRINT_VERSION
            && legacy_current.as_deref() == Some(latest.after_fingerprint.as_str()));
    if !current_matches_receipt {
        return Err(SwitcherError::Message(
            "检测到服务商或认证设置在上次 Signalman 操作后发生变化；已停止自动恢复。".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn protect_secret(bytes: &[u8]) -> Result<String, SwitcherError> {
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

pub(crate) fn unprotect_secret(value: &str) -> Result<Vec<u8>, SwitcherError> {
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

pub(crate) fn protect_file(source: &Path, destination: &Path) -> Result<(), SwitcherError> {
    let raw = fs::read(source)?;
    write_bytes_atomically(destination, protect_secret(&raw)?.as_bytes())
}

pub(crate) fn write_bytes_atomically(
    destination: &Path,
    bytes: &[u8],
) -> Result<(), SwitcherError> {
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
pub(crate) fn replace_file_atomically(
    temporary: &Path,
    destination: &Path,
) -> Result<(), SwitcherError> {
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
pub(crate) fn replace_file_atomically(
    temporary: &Path,
    destination: &Path,
) -> Result<(), SwitcherError> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct FileSnapshot {
    pub(crate) exists: bool,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn capture_file(path: &Path) -> Result<FileSnapshot, SwitcherError> {
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

pub(crate) fn restore_file_snapshot(
    path: &Path,
    snapshot: &FileSnapshot,
) -> Result<(), SwitcherError> {
    if snapshot.exists {
        write_bytes_atomically(path, &snapshot.bytes)
    } else if path.exists() {
        fs::remove_file(path)?;
        Ok(())
    } else {
        Ok(())
    }
}

pub(crate) fn migrate_legacy_backups() -> Result<(), SwitcherError> {
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

pub(crate) fn normalize_id(name: &str) -> String {
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

/// Return a stable, non-empty identifier for a provider display name.
///
/// Display names are user-facing and may be entirely Unicode. The old
/// ASCII-only normalizer returned an empty string for names such as
/// "中转服务", and reduced different names containing the same ASCII suffix
/// to the same key. Keep readable slugs where possible, and use a short hash
/// only when the name has no ASCII material at all.
pub(crate) fn provider_id_base(name: &str) -> String {
    let normalized = normalize_id(name);
    if !normalized.is_empty() {
        return normalized;
    }
    let digest = format!("{:x}", Sha256::digest(name.trim().as_bytes()));
    format!("provider-{}", &digest[..12])
}

pub(crate) fn create_backup_with_label(
    label: &str,
    reason: &str,
) -> Result<PathBuf, SwitcherError> {
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
        fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
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

pub(crate) fn managed_manual_backup_count() -> Result<usize, SwitcherError> {
    Ok(fs::read_dir(backups_dir()?)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| fs::read_to_string(entry.path().join("manifest.json")).ok())
        .filter_map(|text| serde_json::from_str::<BackupManifest>(&text).ok())
        .filter(|manifest| manifest.reason == "manual" && manifest.retention_managed)
        .count())
}

pub(crate) struct BackupStaging {
    path: PathBuf,
    committed: bool,
}

impl BackupStaging {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    pub(crate) fn commit(&mut self) {
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

pub(crate) fn ensure_initial_backup() -> Result<bool, SwitcherError> {
    let initial_dir = backups_dir()?.join(INITIAL_BACKUP_LABEL);
    if initial_dir.join("manifest.json").exists() {
        return Ok(false);
    }
    create_backup_with_label(INITIAL_BACKUP_LABEL, "initial_install")?;
    Ok(true)
}

pub(crate) fn create_backup() -> Result<PathBuf, SwitcherError> {
    ensure_initial_backup()?;
    let label = unique_backup_label("before");
    create_backup_with_label(&label, "before_switch")
}

pub(crate) fn unique_backup_label(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        std::process::id(),
        Local::now().timestamp_subsec_micros()
    )
}

pub(crate) fn seed_catalog_from_existing() -> Result<StoredCatalog, SwitcherError> {
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

pub(crate) fn default_invariants() -> Value {
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

pub(crate) fn load_catalog() -> Result<StoredCatalog, SwitcherError> {
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

pub(crate) fn parse_json_document<T>(document: &str) -> Result<T, SwitcherError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(document.trim_start_matches('\u{feff}')).map_err(SwitcherError::from)
}

pub(crate) fn hydrate_catalog_secrets(catalog: &mut StoredCatalog) -> Result<bool, SwitcherError> {
    let mut migrated = false;
    for value in catalog.profiles.values_mut() {
        let mut profile: StoredProfile = serde_json::from_value(value.clone())?;
        let preferred_mode = preferred_auth_mode(&profile.name, &profile.base_url);
        if profile.auth_mode.trim().is_empty()
            || (preferred_mode == "provider_command" && profile.auth_mode == default_auth_mode())
        {
            profile.auth_mode = preferred_mode;
            migrated = true;
        }
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

pub(crate) fn normalize_catalog(catalog: &mut StoredCatalog) {
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

pub(crate) fn save_catalog(catalog: &StoredCatalog) -> Result<(), SwitcherError> {
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

/// Build the auth document for a provider switch without performing I/O.
/// Keeping this JSON transformation beside the TOML preservation helpers makes
/// the write transaction in `lib.rs` an orchestration concern only.
pub(crate) fn build_next_auth(
    original: &str,
    profile: &StoredProfile,
) -> Result<String, SwitcherError> {
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

pub(crate) fn replace_root_kv(line: &str, key: &str, value: &str) -> Option<String> {
    if line.trim_start().starts_with(&format!("{key} =")) {
        Some(format!("{key} = \"{value}\""))
    } else {
        None
    }
}

pub(crate) fn root_section_end(lines: &[String]) -> usize {
    lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len())
}

pub(crate) fn upsert_root_string(lines: &mut Vec<String>, key: &str, value: &str) {
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

pub(crate) fn upsert_root_bool(lines: &mut Vec<String>, key: &str, value: bool) {
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

pub(crate) fn remove_root_key(lines: &mut Vec<String>, key: &str) {
    let root_end = root_section_end(lines);
    let prefix = format!("{key} ");
    let mut index = 0usize;
    lines.retain(|line| {
        let retain = index >= root_end || !line.trim_start().starts_with(&prefix);
        index += 1;
        retain
    });
}

pub(crate) fn upsert_section_string(
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

pub(crate) fn upsert_section_bool(
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

pub(crate) fn remove_section_key(
    lines: &mut Vec<String>,
    start: usize,
    end: &mut usize,
    key: &str,
) {
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

pub(crate) fn remove_section(lines: &mut Vec<String>, header: &str) {
    let Some(start) = lines.iter().position(|line| line.trim() == header) else {
        return;
    };
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    lines.drain(start..end);
}

pub(crate) fn section_block(document: &str, header: &str) -> Option<Vec<String>> {
    let lines = document
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let start = lines.iter().position(|line| line.trim() == header)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    Some(lines[start..end].to_vec())
}

pub(crate) fn provider_command_auth_script() -> &'static str {
    // CODEX_HOME is Codex's public override. When it is absent both Codex and
    // Signalman fall back to the same per-user .codex directory. The internal
    // development override deliberately never appears in a user config.
    "$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }; Get-Content -LiteralPath (Join-Path $codexHome 'auth.json') -Raw | ConvertFrom-Json | Select-Object -ExpandProperty OPENAI_API_KEY"
}

pub(crate) fn append_provider_command_auth(lines: &mut Vec<String>, end: &mut usize) {
    // Keep the command deterministic and local. Signalman writes the selected
    // key to auth.json in the same transaction; Codex then reads it through
    // the provider-level auth command instead of relying on custom Bearer
    // handling.
    let command = provider_command_auth_script();
    lines.insert(*end, "[model_providers.custom.auth]".to_string());
    *end += 1;
    lines.insert(*end, "command = \"powershell.exe\"".to_string());
    *end += 1;
    lines.insert(
        *end,
        format!(
            "args = [\"-NoProfile\", \"-NonInteractive\", \"-Command\", \"{}\"]",
            command.replace('"', "\\\"")
        ),
    );
    *end += 1;
}

pub(crate) fn build_next_config(
    original: &str,
    profile: &StoredProfile,
) -> Result<String, SwitcherError> {
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

    if lines
        .iter()
        .all(|line| line.trim() != "[model_providers.custom]")
    {
        if !lines.is_empty() && !lines.last().is_some_and(|line| line.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push("[model_providers.custom]".to_string());
    }
    let start = lines
        .iter()
        .position(|line| line.trim() == "[model_providers.custom]")
        .expect("custom provider section was just created when missing");
    let mut end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(idx, _)| idx)
        .unwrap_or(lines.len());

    upsert_section_string(&mut lines, start, &mut end, "name", &profile.name);
    upsert_section_string(&mut lines, start, &mut end, "wire_api", "responses");
    remove_section(&mut lines, "[model_providers.custom.auth]");
    // Removing a child section can move the parent boundary. Recompute it
    // before writing the selected provider contract.
    let mut end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(idx, _)| idx)
        .unwrap_or(lines.len());
    remove_section_key(&mut lines, start, &mut end, "requires_openai_auth");
    if uses_provider_command_auth(profile) {
        append_provider_command_auth(&mut lines, &mut end);
    } else {
        upsert_section_bool(
            &mut lines,
            start,
            &mut end,
            "requires_openai_auth",
            !uses_profile_credential,
        );
    }
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

pub(crate) fn build_connection_environment_config(original: &str) -> Result<String, SwitcherError> {
    let mut lines: Vec<String> = original.lines().map(ToString::to_string).collect();
    toml::from_str::<toml::Value>(original)?;
    upsert_root_bool(&mut lines, "disable_response_storage", true);
    // A new user has no provider endpoint, model, or credential yet. Creating
    // a selected custom provider at this point makes Codex send an incomplete
    // request and can combine an official endpoint with a third-party key.
    // Keep an existing custom provider compatible, but create/select one only
    // as part of the first real provider switch.
    if lines
        .iter()
        .any(|line| line.trim() == "[model_providers.custom]")
    {
        let start = lines
            .iter()
            .position(|line| line.trim() == "[model_providers.custom]")
            .unwrap_or(0);
        let mut end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim_start().starts_with('['))
            .map(|(index, _)| index)
            .unwrap_or(lines.len());
        upsert_section_string(&mut lines, start, &mut end, "wire_api", "responses");
    }
    let next = lines.join("\r\n");
    if !protected_sections_match(original, &next)? {
        return Err(SwitcherError::Message(
            "连接环境准备已阻止：检测到受保护设置会被改动。".to_string(),
        ));
    }
    Ok(next)
}
