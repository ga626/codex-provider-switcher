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
            let source_name = file_name.trim_end_matches(".dpapi");
            if manifest.missing_files.iter().any(|file| file == source_name)
            {
                if backup_dir.join(file_name).exists() {
                    return Err(SwitcherError::Message("恢复点的文件缺失记录与实际内容冲突。".into()));
                }
                continue;
            }
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
    let config_missing = manifest.missing_files.iter().any(|file| file == "config.toml");
    let config = if config_missing {
        String::new()
    } else {
        String::from_utf8(unprotect_secret(&fs::read_to_string(backup_dir.join("config.toml.dpapi"))?)?)
            .map_err(|_| SwitcherError::Message("恢复点中的设置文件不是 UTF-8 文本。".to_string()))?
    };
    let auth = if manifest
        .missing_files
        .iter()
        .any(|file| file == "auth.json")
    {
        "{}".into()
    } else {
        String::from_utf8(unprotect_secret(&fs::read_to_string(
            backup_dir.join("auth.json.dpapi"),
        )?)?)
        .map_err(|_| SwitcherError::Message("恢复点中的认证文件不是 UTF-8 文本。".to_string()))?
    };
    if !serde_json::from_str::<Value>(&auth)?.is_object() {
        return Err(SwitcherError::Message("恢复点中的认证文件不是 JSON 对象。".into()));
    }
    toml::from_str::<toml::Value>(&config)?;
    if config_missing {
        if manifest.snapshot_fingerprint.is_some() || manifest.protected_fingerprint.is_some() {
            return Err(SwitcherError::Message("空配置恢复点包含冲突的配置摘要。".into()));
        }
    } else if backup_snapshot_fingerprint_match(manifest, &config, &auth)?.is_none() {
        return Err(SwitcherError::Message(
            "恢复点与记录的配置摘要不一致。".to_string(),
        ));
    }
    if let Some(expected) = manifest.protected_fingerprint.as_deref() {
        let actual = if manifest.fingerprint_version <= 2 {
            protected_configuration_fingerprint_legacy(&config, &auth)?
        } else {
            protected_configuration_fingerprint(&config, &auth)?
        };
        if actual != expected {
            return Err(SwitcherError::Message(
                "恢复点的受保护配置摘要不一致。".to_string(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn healthy_baseline_backup() -> Result<(), SwitcherError> {
    if initial_backup_is_healthy() || takeover_backup_is_healthy(&load_connection_environment_record()) {
        return Ok(());
    }
    Err(SwitcherError::Message("首次基线和接管恢复点均不可用，请重新准备连接环境；旧备份会保留，并验证新的恢复点。".into()))
}

pub(crate) fn initial_backup_is_healthy() -> bool {
    let Ok(root) = backups_dir() else { return false };
    let dir = root.join(INITIAL_BACKUP_LABEL);
    fs::read_to_string(dir.join("manifest.json")).ok()
        .and_then(|text| serde_json::from_str::<BackupManifest>(&text).ok())
        .is_some_and(|manifest| backup_manifest_health(&dir, &manifest).is_ok())
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
        .and_then(|providers| providers.get("custom"));
    let current_config = read_config()?;
    let mut lines = current_config
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    for key in ["model", "model_provider"] {
        if let Some(value) = backup_config_value.get(key).and_then(toml::Value::as_str) {
            upsert_root_string(&mut lines, key, value);
        } else {
            remove_root_key(&mut lines, key);
        }
    }
    remove_root_key(&mut lines, "model_reasoning_effort");
    if let Some(reasoning_effort) = backup_config_value
        .get("model_reasoning_effort")
        .and_then(toml::Value::as_str)
    {
        upsert_root_string(&mut lines, "model_reasoning_effort", reasoning_effort);
    }
    if let Some(value) = optional_toml_bool(&backup_config_value, "disable_response_storage") {
        upsert_root_bool(&mut lines, "disable_response_storage", value);
    } else {
        remove_root_key(&mut lines, "disable_response_storage");
    }
    if let Some(value) = backup_config_value
        .get("model_catalog_json")
        .and_then(toml::Value::as_str)
    {
        upsert_root_string(&mut lines, "model_catalog_json", value);
    } else {
        remove_root_key(&mut lines, "model_catalog_json");
    }
    if let Some(backup_custom) = backup_custom {
        if !lines
            .iter()
            .any(|line| line.trim() == "[model_providers.custom]")
        {
            lines.push("[model_providers.custom]".into());
        }
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
            if let Some(value) = backup_custom.get(key).and_then(toml::Value::as_str) {
                upsert_section_string(&mut lines, start, &mut end, key, value);
            }
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
    } else {
        remove_section(&mut lines, "[model_providers.custom.auth]");
        // Remove only managed keys, never foreign/custom extension settings.
        if let Some(start) = lines
            .iter()
            .position(|line| line.trim() == "[model_providers.custom]")
        {
            let mut end = lines
                .iter()
                .enumerate()
                .skip(start + 1)
                .find(|(_, l)| l.trim_start().starts_with('['))
                .map(|(i, _)| i)
                .unwrap_or(lines.len());
            for key in [
                "name",
                "base_url",
                "wire_api",
                "api_key",
                "env_key",
                "experimental_bearer_token",
                "requires_openai_auth",
            ] {
                remove_section_key(&mut lines, start, &mut end, key);
            }
            if end == start + 1 || lines[start + 1..end].iter().all(|l| l.trim().is_empty()) {
                lines.drain(start..end);
            }
        }
    }
    let next_config = lines.join("\r\n");
    if !protected_sections_match(&current_config, &next_config)? {
        return Err(SwitcherError::Message(
            "恢复已阻止：检测到 MCP、插件、项目或其他受保护设置会被改动。".to_string(),
        ));
    }
    let current_auth_text = read_auth()?;
    let current_auth_value: Value = serde_json::from_str(&current_auth_text)?;
    // Modern OAuth is owned by Codex, including token refreshes after backup.
    if current_auth_value.get("tokens").is_some()
        || current_auth_value.get("auth_mode").and_then(Value::as_str) == Some("chatgpt")
        || !manifest.files.iter().any(|f| f == "auth.json.dpapi")
    {
        return Ok((next_config, None));
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

pub(crate) fn full_config_from_backup(
    backup_dir: &Path,
    manifest: &BackupManifest,
) -> Result<String, SwitcherError> {
    if !manifest
        .files
        .iter()
        .any(|file| file == "config.toml.dpapi")
    {
        return Err(SwitcherError::Message(
            "这个恢复点没有完整的 Codex 设置文件，无法救援。".to_string(),
        ));
    }
    let protected = fs::read(backup_dir.join("config.toml.dpapi"))?;
    let expected_digest = manifest
        .file_digests
        .get("config.toml.dpapi")
        .ok_or_else(|| SwitcherError::Message("恢复点缺少完整性摘要。".to_string()))?;
    if bytes_digest(&protected) != *expected_digest {
        return Err(SwitcherError::Message("恢复点完整性校验失败。".to_string()));
    }
    let encoded = String::from_utf8(protected)
        .map_err(|_| SwitcherError::Message("恢复点格式无效。".to_string()))?;
    let bytes = unprotect_secret(&encoded)?;
    let config = String::from_utf8(bytes)
        .map_err(|_| SwitcherError::Message("恢复点中的设置文件不是 UTF-8 文本。".to_string()))?;
    toml::from_str::<toml::Value>(&config).map_err(|_| {
        SwitcherError::Message("恢复点中的设置文件也无法解析，不能安全救援。".to_string())
    })?;
    Ok(config)
}

pub(crate) fn preserve_damaged_config(
    evidence_root: &Path,
    original: Option<&[u8]>,
) -> Result<PathBuf, SwitcherError> {
    fs::create_dir_all(evidence_root)?;
    let dir = evidence_root.join(unique_backup_label("damaged-config"));
    fs::create_dir(&dir)?;
    if let Some(original) = original {
        let protected = protect_secret(original)?;
        write_bytes_atomically(&dir.join("config.toml.dpapi"), protected.as_bytes())?;
    }
    let receipt = serde_json::json!({
        "schema_version": 1,
        "created_at": now_label(),
        "file": if original.is_some() { "config.toml.dpapi" } else { "config.toml was missing" },
        "sha256": original.map(bytes_digest),
        "note": "损坏原件只在存在且可读取时加密留档；未包含认证文件。"
    });
    write_bytes_atomically(
        &dir.join("manifest.json"),
        serde_json::to_string_pretty(&receipt)?.as_bytes(),
    )?;
    Ok(dir)
}

pub(crate) fn recover_damaged_config(
    config_path: &Path,
    evidence_root: &Path,
    backup_dir: &Path,
    manifest: &BackupManifest,
    confirmation: &str,
) -> Result<PathBuf, SwitcherError> {
    if confirmation.trim() != "恢复全部配置" {
        return Err(SwitcherError::Message(
            "完整救援必须输入“恢复全部配置”确认。".to_string(),
        ));
    }
    let original = match fs::read(config_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let candidate = full_config_from_backup(backup_dir, manifest)?;
    let evidence = preserve_damaged_config(evidence_root, original.as_deref())?;
    write_recovery_target(config_path, candidate.as_bytes())?;
    let restored = fs::read_to_string(config_path)?;
    if restored != candidate || toml::from_str::<toml::Value>(&restored).is_err() {
        return Err(SwitcherError::Message(
            "完整恢复后的设置未通过回读校验；没有报告恢复成功。请保留恢复中心中的原件留档。"
                .to_string(),
        ));
    }
    Ok(evidence)
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
    if transaction_writer_is_active(transaction.writer_pid) {
        // A running writer owns this transaction. Returning here lets state
        // reads continue without rolling back an operation in another window.
        return Ok(());
    }
    let config_target = transaction.config_path.clone().unwrap_or(config_path()?);
    let auth_target = transaction.auth_path.clone().unwrap_or(auth_path()?);
    if auth_target != auth_path()? || (transaction.reason != "initialization" && config_target != config_path()?)
        || (transaction.reason == "initialization" && config_target != root_config_path()?) {
        return Err(SwitcherError::Message("未完成事务的配置位置与当前环境不一致；已停止自动恢复。".into()));
    }
    if transaction.reason == "initialization" {
        if transaction.phase != "verified" {
            if let Some(candidate) = &transaction.candidate_fingerprint {
                let current_config = if config_target.is_file() { fs::read_to_string(&config_target)? } else { String::new() };
                let current_auth = if auth_target.is_file() { fs::read_to_string(&auth_target)? } else { "{}".into() };
                let current = owned_configuration_fingerprint(&current_config, &current_auth)?;
                if current != *candidate && current != transaction.before_fingerprint {
                    return Err(SwitcherError::Message("初始化中断后配置又被外部修改；事务已保留，请使用安全恢复。".into()));
                }
            }
            let (backup_dir, manifest) = read_backup_manifest(&transaction.backup_id)?;
            let original = if manifest.missing_files.iter().any(|name| name == "config.toml") {
                String::new()
            } else {
                String::from_utf8(unprotect_secret(&fs::read_to_string(backup_dir.join("config.toml.dpapi"))?)?)
                    .map_err(|_| SwitcherError::Message("初始化恢复点不是 UTF-8 文本。".into()))?
            };
            let current = if config_target.is_file() { fs::read_to_string(&config_target)? } else { String::new() };
            if !initialization_owned_change_only(&original, &current)? {
                return Err(SwitcherError::Message("初始化中断后受保护配置被外部修改；原件和事务已保留，请使用安全恢复。".into()));
            }
            recover_initialization_files_at(&backup_dir, &manifest, &config_target, &auth_target)?;
            if let Some(previous) = &transaction.previous_environment {
                save_connection_environment_record(previous)?;
            }
        }
        return complete_config_transaction();
    }
    // The write and its receipt already passed verification. A crash while
    // deleting the journal must not undo a successfully completed operation.
    if transaction.phase == "verified" {
        return complete_config_transaction();
    }
    let (backup_dir, manifest) = read_backup_manifest(&transaction.backup_id)?;
    let (next_config, next_auth) = restored_owned_files(&backup_dir, &manifest).map_err(|_| {
        SwitcherError::Message(
            "检测到未完成的配置写入，但无法安全构造恢复内容；请勿继续切换。".to_string(),
        )
    })?;
    write_bytes_atomically(&config_path()?, next_config.as_bytes()).map_err(|_| {
        SwitcherError::Message("检测到未完成的配置写入，但自动恢复失败；请勿继续切换。".to_string())
    })?;
    if transaction.reason != "switch" {
        if let Some(next_auth) = next_auth {
            write_bytes_atomically(&auth_path()?, next_auth.as_bytes()).map_err(|_| {
                SwitcherError::Message(
                    "检测到未完成的认证写入，但自动恢复失败；请勿继续切换。".to_string(),
                )
            })?;
        }
    }
    complete_config_transaction()
}

fn recover_initialization_files_at(backup: &Path, manifest: &BackupManifest, config: &Path, auth: &Path) -> Result<(), SwitcherError> {
    backup_manifest_health(backup, manifest)?;
    let missing_config = manifest.missing_files.iter().any(|name| name == "config.toml");
    let bytes = if missing_config { Vec::new() } else { unprotect_secret(&fs::read_to_string(backup.join("config.toml.dpapi"))?)? };
    let snapshot = FileSnapshot { exists: !missing_config, bytes };
    restore_file_snapshot(config, &snapshot)?;
    let confirmed = capture_file(config)?;
    if confirmed.exists != snapshot.exists || confirmed.bytes != snapshot.bytes {
        return Err(SwitcherError::Message("初始化中断恢复未通过回读；事务标记已保留。".into()));
    }
    // 初始化从不覆盖已有 OAuth；只撤销它为原本空环境创建的 {}。
    if manifest.missing_files.iter().any(|name| name == "auth.json")
        && auth.is_file() && fs::read(auth)? == b"{}" {
        fs::remove_file(auth)?;
    }
    Ok(())
}

fn transaction_writer_is_active(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0_u32;
        let queried = GetExitCodeProcess(process, &mut exit_code);
        CloseHandle(process);
        queried != 0 && exit_code == STILL_ACTIVE as u32
    }
    #[cfg(not(windows))]
    {
        false
    }
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
            if takeover_backup_is_healthy(&load_connection_environment_record()) {
                "首次基线已损坏，但接管恢复点健康，可以继续切换。旧基线保留；请在恢复点列表中选择健康恢复点，新恢复点不能还原丢失的安装前原件。".to_string()
            } else {
                "首次基线和接管恢复点不可用；请重新准备连接环境，保留旧件并创建健康恢复点。安全恢复入口仍可使用。".to_string()
            }
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
        "model_catalog_json",
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

pub(crate) fn initialization_owned_change_only(before: &str, after: &str) -> Result<bool, SwitcherError> {
    let normalize = |text: &str| {
        let mut lines = text.lines().map(str::to_string).collect::<Vec<_>>();
        // Initialization explicitly owns these two old official-route overrides.
        remove_root_key(&mut lines, "openai_base_url");
        remove_root_key(&mut lines, "chatgpt_base_url");
        lines.join("\n")
    };
    only_provider_owned_configuration_changed(&normalize(before), &normalize(after))
}

pub(crate) fn owned_configuration_fingerprint(
    config_text: &str,
    auth_text: &str,
) -> Result<String, SwitcherError> {
    let config = toml::from_str::<toml::Value>(config_text)?;
    let snapshot = json!({
        "provider_v2": owned_configuration_fingerprint_v2(config_text, auth_text)?,
        "model_catalog_json": config.get("model_catalog_json"),
        "model_reasoning_effort": config.get("model_reasoning_effort"),
    });
    Ok(bytes_digest(&serde_json::to_vec(&snapshot)?))
}

// v2 和 v1 是已交付的历史合同，不随新字段改变。
pub(crate) fn owned_configuration_fingerprint_v2(
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

/// Hash the complete non-provider portion of config.toml and auth.json.
/// Unlike the older semantic section check this also covers unknown root
/// fields, future Codex sections, and every auth.json key except the one key
/// explicitly owned by the selected profile.
pub(crate) fn protected_configuration_fingerprint(
    config_text: &str,
    auth_text: &str,
) -> Result<String, SwitcherError> {
    protected_configuration_fingerprint_with_catalog(config_text, auth_text, true)
}

fn protected_configuration_fingerprint_legacy(config_text: &str, auth_text: &str) -> Result<String, SwitcherError> {
    protected_configuration_fingerprint_with_catalog(config_text, auth_text, false)
}

fn protected_configuration_fingerprint_with_catalog(config_text: &str, auth_text: &str, owns_catalog: bool) -> Result<String, SwitcherError> {
    let mut config = toml::from_str::<toml::Value>(config_text)?;
    let mut auth = serde_json::from_str::<Value>(auth_text)?;
    if let Some(root) = config.as_table_mut() {
        for key in [
            "model",
            "model_provider",
            "model_reasoning_effort",
            "disable_response_storage",
        ] {
            root.remove(key);
        }
        if owns_catalog { root.remove("model_catalog_json"); }
        if let Some(providers) = root
            .get_mut("model_providers")
            .and_then(toml::Value::as_table_mut)
        {
            if let Some(custom) = providers
                .get_mut("custom")
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
                    "auth",
                ] {
                    custom.remove(key);
                }
                if custom.is_empty() {
                    providers.remove("custom");
                }
            }
            if providers.is_empty() {
                root.remove("model_providers");
            }
        }
    }
    if let Some(object) = auth.as_object_mut() {
        object.remove("OPENAI_API_KEY");
    }
    let snapshot = json!({ "config": config, "auth": auth });
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

#[cfg(test)]
mod initialization_repair_tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        let root = env::temp_dir().join(unique_backup_label("signalman-initialization-test"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn takeover_reuses_healthy_backup_and_preserves_invalid_originals() {
        let root = fixture_root();
        let config = root.join("config.toml");
        let auth = root.join("auth.json");
        fs::write(&config, "model='fixture'\n").unwrap();
        fs::write(&auth, "{}").unwrap();
        let backups = root.join("backups");
        let first = ensure_takeover_backup_at(&backups, None, &config, &auth).unwrap();
        assert_eq!(ensure_takeover_backup_at(&backups, Some(&first), &config, &auth).unwrap(), first);
        for damage in ["missing", "truncated", "fingerprint", "manifest"] {
            let broken = create_backup_at(&backups, damage, "signalman_initial_takeover", &config, &auth).unwrap();
            match damage {
                "missing" => fs::remove_file(broken.join("config.toml.dpapi")).unwrap(),
                "truncated" => fs::write(broken.join("auth.json.dpapi"), "truncated").unwrap(),
                "fingerprint" => {
                    let path = broken.join("manifest.json");
                    let mut manifest: BackupManifest = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
                    manifest.snapshot_fingerprint = Some("wrong".into());
                    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
                }
                _ => fs::write(broken.join("manifest.json"), "{").unwrap(),
            }
            let old_manifest = fs::read(broken.join("manifest.json")).unwrap();
            let replacement = ensure_takeover_backup_at(&backups, Some(damage), &config, &auth).unwrap();
            assert_ne!(replacement, damage);
            assert!(broken.join("invalid-backup.json").is_file());
            assert_eq!(fs::read(broken.join("manifest.json")).unwrap(), old_manifest);
            let dir = backups.join(replacement);
            let manifest = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
            backup_manifest_health(&dir, &manifest).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn takeover_can_back_up_absent_config_and_optional_auth() {
        let root = fixture_root();
        let config = root.join("config.toml");
        let auth = root.join("auth.json");
        let backups = root.join("backups");
        let label = ensure_takeover_backup_at(&backups, None, &config, &auth).unwrap();
        let dir = backups.join(&label);
        let manifest: BackupManifest = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.missing_files.len(), 2);
        backup_manifest_health(&dir, &manifest).unwrap();
        fs::write(&config, "model='fixture'\n").unwrap();
        let dir = create_backup_at(&backups, "without-auth", "manual", &config, &auth).unwrap();
        let manifest = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        backup_manifest_health(&dir, &manifest).unwrap();
        fs::write(&auth, "[]").unwrap();
        assert!(create_backup_at(&backups, "invalid-auth", "manual", &config, &auth).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn historical_fingerprint_matches_frozen_pre_catalog_digest() {
        let config = "model='fixture-model'\nmodel_provider='custom'\ndisable_response_storage=true\n[model_providers.custom]\nname='fixture'\nwire_api='responses'\nbase_url='https://fixture.invalid/v1'\napi_key='fixture-key'\n";
        let auth = r#"{"OPENAI_API_KEY":"fixture-key"}"#;
        let expected = "0428f1eb5a32df8cf119b9530c3aa61a1f34da847eb2658dec07bccdda589a21";
        assert_eq!(owned_configuration_fingerprint_v1(config, auth).unwrap(), expected);
        let with_catalog = format!("model_catalog_json='C:/fixture/catalog.json'\n{config}");
        assert_eq!(owned_configuration_fingerprint_v1(&with_catalog, auth).unwrap(), expected);
    }

    #[test]
    fn catalog_path_drift_is_detected_without_changing_historical_contracts() {
        let original = "model='fixture'\nmodel_catalog_json='C:/fixture/old.json'\n";
        let changed = original.replace("old.json", "new.json");
        assert_ne!(owned_configuration_fingerprint(original, "{}").unwrap(), owned_configuration_fingerprint(&changed, "{}").unwrap());
        assert_eq!(owned_configuration_fingerprint_v2(original, "{}").unwrap(), owned_configuration_fingerprint_v2(&changed, "{}").unwrap());
        assert_eq!(owned_configuration_fingerprint_v1(original, "{}").unwrap(), owned_configuration_fingerprint_v1(&changed, "{}").unwrap());
        let manifest = BackupManifest {
            schema_version: 4, fingerprint_version: 2, created_at: "fixture".into(), reason: "manual".into(),
            files: vec![], missing_files: vec![], post_change_fingerprint: None,
            snapshot_fingerprint: Some(owned_configuration_fingerprint_v2(original, "{}").unwrap()),
            protected_fingerprint: None, file_digests: BTreeMap::new(), retention_managed: true,
        };
        assert_eq!(backup_snapshot_fingerprint_match(&manifest, original, "{}").unwrap(), Some(2));
        let mut new_manifest = manifest;
        new_manifest.fingerprint_version = 3;
        assert_eq!(backup_snapshot_fingerprint_match(&new_manifest, original, "{}").unwrap(), None);
        new_manifest.snapshot_fingerprint = Some(owned_configuration_fingerprint(original, "{}").unwrap());
        assert_eq!(backup_snapshot_fingerprint_match(&new_manifest, &changed, "{}").unwrap(), None);
    }

    #[test]
    fn historical_protected_catalog_digest_is_checked_in_its_own_version() {
        let root = fixture_root();
        let config = root.join("config.toml");
        let auth = root.join("auth.json");
        let original = "model='fixture'\nmodel_catalog_json='C:/fixture/original.json'\n[mcp_servers.keep]\ncommand='keep'\n";
        fs::write(&config, original).unwrap(); fs::write(&auth, "{}").unwrap();
        let dir = create_backup_at(&root.join("backups"), "legacy", "manual", &config, &auth).unwrap();
        let mut manifest: BackupManifest = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        manifest.fingerprint_version = 2;
        manifest.snapshot_fingerprint = Some(owned_configuration_fingerprint_v2(original, "{}").unwrap());
        manifest.protected_fingerprint = Some(protected_configuration_fingerprint_legacy(original, "{}").unwrap());
        assert_ne!(manifest.protected_fingerprint.as_ref().unwrap(), &protected_configuration_fingerprint(original, "{}").unwrap());
        backup_manifest_health(&dir, &manifest).unwrap();
        manifest.protected_fingerprint = Some("wrong".into());
        assert!(backup_manifest_health(&dir, &manifest).is_err());
        fs::remove_dir_all(root).unwrap();
    }
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
    if manifest.fingerprint_version <= 2
        && owned_configuration_fingerprint_v2(config_text, auth_text)? == expected
    {
        return Ok(Some(2));
    }
    if manifest.fingerprint_version < 2
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
    if let Some((_, home)) = qa::runtime_override()? {
        return Ok(home);
    }
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
                record.setup_completed
                    && selected_valid
                    && record.takeover_version >= SIGNALMAN_TAKEOVER_VERSION
                    && record.selected_layer_id.as_deref() == Some("user-config"),
                if record.setup_completed
                    && selected_valid
                    && record.takeover_version >= SIGNALMAN_TAKEOVER_VERSION
                    && record.selected_layer_id.as_deref() == Some("user-config")
                {
                    "已完成 Signalman 接管，当前固定写入用户级 Codex 配置。"
                } else {
                    "首次使用前请先完成 Signalman 接管；程序会先备份旧配置，再固定写入 custom 身份。"
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
    if record.setup_completed
        && valid
        && record.takeover_version >= SIGNALMAN_TAKEOVER_VERSION
        && record.selected_layer_id.as_deref() == Some("user-config")
    {
        return Ok(());
    }
    Err(SwitcherError::Message(
        "切换已阻止：请先完成 Signalman 首次接管。程序会先备份旧配置，再固定使用 custom 身份。"
            .to_string(),
    ))
}

pub(crate) fn auth_path() -> Result<PathBuf, SwitcherError> {
    Ok(codex_home()?.join("auth.json"))
}

pub(crate) fn app_data_dir() -> Result<PathBuf, SwitcherError> {
    if let Some((app, _)) = qa::runtime_override()? {
        return Ok(app);
    }
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
    // New installs keep recovery material beside the installed application,
    // separate from the user's Codex home. Existing app-data backups remain
    // the source of truth until explicitly migrated; never move or delete
    // them implicitly.
    if !is_development_release_channel() {
        if let Ok(executable) = std::env::current_exe() {
            if let Some(install_dir) = executable.parent() {
                let preferred = install_dir.join(INSTALL_BACKUP_DIR);
                let has_existing_app_backups = app_data_dir()
                    .map(|root| root.join(BACKUPS_DIR).join(INITIAL_BACKUP_LABEL).exists())
                    .unwrap_or(false);
                if !has_existing_app_backups && backup_directory_is_writable(&preferred) {
                    return Ok(preferred);
                }
            }
        }
    }
    Ok(app_data_dir()?.join(BACKUPS_DIR))
}

fn backup_directory_is_writable(path: &Path) -> bool {
    if fs::create_dir_all(path).is_err() {
        return false;
    }
    let probe = path.join(format!(".write-test-{}", std::process::id()));
    match OpenOptions::new().create_new(true).write(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

pub(crate) fn pending_transaction_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(PENDING_TRANSACTION_FILE))
}

fn catalog_write_lock_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join("profiles.write.lock"))
}

fn lock_catalog_write() -> Result<File, SwitcherError> {
    let path = catalog_write_lock_path()?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    file.try_lock().map_err(|_| {
        SwitcherError::Message(
            "另一项服务商资料操作正在保存，请等待完成后重新加载再试。".to_string(),
        )
    })?;
    Ok(file)
}

pub(crate) fn switch_preflight_path() -> Result<PathBuf, SwitcherError> {
    Ok(app_data_dir()?.join(SWITCH_PREFLIGHT_FILE))
}

pub(crate) fn write_codex_model_catalog(bytes: &[u8]) -> Result<PathBuf, SwitcherError> {
    let directory = app_data_dir()?.join("model-catalogs");
    fs::create_dir_all(&directory)?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    // Deterministic repair names keep preview and commit on the same candidate
    // path even when the canonical file is corrupt. Never overwrite old content.
    for attempt in 0..32 {
        let name = if attempt == 0 { format!("{}.json", &digest[..24]) } else { format!("{digest}-repair-{attempt}.json") };
        let path = directory.join(name);
        if path.exists() {
            if fs::read(&path).is_ok_and(|existing| existing == bytes) { return Ok(path); }
            continue;
        }
        write_bytes_atomically(&path, bytes)?;
        if fs::read(&path)? != bytes { return Err(SwitcherError::Message("模型目录写入回读不一致。".into())); }
        return Ok(path);
    }
    Err(SwitcherError::Message("模型目录存在多份不可用文件，无法安全生成；旧件未覆盖。".into()))
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
    begin_config_transaction_at(backup_id, reason, before_fingerprint, config_path()?, auth_path()?, None, None)
}

pub(crate) fn begin_config_transaction_at(
    backup_id: &str,
    reason: &str,
    before_fingerprint: &str,
    config: PathBuf,
    auth: PathBuf,
    previous_environment: Option<StoredConnectionEnvironment>,
    candidate_fingerprint: Option<String>,
) -> Result<(), SwitcherError> {
    let path = pending_transaction_path()?;
    if path.exists() {
        let existing: PendingConfigTransaction = serde_json::from_str(&fs::read_to_string(&path)?)
            .map_err(|_| {
                SwitcherError::Message("检测到损坏的配置事务回执；已拒绝继续写入。".to_string())
            })?;
        if transaction_writer_is_active(existing.writer_pid) {
            return Err(SwitcherError::Message(
                "另一项配置切换仍在进行，请完成或关闭它后再试。".to_string(),
            ));
        }
        recover_pending_config_transaction()?;
    }
    let transaction = PendingConfigTransaction {
        backup_id: backup_id.to_string(),
        reason: reason.to_string(),
        phase: default_transaction_phase(),
        before_fingerprint: before_fingerprint.to_string(),
        fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
        writer_pid: std::process::id(),
        config_path: Some(config),
        auth_path: Some(auth),
        previous_environment,
        candidate_fingerprint,
    };
    write_bytes_atomically(
        &path,
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
    owned_configuration_fingerprint(&fs::read_to_string(config_path()?)?, &read_auth()?)
}

pub(crate) fn current_state_is_safe_to_restore(
    manifest: &BackupManifest,
) -> Result<(), SwitcherError> {
    let config = fs::read_to_string(config_path()?)?;
    let auth = read_auth()?;
    if backup_snapshot_fingerprint_match(manifest, &config, &auth)?.is_some() {
        return Ok(());
    }
    let current = owned_configuration_fingerprint(&config, &auth)?;
    let receipts = load_operation_receipts()?;
    let latest = receipts.last().ok_or_else(|| {
        SwitcherError::Message(
            "当前服务商设置没有可验证的 Signalman 变更回执，已停止自动恢复。".to_string(),
        )
    })?;
    let current_matches_receipt = latest.after_fingerprint == current
        || (latest.fingerprint_version <= 2
            && latest.after_fingerprint == owned_configuration_fingerprint_v2(&config, &auth)?)
        || (latest.fingerprint_version < 2
            && latest.after_fingerprint == owned_configuration_fingerprint_v1(&config, &auth)?);
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

pub(crate) fn write_recovery_target(destination: &Path, bytes: &[u8]) -> Result<(), SwitcherError> {
    let metadata = match fs::metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return write_bytes_atomically(destination, bytes);
        }
        Err(error) => return Err(error.into()),
    };
    let mut permissions = metadata.permissions();
    let was_readonly = permissions.readonly();
    if was_readonly {
        permissions.set_readonly(false);
        fs::set_permissions(destination, permissions)?;
    }
    match write_bytes_atomically(destination, bytes) {
        Ok(()) => Ok(()),
        Err(error) => {
            if was_readonly {
                let mut original_permissions = fs::metadata(destination)?.permissions();
                original_permissions.set_readonly(true);
                fs::set_permissions(destination, original_permissions).map_err(
                    |restore_error| {
                        SwitcherError::Message(format!(
                            "恢复写入失败：{error}；同时无法还原原文件只读属性：{restore_error}"
                        ))
                    },
                )?;
            }
            Err(error)
        }
    }
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

pub(crate) fn rollback_config_transaction(config: &Path, original: &str) -> Result<(), SwitcherError> {
    let current = fs::read_to_string(config).map_err(|_| SwitcherError::Message("无法确认当前配置内容；事务已保留，请使用安全恢复。".into()))?;
    if !only_provider_owned_configuration_changed(original, &current)? {
        return Err(SwitcherError::Message("操作期间受保护配置被外部修改；事务已保留，不会自动覆盖，请使用安全恢复。".into()));
    }
    write_bytes_atomically(config, original.as_bytes()).map_err(|_| SwitcherError::Message("操作失败且原配置恢复未完成；事务已保留，请使用安全恢复。".into()))?;
    if fs::read_to_string(config)? != original {
        return Err(SwitcherError::Message("原配置恢复回读不一致；事务已保留，请使用安全恢复。".into()));
    }
    complete_config_transaction()
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
    let result = create_backup_at(&backup_root, label, reason, &config_path()?, &auth_path()?)?;
    let _ = prune_managed_backups(reason, label);
    Ok(result)
}

pub(crate) fn create_backup_at(
    backup_root: &Path,
    label: &str,
    reason: &str,
    config: &Path,
    auth: &Path,
) -> Result<PathBuf, SwitcherError> {
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
    let sources = [("config.toml", config), ("auth.json", auth)];
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
    let auth_text = if auth.is_file() { fs::read_to_string(auth)? } else { "{}".into() };
    let snapshot_fingerprint = if config.is_file() {
        Some(owned_configuration_fingerprint(
            &fs::read_to_string(config)?,
            &auth_text,
        )?)
    } else {
        None
    };
    let protected_fingerprint = if config.is_file() {
        Some(protected_configuration_fingerprint(
            &fs::read_to_string(config)?,
            &auth_text,
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
        protected_fingerprint,
        file_digests,
        retention_managed: true,
    };
    write_bytes_atomically(
        &staging.path.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?.as_bytes(),
    )?;
    write_bytes_atomically(
        &staging.path.join("backup-scope.json"),
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "scope": "codex-connection",
            "storage": "dedicated-recovery-directory",
            "included": ["config.toml", "auth.json"],
            "excluded": ["sessions", "sqlite", "projects", "mcp-runtime-data"],
            "secret_handling": "DPAPI protected files; manifest contains only digests and redacted scope"
        }))?.as_slice(),
    )?;
    backup_manifest_health(&staging.path, &manifest)?;
    fs::rename(&staging.path, &dir)?;
    staging.commit();
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
            let created = entry
                .metadata()
                .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()))
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            candidates.push((
                manifest.created_at,
                created,
                entry.file_name().to_string_lossy().to_string(),
                path,
            ));
        }
    }
    candidates.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.2.cmp(&left.2))
    });
    if let Some(index) = candidates
        .iter()
        .position(|(_, _, label, _)| label == protected_label)
    {
        let protected = candidates.remove(index);
        candidates.insert(0, protected);
    }
    let mut removed = 0;
    for (_, _, label, path) in candidates.into_iter().skip(limit) {
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
    if initial_backup_is_healthy() {
        return Ok(false);
    }
    if initial_dir.exists() {
        let mut record = load_connection_environment_record();
        if takeover_backup_is_healthy(&record) { return Ok(false); }
        // Retain the damaged first baseline and reuse the takeover replacement.
        let label = ensure_takeover_backup_at(&backups_dir()?, record.takeover_backup_label.as_deref(), &root_config_path()?, &auth_path()?)?;
        record.takeover_backup_label = Some(label);
        save_connection_environment_record(&record)?;
        return Ok(true);
    }
    create_backup_with_label(INITIAL_BACKUP_LABEL, "initial_install")?;
    Ok(true)
}

pub(crate) const SIGNALMAN_TAKEOVER_VERSION: u32 = 1;
pub(crate) const SIGNALMAN_TAKEOVER_BACKUP_LABEL: &str = "signalman-initial-takeover-v1";

/// Create the immutable pre-Signalman snapshot exactly once. Unlike the normal
/// rolling backups this label is never overwritten or pruned.
pub(crate) fn takeover_backup_is_healthy(record: &StoredConnectionEnvironment) -> bool {
    let Some(label) = record.takeover_backup_label.as_deref() else { return false };
    if validate_backup_id(label).is_err() { return false; }
    let Ok(root) = backups_dir() else { return false };
    let dir = root.join(label);
    fs::read_to_string(dir.join("manifest.json")).ok()
        .and_then(|text| serde_json::from_str::<BackupManifest>(&text).ok())
        .is_some_and(|manifest| backup_manifest_health(&dir, &manifest).is_ok())
}

pub(crate) fn ensure_takeover_backup_at(root: &Path, recorded: Option<&str>, config: &Path, auth: &Path) -> Result<String, SwitcherError> {
    let label = recorded.unwrap_or(SIGNALMAN_TAKEOVER_BACKUP_LABEL);
    validate_backup_id(label)?;
    let dir = root.join(label);
    if dir.exists() {
        let valid = fs::read_to_string(dir.join("manifest.json"))
            .ok().and_then(|text| serde_json::from_str::<BackupManifest>(&text).ok())
            .is_some_and(|manifest| backup_manifest_health(&dir, &manifest).is_ok());
        if valid { return Ok(label.to_string()); }
        // 留存无效原件，不伪造新摘要，也不覆盖首次状态。
        // An unwritable invalid directory must not prevent a new recovery point.
        // The replacement label and health checks remain the authoritative record.
        let _ = write_bytes_atomically(&dir.join("invalid-backup.json"), br#"{"status":"invalid","reason":"backup_health_failed","replacement_is_current_state":true}"#);
    }
    let replacement = if dir.exists() || recorded.is_some() { unique_backup_label("signalman-takeover-replacement") } else { label.to_string() };
    create_backup_at(root, &replacement, "signalman_initial_takeover", config, auth)?;
    Ok(replacement)
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
        catalog_revision: 0,
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
        save_catalog(&mut catalog)?;
        return Ok(catalog);
    }
    let text = fs::read_to_string(path)?;
    let mut catalog: StoredCatalog = parse_json_document(&text)?;
    normalize_catalog(&mut catalog);
    let migrated = hydrate_catalog_secrets(&mut catalog)?;
    migrate_legacy_backups()?;
    if migrated {
        save_catalog(&mut catalog)?;
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
        // Migrate both missing metadata and the old broad command contract.
        // `provider_command` is reserved for the exact ModelFlare adapter;
        // ordinary providers must use the standard auth.json Bearer path even
        // when an older profile persisted the command mode.
        if profile.auth_mode.trim().is_empty()
            || (preferred_mode == "provider_command" && profile.auth_mode == default_auth_mode())
            || (preferred_mode != "provider_command" && profile.auth_mode == "provider_command")
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

pub(crate) fn save_catalog(catalog: &mut StoredCatalog) -> Result<(), SwitcherError> {
    ensure_dirs()?;
    // The lock covers both revision comparison and replacement. Network work
    // happens before this function, so a slow provider never holds it.
    let _lock = lock_catalog_write()?;
    let path = profiles_path()?;
    let disk_revision = if path.exists() {
        let existing: StoredCatalog = parse_json_document(&fs::read_to_string(&path)?)?;
        existing.catalog_revision
    } else {
        0
    };
    if disk_revision != catalog.catalog_revision {
        return Err(SwitcherError::Message(
            "服务商资料已被另一项操作更新；本次没有覆盖，请重新加载后再试。".to_string(),
        ));
    }
    let mut persisted = catalog.clone();
    persisted.catalog_revision = disk_revision.checked_add(1).ok_or_else(|| {
        SwitcherError::Message("服务商资料修订号已到上限，无法安全保存。".to_string())
    })?;
    for value in persisted.profiles.values_mut() {
        let mut profile: StoredProfile = serde_json::from_value(value.clone())?;
        if !profile.api_key.trim().is_empty() {
            profile.api_key_protected = protect_secret(profile.api_key.as_bytes())?;
        }
        profile.api_key.clear();
        *value = serde_json::to_value(profile)?;
    }
    let text = serde_json::to_string_pretty(&persisted)?;
    write_bytes_atomically(&path, text.as_bytes())?;
    catalog.catalog_revision = persisted.catalog_revision;
    Ok(())
}

/// Build the auth document for a provider switch without performing I/O.
/// Keeping this JSON transformation beside the TOML preservation helpers makes
/// the write transaction in `lib.rs` an orchestration concern only.
pub(crate) fn build_next_auth(
    original: &str,
    _profile: &StoredProfile,
) -> Result<String, SwitcherError> {
    let auth = serde_json::from_str::<Value>(original)?;
    auth.as_object().ok_or_else(|| {
        SwitcherError::Message("auth.json 必须是 JSON 对象，无法安全写入。".to_string())
    })?;
    // Official ChatGPT OAuth belongs to Codex. Provider switches must preserve
    // this file byte-for-byte; third-party credentials are supplied by the
    // provider-scoped helper configured in config.toml instead.
    Ok(original.to_string())
}

pub(crate) fn replace_root_kv(line: &str, key: &str, value: &str) -> Option<String> {
    if line
        .trim_start()
        .strip_prefix(key)
        .is_some_and(|suffix| suffix.trim_start().starts_with('='))
    {
        Some(format!("{key} = {}", toml::Value::String(value.to_owned())))
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
    lines.insert(
        insert_at,
        format!("{key} = {}", toml::Value::String(value.to_owned())),
    );
}

pub(crate) fn upsert_root_bool(lines: &mut Vec<String>, key: &str, value: bool) {
    let root_end = root_section_end(lines);
    for line in lines.iter_mut().take(root_end) {
        if line
            .trim_start()
            .strip_prefix(key)
            .is_some_and(|suffix| suffix.trim_start().starts_with('='))
        {
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
    let mut index = 0usize;
    lines.retain(|line| {
        let retain = index >= root_end
            || !line
                .trim_start()
                .strip_prefix(key)
                .is_some_and(|suffix| suffix.trim_start().starts_with('='));
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

pub(crate) fn append_provider_command_auth(
    lines: &mut Vec<String>,
    end: &mut usize,
    profile_id: &str,
) -> Result<(), SwitcherError> {
    append_bound_provider_auth(lines, end, profile_id, &app_data_dir()?)
}

pub(crate) fn append_bound_provider_auth(
    lines: &mut Vec<String>,
    end: &mut usize,
    profile_id: &str,
    data_root: &Path,
) -> Result<(), SwitcherError> {
    // Codex launches the already-installed Signalman executable for one short
    // credential read. The helper exits immediately and never writes the key
    // into config.toml or Codex's OAuth-owned auth.json.
    let command = std::env::current_exe()
        .map_err(|error| SwitcherError::Message(format!("无法定位 Signalman 凭据助手：{error}")))?;
    #[cfg(not(test))]
    let command = if is_development_release_channel() {
        // A rebuild must not replace the helper referenced by a live copy.
        // Keep this development-only artifact immutable and content addressed.
        let bytes = fs::read(&command)?;
        let hash = bytes_digest(&bytes);
        let (project, _, _) = development_fixture_roots()?;
        let dir = project
            .join(".codex/runtime/credential-helpers")
            .join(&hash);
        fs::create_dir_all(&dir)?;
        let target = dir.join("SignalmanCredentialHelper.exe");
        if !target.exists() {
            write_bytes_atomically(&target, &bytes)?;
        }
        if bytes_digest(&fs::read(&target)?) != hash {
            return Err(SwitcherError::Message("凭据助手身份校验失败。".into()));
        }
        target
    } else {
        command
    };
    lines.insert(*end, "[model_providers.custom.auth]".to_string());
    *end += 1;
    lines.insert(
        *end,
        format!(
            "command = {}",
            toml::Value::String(command.display().to_string())
        ),
    );
    *end += 1;
    lines.insert(
        *end,
        format!(
            "args = [{}, {}, {}]",
            toml::Value::String("--print-provider-token".to_string()),
            toml::Value::String(profile_id.to_string()),
            toml::Value::String(data_root.canonicalize()?.display().to_string())
        ),
    );
    *end += 1;
    Ok(())
}

pub(crate) fn build_next_config(
    original: &str,
    profile_id: &str,
    profile: &StoredProfile,
) -> Result<String, SwitcherError> {
    let mut lines: Vec<String> = original.lines().map(ToString::to_string).collect();
    toml::from_str::<toml::Value>(original)?;
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
    let configured_base_url = if profile
        .capability_profile
        .as_ref()
        .is_some_and(|capability| crate::protocol_gateway::requires_gateway(&capability.protocol))
    {
        crate::protocol_gateway::local_base_url()
    } else {
        profile.base_url.clone()
    };
    upsert_section_string(
        &mut lines,
        start,
        &mut end,
        "base_url",
        &configured_base_url,
    );
    for key in ["api_key", "env_key", "experimental_bearer_token"] {
        remove_section_key(&mut lines, start, &mut end, key);
    }
    // Every third-party profile receives its own short-lived credential
    // command. This keeps official OAuth and provider billing independent.
    append_provider_command_auth(&mut lines, &mut end, profile_id)?;
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
    // Signalman owns one stable identity. Rewriting the selected provider is
    // what makes old OpenAI/OWL threads stop inheriting a stale route after
    // the first launch. Endpoint and credentials are deliberately left empty
    // until the user adds a provider through the normal workspace flow.
    upsert_root_string(&mut lines, "model_provider", "custom");
    remove_root_key(&mut lines, "openai_base_url");
    remove_root_key(&mut lines, "chatgpt_base_url");
    remove_root_key(&mut lines, "model_catalog_json");
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
        .unwrap();
    let mut end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with('['))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    upsert_section_string(&mut lines, start, &mut end, "name", "Signalman AI");
    upsert_section_string(&mut lines, start, &mut end, "wire_api", "responses");
    upsert_section_bool(&mut lines, start, &mut end, "requires_openai_auth", false);
    remove_section_key(&mut lines, start, &mut end, "base_url");
    remove_section_key(&mut lines, start, &mut end, "api_key");
    remove_section_key(&mut lines, start, &mut end, "env_key");
    remove_section_key(&mut lines, start, &mut end, "experimental_bearer_token");
    remove_section_key(&mut lines, start, &mut end, "requires_openai_auth");
    remove_section(&mut lines, "[model_providers.custom.auth]");
    let next = lines.join("\r\n");
    if !protected_sections_match(original, &next)? {
        return Err(SwitcherError::Message(
            "连接环境准备已阻止：检测到受保护设置会被改动。".to_string(),
        ));
    }
    Ok(next)
}
