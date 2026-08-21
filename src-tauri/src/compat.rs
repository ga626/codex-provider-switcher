//! Compatibility and migration helpers for legacy provider profiles.
//!
//! This module intentionally keeps the old import format and its backup path
//! separate from the current catalog implementation. The public core command
//! remains unchanged so existing desktop and development-board contracts keep
//! working while the migration path gets an explicit boundary.

use super::*;

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

pub(crate) fn unique_profile_id(catalog: &StoredCatalog, preferred: &str) -> String {
    let base = if preferred.trim().is_empty() {
        "legacy-provider".to_string()
    } else {
        provider_id_base(preferred)
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

pub(crate) fn profile_id_for_save(
    catalog: &StoredCatalog,
    requested_id: &str,
    name: &str,
) -> String {
    if requested_id.trim().is_empty() {
        unique_profile_id(catalog, name)
    } else {
        requested_id.trim().to_string()
    }
}

pub(crate) fn merge_legacy_profile_document(
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
            auth_mode: preferred_auth_mode(&legacy.name, &legacy.base_url),
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
        &format!(
            "已安全导入 {imported} 条本机凭据并使用 Windows 凭据保护保存；旧版文件未被修改。请重新运行可用性测试。"
        ),
        "success",
    )
}
