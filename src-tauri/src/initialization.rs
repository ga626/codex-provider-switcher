//! First-run orchestration using the existing backup and config transaction.
use super::*;

const TASKS: [(&str, &str); 9] = [
    ("paths", "定位配置与恢复目录"),
    ("recovery", "检查上次中断的操作"),
    ("config", "读取并检查旧配置"),
    ("auth", "检查认证文件"),
    ("profiles", "盘点可复用的服务商"),
    ("models", "准备模型目录与固定身份"),
    ("backup", "创建并验证恢复点"),
    ("write", "写入、回读并复核保护内容"),
    ("summary", "汇总初始化结果"),
];

struct Progress<'a> {
    steps: Vec<InitializationStep>,
    send: &'a mut dyn FnMut(InitializationStep),
}

impl Progress<'_> {
    fn start(&mut self, index: usize) {
        (self.send)(InitializationStep {
            index,
            id: TASKS[index].0.into(),
            label: TASKS[index].1.into(),
            status: "running".into(),
            detail: "正在执行实际任务。".into(),
            action: String::new(),
        });
    }
    fn end(&mut self, index: usize, status: &str, detail: &str, action: &str) {
        let step = InitializationStep {
            index,
            id: TASKS[index].0.into(),
            label: TASKS[index].1.into(),
            status: status.into(),
            detail: detail.into(),
            action: action.into(),
        };
        (self.send)(step.clone());
        self.steps.push(step);
    }
    fn check<T>(
        &mut self,
        index: usize,
        result: Result<T, SwitcherError>,
        success: &str,
    ) -> Option<T> {
        match result {
            Ok(value) => {
                self.end(index, "success", success, "");
                Some(value)
            }
            Err(error) => {
                self.end(index, "failure", &safe_error(&error), "请先关闭其他正在修改配置的工具，再点“重新检查”；如果仍提示文件损坏，请先让 Codex 恢复到可以正常打开和读取的状态。权限问题请确认当前账户能写入该目录。");
                None
            }
        }
    }
    fn blocked(&mut self, index: usize) {
        self.end(
            index,
            "blocked",
            "前置安全检查未通过，本项已检查依赖，未执行写入。",
            "先处理上面的红色问题，再重新检查。",
        )
    }
}

fn safe_error(error: &SwitcherError) -> String {
    match error {
        SwitcherError::Toml(_) => "配置不是有效 TOML；未覆盖原件。".into(),
        SwitcherError::Json(_) => "本机资料不是有效 JSON；未覆盖原件。".into(),
        SwitcherError::Io(error) => format!(
            "文件操作失败（{:?}）；请检查目录权限、文件占用和可用空间。",
            error.kind()
        ),
        _ => error.to_string(),
    }
}

pub fn initialize_with_progress(
    onboarding: bool,
    send: &mut dyn FnMut(InitializationStep),
) -> InitializationReport {
    initialize(onboarding, send, &mut |original, id, profile| {
        prepare_saved_profile_config(original, id, profile)
    })
}

fn initialize(
    onboarding: bool,
    send: &mut dyn FnMut(InitializationStep),
    prepare_catalog: &mut dyn FnMut(&str, &str, &StoredProfile) -> Result<String, SwitcherError>,
) -> InitializationReport {
    let mut progress = Progress {
        steps: Vec::new(),
        send,
    };
    progress.start(0);
    let paths = progress.check(
        0,
        (|| {
            configuration_layer_candidates()?;
            Ok((root_config_path()?, auth_path()?, backups_dir()?))
        })(),
        "已定位当前用户配置和 Signalman 专用恢复目录。",
    );
    progress.start(1);
    let recovered = progress
        .check(
            1,
            recover_pending_config_transaction(),
            "已核对上次事务，没有需要阻止的未完成写入。",
        )
        .is_some();
    progress.start(2);
    let config = if let Some((path, _, _)) = &paths {
        progress.check(
            2,
            (|| {
                let snapshot = capture_file(path)?;
                let text = String::from_utf8(snapshot.bytes.clone()).map_err(|_| {
                    SwitcherError::Message("配置不是 UTF-8 文本；未覆盖原件。".into())
                })?;
                toml::from_str::<toml::Value>(&text)?;
                Ok((snapshot, text))
            })(),
            "配置格式可安全处理；项目、MCP 和插件等设置会保留。",
        )
    } else {
        progress.blocked(2);
        None
    };
    progress.start(3);
    let auth = if let Some((_, path, _)) = &paths {
        progress.check(
            3,
            (|| {
                let snapshot = capture_file(path)?;
                let text = if snapshot.exists {
                    String::from_utf8(snapshot.bytes.clone()).map_err(|_| {
                        SwitcherError::Message("认证文件不是 UTF-8 文本；未覆盖原件。".into())
                    })?
                } else {
                    "{}".into()
                };
                if !serde_json::from_str::<Value>(&text)?.is_object() {
                    return Err(SwitcherError::Message(
                        "认证文件必须是 JSON 对象；未覆盖原件。".into(),
                    ));
                }
                Ok((snapshot, text))
            })(),
            "认证格式有效；已有官方登录资料保持原样，第三方连接不依赖它。",
        )
    } else {
        progress.blocked(3);
        None
    };
    progress.start(4);
    // Do not silently replace unreadable saved profiles with a blank setup.
    let catalog = progress.check(
        4,
        load_catalog(),
        "已盘点本机已保存连接；没有删除服务商资料。",
    );
    let saved = config
        .as_ref()
        .zip(catalog.as_ref())
        .and_then(|((_, original), catalog)| {
            let value = toml::from_str::<toml::Value>(original).ok()?;
            if value.get("model_provider").and_then(toml::Value::as_str) != Some("custom") {
                return None;
            }
            let id = current_profile_id(catalog, original);
            let profile: StoredProfile =
                serde_json::from_value(catalog.profiles.get(&id)?.clone()).ok()?;
            (!profile.api_key.is_empty() || !profile.api_key_protected.is_empty())
                .then_some((id, profile))
        });
    progress.start(5);
    let next = if let Some((_, original)) = &config {
        if let Some((id, profile)) = &saved {
            match prepare_catalog(original, id, profile) {
                Ok(next) => {
                    progress.end(
                        5,
                        "success",
                        "模型目录已核验或重新生成；已有连接继续保留。",
                        "",
                    );
                    Some(next)
                }
                Err(_) => {
                    // The model picker is optional; never fabricate an upstream
                    // model schema or keep an unknown/broken old file pointer.
                    match build_next_config(original, id, profile).map(|next| {
                        let mut lines = next.lines().map(str::to_string).collect::<Vec<_>>();
                        remove_root_key(&mut lines, "model_catalog_json");
                        lines.join("\r\n")
                    }) {
                        Ok(next) => {
                            progress.end(5, "warning", "模型目录暂时无法生成；已移除旧目录指针，保留服务商地址、默认模型和认证方式。", "模型选择器暂时不可用，进入工作台后可稍后重新检查；配置本身已安全保留。");
                            Some(next)
                        }
                        Err(error) => {
                            progress.check::<()>(5, Err(error), "");
                            None
                        }
                    }
                }
            }
        } else {
            progress.check(
                5,
                build_connection_environment_config(original),
                "已清理未知旧模型指针，准备固定 custom 身份；添加服务商后生成模型目录。",
            )
        }
    } else {
        progress.blocked(5);
        None
    };
    progress.start(6);
    let previous = load_connection_environment_record();
    let backup = if recovered && config.is_some() && auth.is_some() && paths.is_some() {
        let (config_path, auth_path, root) = paths.as_ref().unwrap();
        let result = (|| {
            let label = ensure_takeover_backup_at(
                root,
                previous.takeover_backup_label.as_deref(),
                config_path,
                auth_path,
            )?;
            ensure_initial_backup()?;
            let backup = create_backup_at(
                root,
                &unique_backup_label("before-initialization"),
                "before_switch",
                config_path,
                auth_path,
            )?;
            Ok((label, backup))
        })();
        let replaced = !initial_backup_is_healthy()
            || (previous.takeover_backup_label.is_some() && !takeover_backup_is_healthy(&previous));
        match result {
            Ok(value) if replaced => {
                progress.end(6, "warning", "旧恢复点不可用，已保留旧件并验证新的当前状态恢复点；新的恢复点不能还原丢失的安装前原件。", "请确认磁盘可用后点“重新检查”。在恢复点确认健康前不能进入软件，也不会从首次启动结果页绕过检查。");
                Some(value)
            }
            other => progress.check(6, other, "加密备份和内容摘要已通过健康校验。"),
        }
    } else {
        progress.blocked(6);
        None
    };
    progress.start(7);
    let committed = if recovered && catalog.is_some() && next.is_some() && backup.is_some() {
        let (config_path, auth_path, _) = paths.as_ref().unwrap();
        let (original_config, original) = config.as_ref().unwrap();
        let (original_auth, auth_text) = auth.as_ref().unwrap();
        let (label, backup) = backup.as_ref().unwrap();
        progress
            .check(
                7,
                commit(
                    config_path,
                    auth_path,
                    original_config,
                    original_auth,
                    original,
                    auth_text,
                    next.as_ref().unwrap(),
                    &previous,
                    label,
                    backup,
                    onboarding,
                ),
                "固定身份写入和回读已完成；认证原件、项目、MCP 和插件设置通过保护校验。",
            )
            .is_some()
    } else {
        progress.blocked(7);
        false
    };
    progress.start(8);
    let state_result = if committed {
        app_state_with_activity(
            "连接环境已准备",
            "旧连接已备份，固定 custom 身份通过写入回读。切换后请由用户重启 Codex。",
            "success",
        )
    } else {
        app_state()
    };
    let mut state = match state_result {
        Ok(state) => {
            progress.end(8, "success", "所有可安全执行的任务已结束；结果已汇总。", "");
            Some(state)
        }
        Err(_) => {
            progress.end(8, "warning", if committed { "连接配置已成功提交，但活动记录或完整状态暂时无法读取，初始化结果还不能确认完整。" } else { "完整状态暂时无法读取，初始化结果还不能确认。" }, "请点“重新检查”；如果连续失败，请关闭并重新打开 Signalman 后再试。确认全部检查为绿色之前不能进入软件。");
            startup_safe_state(StartupNotice {
                code: "initialization-state-unavailable".into(),
                detail: "完整状态暂时不可用，配置写入结果以初始化回执为准。".into(),
            })
            .ok()
        }
    };
    if state.is_none() {
        // A missing recovery view is a blocking application problem, not a success.
        let last = progress.steps.last_mut().unwrap();
        last.status = "failure".into();
        last.detail = "无法加载安全恢复界面；请关闭其他配置工具后重试，仍失败请联系支持并提供错误码 initialization-state-unavailable。".into();
        (progress.send)(last.clone());
    }
    let only_degraded_catalog = progress
        .steps
        .iter()
        .all(|step| step.status == "success" || (step.index == 5 && step.status == "warning"));
    let can_continue = committed && state.is_some() && only_degraded_catalog;
    let warnings = progress
        .steps
        .iter()
        .filter(|step| step.status == "warning")
        .map(|step| format!("{}：{} {}", step.label, step.detail, step.action))
        .collect::<Vec<_>>();
    if !warnings.is_empty() {
        if let Some(state) = state.as_mut() {
            state.startup_notice = Some(StartupNotice {
                code: "initialization-degraded".into(),
                detail: warnings.join(" "),
            });
        }
    }
    InitializationReport {
        steps: progress.steps,
        state,
        can_continue,
    }
}

#[allow(clippy::too_many_arguments)]
fn commit(
    config: &Path,
    auth: &Path,
    original_config: &FileSnapshot,
    original_auth: &FileSnapshot,
    original: &str,
    auth_text: &str,
    next: &str,
    previous: &StoredConnectionEnvironment,
    takeover_label: &str,
    backup: &Path,
    onboarding: bool,
) -> Result<(), SwitcherError> {
    let backup_id = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SwitcherError::Message("恢复点标识无效。".into()))?;
    let before = owned_configuration_fingerprint(original, auth_text)?;
    let candidate = owned_configuration_fingerprint(next, auth_text)?;
    // Compare before beginning the transaction. No rollback should overwrite
    // an external edit made between reading and backing up the files.
    if capture_file(config)?.bytes != original_config.bytes
        || capture_file(auth)?.bytes != original_auth.bytes
    {
        return Err(SwitcherError::Message(
            "初始化前配置或认证已变化；未覆盖外部修改，请重新检查。".into(),
        ));
    }
    begin_config_transaction_at(
        backup_id,
        "initialization",
        &before,
        config.to_path_buf(),
        auth.to_path_buf(),
        Some(previous.clone()),
        Some(candidate),
    )?;
    let result = (|| {
        save_connection_environment_record(&StoredConnectionEnvironment {
            setup_completed: false,
            ..previous.clone()
        })?;
        write_bytes_atomically(config, next.as_bytes())?;
        update_config_transaction_phase("config_replaced")?;
        if !original_auth.exists {
            write_bytes_atomically(auth, b"{}")?;
        }
        let written = fs::read_to_string(config)?;
        let written_auth = fs::read(auth)?;
        if written != next
            || !protected_sections_match(original, &written)?
            || (original_auth.exists && written_auth != original_auth.bytes)
            || (!original_auth.exists && written_auth != b"{}")
        {
            return Err(SwitcherError::Message(
                "回读或保护校验未通过；初始化未完成。".into(),
            ));
        }
        save_connection_environment_record(&StoredConnectionEnvironment {
            selected_layer_id: Some("user-config".into()),
            setup_completed: true,
            onboarding_completed: !onboarding
                && (previous.onboarding_completed || previous.setup_completed),
            takeover_version: SIGNALMAN_TAKEOVER_VERSION,
            takeover_backup_label: Some(takeover_label.into()),
        })?;
        let after = owned_configuration_fingerprint(&written, auth_text)?;
        record_backup_post_change(backup, &after)?;
        record_operation_receipt(ConfigOperationReceipt {
            id: unique_backup_label("initialization-receipt"),
            backup_id: backup_id.into(),
            kind: "initialization".into(),
            created_at: now_label(),
            fingerprint_version: CURRENT_BACKUP_FINGERPRINT_VERSION,
            before_fingerprint: before,
            after_fingerprint: after,
        })?;
        update_config_transaction_phase("verified")
    })();
    if let Err(error) = result {
        // Retain the journal whenever rollback cannot be confirmed.
        let current = fs::read_to_string(config).map_err(|_| {
            SwitcherError::Message(
                "初始化失败且无法确认当前配置；事务已保留，请使用安全恢复。".into(),
            )
        })?;
        if !initialization_owned_change_only(original, &current)? {
            return Err(SwitcherError::Message(
                "初始化期间受保护配置被外部修改；事务已保留，不会自动覆盖，请使用安全恢复。".into(),
            ));
        }
        restore_file_snapshot(config, original_config).map_err(|_| {
            SwitcherError::Message(
                "初始化失败且原配置恢复未完成；事务已保留，请使用安全恢复。".into(),
            )
        })?;
        if !original_auth.exists && fs::read(auth).is_ok_and(|bytes| bytes == b"{}") {
            restore_file_snapshot(auth, original_auth)?;
        }
        if capture_file(config)?.bytes != original_config.bytes {
            return Err(SwitcherError::Message(
                "原配置恢复回读不一致；事务已保留，请使用安全恢复。".into(),
            ));
        }
        save_connection_environment_record(previous)?;
        complete_config_transaction()?;
        return Err(error);
    }
    // A verified journal is safe to finalize on the next start if cleanup fails.
    let _ = complete_config_transaction();
    Ok(())
}

#[cfg(test)]
pub(crate) fn fault_matrix() {
    let config = root_config_path().unwrap();
    let auth = auth_path().unwrap();
    // Both malformed inputs are reported, every task gets a result, and there
    // is no unsafe write even though later independent checks still run.
    fs::write(&config, "invalid = [\n").unwrap();
    fs::write(&auth, "[]").unwrap();
    let mut events = Vec::new();
    let report = initialize_with_progress(true, &mut |step| events.push(step));
    assert_eq!(report.steps.len(), TASKS.len());
    assert!(!report.can_continue);
    assert_eq!(report.steps[2].status, "failure");
    assert_eq!(report.steps[3].status, "failure");
    assert_eq!(report.steps[7].status, "blocked");
    assert!(events.iter().any(|step| step.index == 8));
    assert_eq!(fs::read_to_string(&config).unwrap(), "invalid = [\n");
    assert_eq!(fs::read_to_string(&auth).unwrap(), "[]");

    // Preserve a saved provider and OAuth, but remove the unusable picker path.
    let oauth = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-only"}}"#;
    fs::write(&auth, oauth).unwrap();
    fs::write(&config, "").unwrap();
    let profile: StoredProfile = serde_json::from_value(json!({"name":"Relay","base_url":"https://fixture.invalid/v1","model":"fixture-model","api_key":"fixture-key"})).unwrap();
    let mut catalog = load_catalog().unwrap();
    catalog
        .profiles
        .insert("relay".into(), serde_json::to_value(&profile).unwrap());
    save_catalog(&mut catalog).unwrap();
    let original =
        build_next_config("[mcp_servers.keep]\ncommand='keep'\n", "relay", &profile).unwrap();
    let original = format!("model_catalog_json='C:/fixture/missing.json'\n{original}");
    fs::write(&config, &original).unwrap();
    let report = initialize(true, &mut |_| {}, &mut |_, _, _| {
        Err(SwitcherError::Message("目录读取失败".into()))
    });
    assert!(report.can_continue, "{:?}", report.steps);
    assert_eq!(report.steps[5].status, "warning");
    assert_eq!(
        report
            .state
            .as_ref()
            .unwrap()
            .startup_notice
            .as_ref()
            .unwrap()
            .code,
        "initialization-degraded"
    );
    let written = fs::read_to_string(&config).unwrap();
    let value: toml::Value = toml::from_str(&written).unwrap();
    assert!(value.get("model_catalog_json").is_none());
    assert_eq!(value["model"].as_str(), Some("fixture-model"));
    assert_eq!(
        value["model_providers"]["custom"]["base_url"].as_str(),
        Some("https://fixture.invalid/v1")
    );
    assert_eq!(fs::read_to_string(&auth).unwrap(), oauth);
    assert!(protected_sections_match(&original, &written).unwrap());

    // A bad original baseline is still a blocking safety warning even though
    // the model catalogue itself is recoverable.
    let baseline = backups_dir()
        .unwrap()
        .join(INITIAL_BACKUP_LABEL)
        .join("manifest.json");
    fs::write(&baseline, "{").unwrap();
    assert!(!initial_backup_is_healthy());
    assert!(healthy_baseline_backup().is_ok());
    let report = initialize(true, &mut |_| {}, &mut |_, _, _| {
        Err(SwitcherError::Message("目录读取失败".into()))
    });
    assert!(!report.can_continue);
    assert_eq!(report.steps[6].status, "warning");
    assert_eq!(fs::read_to_string(&baseline).unwrap(), "{");

    // Rechecking can rebuild the owned path instead of reusing an old pointer.
    let directory = write_codex_model_catalog(br#"{"models":[{"slug":"fixture-model"}]}"#).unwrap();
    let expected = fs::read(&directory).unwrap();
    fs::write(&directory, "corrupt").unwrap();
    let repaired = write_codex_model_catalog(&expected).unwrap();
    assert_ne!(repaired, directory);
    assert_eq!(write_codex_model_catalog(&expected).unwrap(), repaired);
    assert_eq!(fs::read_to_string(&directory).unwrap(), "corrupt");
    let directory = repaired;
    let report = initialize(true, &mut |_| {}, &mut |original, id, profile| {
        let mut lines = build_next_config(original, id, profile)?
            .lines()
            .map(str::to_string)
            .collect();
        upsert_root_string(
            &mut lines,
            "model_catalog_json",
            &directory.display().to_string(),
        );
        Ok(lines.join("\r\n"))
    });
    assert!(!report.can_continue, "{:?}", report.steps);
    assert_eq!(report.steps[6].status, "warning");
    assert_eq!(report.steps[5].status, "success");
    let committed = fs::read_to_string(&config).unwrap();
    assert_eq!(
        toml::from_str::<toml::Value>(&committed).unwrap()["model_catalog_json"].as_str(),
        Some(directory.display().to_string().as_str())
    );
    // Changing the identity must invalidate stale ready metadata; legitimate
    // official mode remains supported by the product.
    fs::write(
        &config,
        committed.replace("model_provider = \"custom\"", "model_provider = \"owl\""),
    )
    .unwrap();
    assert_eq!(connection_environment_state().status, "needs_setup");
    fs::write(&config, &committed).unwrap();

    // A verified journal only needs cleanup; it must not roll back success.
    let backup = create_backup_with_label("verified-original", "before_switch").unwrap();
    let before = owned_configuration_fingerprint(&committed, oauth).unwrap();
    begin_config_transaction(
        backup.file_name().unwrap().to_str().unwrap(),
        "model_catalog",
        &before,
    )
    .unwrap();
    let changed = committed.replace("fixture-model", "fixture-new-model");
    fs::write(&config, &changed).unwrap();
    update_config_transaction_phase("verified").unwrap();
    let path = pending_transaction_path().unwrap();
    let mut journal: PendingConfigTransaction =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    journal.writer_pid = 0;
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    recover_pending_config_transaction().unwrap();
    assert!(!path.exists());
    assert_eq!(fs::read_to_string(&config).unwrap(), changed);
    assert_eq!(fs::read_to_string(&auth).unwrap(), oauth);
    // An error rollback must not overwrite a concurrent protected edit.
    begin_config_transaction("verified-original", "model_catalog", &before).unwrap();
    let concurrent = format!("{changed}\n[plugins.external]\nenabled=true\n");
    fs::write(&config, &concurrent).unwrap();
    assert!(rollback_config_transaction(&config, &changed).is_err());
    assert_eq!(fs::read_to_string(&config).unwrap(), concurrent);
    assert!(pending_transaction_path().unwrap().exists());
    fs::write(&config, &changed).unwrap();
    complete_config_transaction().unwrap();
    // A broken activity store after commit is unresolved during first run and
    // therefore blocks entry until the state can be confirmed.
    let activity = activity_path().unwrap();
    fs::remove_file(&activity).unwrap();
    fs::create_dir(&activity).unwrap();
    let report = initialize(true, &mut |_| {}, &mut |original, id, profile| {
        build_next_config(original, id, profile)
    });
    assert!(!report.can_continue);
    assert_eq!(report.steps[8].status, "warning");
    assert!(report.state.is_some());
    assert!(load_connection_environment_record().setup_completed);
    assert!(complete_onboarding_core().is_ok());
}
