//! 开发控制台的隔离资料与运行身份；不复用真实安装目录。
use super::*;
use std::fs::File;
use std::sync::Mutex;

static LOGIN: Mutex<Option<std::process::Child>> = Mutex::new(None);
static LIVE_LEASE: Mutex<Option<File>> = Mutex::new(None);
static TARGET: Mutex<Option<(std::process::Child, File, TargetLifetime)>> = Mutex::new(None);
static SESSION: Mutex<Session> = Mutex::new(Session {
    copy: None,
    operations: 0,
    transitioning: false,
    leases: None,
});

struct Session {
    copy: Option<PathBuf>,
    operations: usize,
    transitioning: bool,
    leases: Option<(File, File)>,
}
impl Session {
    fn begin_transition(&mut self) -> Result<(), SwitcherError> {
        if self.operations != 0 || self.transitioning {
            return Err(error("仍有操作进行中，请完成后再切换模式。"));
        }
        self.transitioning = true;
        Ok(())
    }
}
pub(crate) struct OperationScope(bool);
impl Drop for OperationScope {
    fn drop(&mut self) {
        if self.0 {
            if let Ok(mut session) = SESSION.lock() {
                session.operations -= 1;
            }
        }
    }
}
pub(crate) fn operation_scope() -> Result<OperationScope, SwitcherError> {
    if !is_development_release_channel() {
        return Ok(OperationScope(false));
    }
    let mut session = SESSION.lock().map_err(|_| error("QA 会话状态异常。"))?;
    if session.transitioning {
        return Err(error("正在切换 QA 资料，请稍后重试。"));
    }
    session.operations += 1;
    Ok(OperationScope(true))
}
pub(crate) struct Transition;
impl Transition {
    pub(crate) fn begin() -> Result<Self, SwitcherError> {
        SESSION
            .lock()
            .map_err(|_| error("QA 会话状态异常。"))?
            .begin_transition()?;
        Ok(Self)
    }
}
impl Drop for Transition {
    fn drop(&mut self) {
        if let Ok(mut session) = SESSION.lock() {
            session.transitioning = false;
        }
    }
}
pub(crate) fn runtime_override() -> Result<Option<(PathBuf, PathBuf)>, SwitcherError> {
    if !is_development_release_channel() {
        return Ok(None);
    }
    Ok(SESSION
        .lock()
        .map_err(|_| error("QA 会话状态异常。"))?
        .copy
        .as_ref()
        .map(|copy| (copy.join("app-data"), copy.join("codex-home"))))
}

// Windows closes this job even when the QA process crashes, terminating its
// isolated CLI and descendants instead of leaving a writable orphan behind.
struct TargetLifetime {
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}
impl TargetLifetime {
    fn bind(child: &std::process::Child) -> Result<Self, SwitcherError> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::*;
            unsafe {
                let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if raw.is_null() {
                    return Err(std::io::Error::last_os_error().into());
                }
                let job = OwnedHandle::from_raw_handle(raw);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                Ok(Self { _job: job })
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }
}

pub(crate) fn emergency_restore() -> Result<(), SwitcherError> {
    validate_live()?;
    let root = root()?;
    let _action = lock(&root, "action.lock")?;
    let _live = lock(&root, "live.lock")?;
    let _target = lock(&root, "target.lock")?;
    restore_latest_backup_core("恢复".into())?;
    Ok(())
}

pub(crate) fn open_codex_target(executable: &Path, home: &Path) -> Result<(), SwitcherError> {
    let root = root()?;
    let mut target = TARGET.lock().map_err(|_| error("测试目标状态异常。"))?;
    if let Some((child, _, _)) = target.as_mut() {
        if child.try_wait()?.is_none() {
            return Err(error("隔离 Codex 已打开，请先在该窗口完成操作。"));
        }
        *target = None;
    }
    let lease = lock(&root, "target.lock")?;
    let mut command = std::process::Command::new(executable);
    command
        .current_dir(home)
        .env(OFFICIAL_CODEX_HOME_ENV, home)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .args(["-c", "cli_auth_credentials_store=\"file\""]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000010);
    }
    let mut child = command.spawn()?;
    let lifetime = match TargetLifetime::bind(&child) {
        Ok(lifetime) => lifetime,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };
    *target = Some((child, lease, lifetime));
    Ok(())
}

fn error(message: &str) -> SwitcherError {
    SwitcherError::Message(message.into())
}
pub(crate) fn live_requested() -> bool {
    is_development_release_channel()
        && (env::var("CODEX_PROVIDER_SWITCHER_QA_LIVE_VALIDATION").as_deref() == Ok("1")
            || SESSION.lock().map(|s| s.copy.is_some()).unwrap_or(true))
}
pub(crate) fn guard_network(url: &str) -> Result<(), SwitcherError> {
    if !is_development_release_channel() {
        return Ok(());
    }
    if live_requested() {
        validate_live()?;
        return Ok(());
    }
    let url = reqwest::Url::parse(url).map_err(|_| error("接口地址无效。"))?;
    if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        return Ok(());
    }
    Err(error(
        "普通 QA 样本不会向外部服务商发请求。请在真实验证副本中主动验证。",
    ))
}
pub(crate) fn validate_tree(root: &Path, path: &Path) -> Result<(), SwitcherError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !path.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err(error("资料目录包含外部链接，已停止清理。"));
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            validate_tree(root, &entry?.path())?;
        }
    }
    Ok(())
}
fn safe_id(id: &str) -> Result<&str, SwitcherError> {
    if id.is_empty()
        || id.len() > 160
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(error("验证资料编号无效，已停止。"));
    }
    Ok(id)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn child_path(root: &Path, relative: &str) -> Result<PathBuf, SwitcherError> {
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        if let std::path::Component::Normal(part) = part {
            path.push(part);
        } else {
            return Err(error("验证路径不是受控子目录。"));
        }
        if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(error("验证目录含链接，已拒绝操作。"));
        }
        if path.exists() && !path.canonicalize()?.starts_with(root.canonicalize()?) {
            return Err(error("验证目录指向隔离范围之外。"));
        }
    }
    Ok(path)
}
fn root() -> Result<PathBuf, SwitcherError> {
    let (project, _, _) = development_fixture_roots()?;
    let runtime = project.join(".codex/runtime").canonicalize()?;
    #[cfg(test)]
    if let Some(path) = env::var_os("SIGNALMAN_QA_TEST_ROOT") {
        let path = PathBuf::from(path).canonicalize()?;
        if !path.starts_with(&runtime) || path == runtime {
            return Err(error("测试目录越界。"));
        }
        return Ok(path);
    }
    let root = child_path(&runtime, "live-validation-v2")?;
    fs::create_dir_all(&root)?;
    Ok(root)
}
fn lock(root: &Path, name: &str) -> Result<File, SwitcherError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(child_path(root, name)?)?;
    file.try_lock()
        .map_err(|_| error("验证窗口或另一项操作仍在使用资料。请先关闭验证窗口，再重试。"))?;
    Ok(file)
}
fn controller(root: &Path) -> Result<(File, File), SwitcherError> {
    if live_requested() {
        return Err(error("当前正在使用真实副本。请先返回模拟检查再管理资料。"));
    }
    let action = lock(root, "action.lock")?;
    let _target = lock(root, "target.lock")?;
    let lease = lock(root, "live.lock")?;
    Ok((action, lease))
}

#[derive(Serialize, Deserialize)]
struct Entry {
    name: String,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    schema: String,
    id: String,
    files: Vec<Entry>,
    missing: Vec<String>,
}
fn valid_name(name: &str) -> bool {
    matches!(
        name,
        "config.toml" | "auth.json" | PROFILES_FILE | ACTIVITY_FILE | "connection-environment.json"
    )
}
fn validate_bytes(name: &str, bytes: &[u8]) -> Result<(), SwitcherError> {
    if name == "config.toml" {
        let text = std::str::from_utf8(bytes).map_err(|_| error("配置不是有效 UTF-8。"))?;
        text.parse::<toml::Table>()
            .map_err(|_| error("配置不是有效 TOML，未替换旧副本。"))?;
    } else {
        serde_json::from_slice::<Value>(bytes)
            .map_err(|_| error("验证资料不是有效 JSON，未替换旧副本。"))?;
    }
    Ok(())
}
fn snapshot(root: &Path) -> Result<(Manifest, Vec<(String, Vec<u8>)>), SwitcherError> {
    let id = fs::read_to_string(root.join("latest-snapshot.txt"))?;
    let folder = child_path(root, &format!("snapshots/{}", safe_id(id.trim())?))?;
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(child_path(&folder, "manifest.json")?)?)?;
    if manifest.schema != "qa-snapshot/v2" || manifest.id != id.trim() || manifest.files.is_empty()
    {
        return Err(error("快照说明不完整，请重新备份。"));
    }
    let mut seen = BTreeSet::new();
    let mut files = Vec::new();
    for entry in &manifest.files {
        if !valid_name(&entry.name) || !seen.insert(&entry.name) {
            return Err(error("快照包含未知或重复文件。"));
        }
        let bytes = unprotect_secret(&fs::read_to_string(child_path(
            &folder,
            &format!("{}.dpapi", entry.name),
        )?)?)?;
        if digest(&bytes) != entry.sha256 {
            return Err(error("快照校验不一致，已拒绝导入。"));
        }
        validate_bytes(&entry.name, &bytes)?;
        files.push((entry.name.clone(), bytes));
    }
    Ok((manifest, files))
}
fn active(root: &Path) -> Result<PathBuf, SwitcherError> {
    let id = fs::read_to_string(root.join("active.txt"))?;
    let folder = child_path(root, &format!("copies/{}", safe_id(id.trim())?))?;
    let marker: Value = serde_json::from_slice(&fs::read(child_path(&folder, "ready.json")?)?)?;
    if marker["id"] != id.trim() {
        return Err(error("副本身份不一致。"));
    }
    for relative in ["app-data", "codex-home"] {
        if !child_path(&folder, relative)?.is_dir() {
            return Err(error("副本目录缺失，请重新导入。"));
        }
    }
    // 副本允许合法编辑，不与初始内容 hash 强行相等；但必需文件必须可读。
    let files = marker["files"]
        .as_array()
        .ok_or_else(|| error("副本文件清单缺失。"))?;
    if files.is_empty()
        || !files
            .iter()
            .any(|name| name.as_str() == Some("config.toml"))
    {
        return Err(error("副本必需文件清单不完整。"));
    }
    for entry in files {
        let name = entry.as_str().ok_or_else(|| error("副本文件清单无效。"))?;
        if !valid_name(name) {
            return Err(error("副本清单无效。"));
        }
        let relative = format!(
            "{}/{}",
            if matches!(name, "config.toml" | "auth.json") {
                "codex-home"
            } else {
                "app-data"
            },
            name
        );
        validate_bytes(name, &fs::read(child_path(&folder, &relative)?)?)?;
    }
    Ok(folder)
}
pub(crate) fn validate_live() -> Result<PathBuf, SwitcherError> {
    if !live_requested() {
        return Err(error("此操作需要明确打开真实验证副本。"));
    }
    let root = root()?;
    let copy = active(&root)?;
    let (_, app, codex) = development_fixture_roots()?;
    if app != copy.join("app-data").canonicalize()?
        || codex != copy.join("codex-home").canonicalize()?
    {
        return Err(error("运行目录与验证副本不一致，已停止。"));
    }
    Ok(codex)
}
pub(crate) fn initialize_live() -> Result<(), SwitcherError> {
    if live_requested() {
        validate_live()?;
        let root = root()?;
        *LIVE_LEASE.lock().map_err(|_| error("验证窗口锁异常。"))? =
            Some(lock(&root, "live.lock")?);
        write_bytes_atomically(
            &root.join("window-ready.txt"),
            std::process::id().to_string().as_bytes(),
        )?;
    }
    Ok(())
}
pub(crate) fn status() -> Result<QaLiveValidationStatus, SwitcherError> {
    let root = root()?;
    let snap = snapshot(&root);
    let copy = active(&root);
    let live = live_requested();
    let in_use = live || lock(&root, "live.lock").is_err();
    Ok(QaLiveValidationStatus {
        snapshot_id: snap.as_ref().ok().map(|(m, _)| m.id.clone()),
        snapshot_ready: snap.is_ok(),
        import_ready: copy.is_ok(),
        mode: if live { "live-copy" } else { "fixture" }.into(),
        in_use,
        included_files: snap
            .as_ref()
            .map(|(m, _)| m.files.iter().map(|f| f.name.clone()).collect())
            .unwrap_or_default(),
        missing_files: snap
            .as_ref()
            .map(|(m, _)| m.missing.clone())
            .unwrap_or_default(),
        detail: if live {
            "真实资料副本：登录与请求可能真实执行；不会回写原件。"
        } else if in_use {
            "另一验证会话正在使用副本；退出后才能继续。"
        } else if copy.is_ok() {
            "副本已校验，可在当前界面继续真实验证。"
        } else if snap.is_ok() {
            "加密快照已校验；尚无有效验证副本。"
        } else {
            "尚无有效快照。点击备份后才读取本机资料；旧版快照需重新创建。"
        }
        .into(),
    })
}
pub(crate) fn create_snapshot() -> Result<QaLiveValidationStatus, SwitcherError> {
    let root = root()?;
    {
        let _guard = controller(&root)?;
        let user = env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .ok_or_else(|| error("无法定位本机用户。"))?;
        let codex = env::var_os(OFFICIAL_CODEX_HOME_ENV)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or(user.join(".codex"));
        let app = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| error("无法定位产品资料。"))?
            .join(APP_DIR_NAME);
        create_snapshot_at(&root, &codex, &app)?;
    }
    status()
}
fn create_snapshot_at(root: &Path, codex: &Path, app: &Path) -> Result<(), SwitcherError> {
    let id = unique_backup_label("qa-snapshot");
    safe_id(&id)?;
    let folder = child_path(root, &format!("snapshots/{id}"))?;
    fs::create_dir_all(&folder)?;
    let mut manifest = Manifest {
        schema: "qa-snapshot/v2".into(),
        id: id.clone(),
        files: Vec::new(),
        missing: Vec::new(),
    };
    let environment_path = app.join("connection-environment.json");
    let environment: Value = if environment_path.is_file() {
        serde_json::from_slice(&fs::read(&environment_path)?)?
    } else {
        json!({})
    };
    let selected_profile = environment["selected_layer_id"]
        .as_str()
        .and_then(|id| id.strip_prefix("profile:"));
    for (dir, name) in [
        (codex, "config.toml"),
        (codex, "auth.json"),
        (app, PROFILES_FILE),
        (app, ACTIVITY_FILE),
        (app, "connection-environment.json"),
    ] {
        let source = if name == "config.toml" {
            if let Some(file) = selected_profile {
                if file.contains(['/', '\\']) || !file.ends_with(".config.toml") {
                    return Err(error("选中的配置层无效，未复制。"));
                }
                let path = codex.join(file);
                if !path.is_file() {
                    return Err(error("选中的配置层已不存在，未用其他配置冒充。"));
                }
                path
            } else {
                dir.join(name)
            }
        } else {
            dir.join(name)
        };
        if source.is_file() {
            let bytes = fs::read(source)?;
            validate_bytes(name, &bytes)?;
            fs::write(
                folder.join(format!("{name}.dpapi")),
                protect_secret(&bytes)?,
            )?;
            manifest.files.push(Entry {
                name: name.into(),
                sha256: digest(&bytes),
            });
        } else {
            manifest.missing.push(name.into());
        }
    }
    if manifest.files.is_empty() {
        return Err(error("没有找到可复制的资料。"));
    }
    write_bytes_atomically(
        &folder.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    write_bytes_atomically(&root.join("latest-snapshot.txt"), id.as_bytes())?;
    snapshot(root)?;
    Ok(())
}
pub(crate) fn import_snapshot() -> Result<QaLiveValidationStatus, SwitcherError> {
    let root = root()?;
    {
        let _guard = controller(&root)?;
        import_at(&root)?;
    }
    status()
}
fn import_at(root: &Path) -> Result<(), SwitcherError> {
    let (manifest, files) = snapshot(root)?;
    let id = unique_backup_label("qa-copy");
    safe_id(&id)?;
    let copy = child_path(root, &format!("copies/{id}"))?;
    fs::create_dir_all(copy.join("app-data"))?;
    fs::create_dir_all(copy.join("codex-home"))?;
    let mut names = Vec::new();
    for (name, bytes) in files {
        let target = copy
            .join(if matches!(name.as_str(), "config.toml" | "auth.json") {
                "codex-home"
            } else {
                "app-data"
            })
            .join(&name);
        fs::write(&target, &bytes)?;
        if digest(&fs::read(&target)?) != digest(&bytes) {
            return Err(error("副本回读校验失败，原副本保持不变。"));
        }
        names.push(name);
    }
    // 登录只使用文件凭据；配置副本不继承指向真实安装的 token helper。
    let config = copy.join("codex-home/config.toml");
    let mut table: toml::Table = fs::read_to_string(&config)
        .unwrap_or_default()
        .parse()
        .map_err(|_| error("副本配置无效。"))?;
    table.insert(
        "cli_auth_credentials_store".into(),
        toml::Value::String("file".into()),
    );
    if let Some(providers) = table
        .get_mut("model_providers")
        .and_then(toml::Value::as_table_mut)
    {
        for (_, value) in providers.iter_mut() {
            if let Some(provider) = value.as_table_mut() {
                provider.remove("auth");
            }
        }
    }
    let mut document = toml::to_string(&table).map_err(|_| error("副本配置无法序列化。"))?;
    // Never execute an imported helper. Rebind a uniquely matched provider to
    // our read-only helper and the new copy, without opening the live catalog.
    let profiles = copy.join("app-data").join(PROFILES_FILE);
    if profiles.is_file() {
        let catalog: StoredCatalog = parse_json_document(&fs::read_to_string(&profiles)?)?;
        let id = current_profile_id(&catalog, &document);
        if catalog.profiles.contains_key(&id) && id != "chatgpt-official-account" {
            let mut lines = document.lines().map(str::to_owned).collect::<Vec<_>>();
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
                    "api_key",
                    "requires_openai_auth",
                    "env_key",
                    "experimental_bearer_token",
                ] {
                    remove_section_key(&mut lines, start, &mut end, key);
                }
                append_bound_provider_auth(&mut lines, &mut end, &id, &copy.join("app-data"))?;
                document = lines.join("\r\n");
            }
        }
    }
    fs::write(&config, document)?;
    create_backup_at(&copy.join("app-data/backups"), "qa-live-copy", "signalman_initial_takeover", &config, &copy.join("codex-home/auth.json"))?;
    // The selected source layer is projected to the copy's sole config.toml.
    // This is a QA import, not replay of the first-run onboarding flow. Mark
    // the isolated copy as ready so the product workspace can exercise real
    // features without showing the end-user setup wizard.
    fs::write(
        copy.join("app-data/connection-environment.json"),
        serde_json::to_vec(&json!({
            "selected_layer_id":"user-config",
            "setup_completed":true,
            "onboarding_completed":true,
            "takeover_version": SIGNALMAN_TAKEOVER_VERSION,
            "takeover_backup_label":"qa-live-copy"
        }))?,
    )?;
    if !names.iter().any(|v| v == "connection-environment.json") {
        names.push("connection-environment.json".into());
    }
    if !names.iter().any(|v| v == "config.toml") {
        names.push("config.toml".into());
    }
    fs::write(
        copy.join("ready.json"),
        serde_json::to_vec(&json!({"id":id,"snapshotId":manifest.id,"files":names}))?,
    )?;
    // 只替换很小的指针；旧目录仍保留，任何前置失败不损坏旧副本。
    write_bytes_atomically(&root.join("active.txt"), id.as_bytes())?;
    active(root)?;
    Ok(())
}
pub(crate) fn clear_copy() -> Result<QaLiveValidationStatus, SwitcherError> {
    let root = root()?;
    {
        let _guard = controller(&root)?;
        let pointer = root.join("active.txt");
        if pointer.exists() {
            fs::remove_file(pointer)?;
        }
        let copies = child_path(&root, "copies")?;
        if copies.exists() {
            validate_tree(&root, &copies)?;
            fs::remove_dir_all(copies)?;
        }
    }
    status()
}
#[tauri::command]
pub(crate) fn qa_clear_snapshots() -> Result<QaLiveValidationStatus, SwitcherError> {
    let root = root()?;
    {
        let _guard = controller(&root)?;
        let snapshots = child_path(&root, "snapshots")?;
        if snapshots.exists() {
            validate_tree(&root, &snapshots)?;
            fs::remove_dir_all(snapshots)?;
        }
        let pointer = root.join("latest-snapshot.txt");
        if pointer.exists() {
            fs::remove_file(pointer)?;
        }
    }
    status()
}
pub(crate) fn open_window() -> Result<QaLiveValidationStatus, SwitcherError> {
    let _transition = Transition::begin()?;
    let root = root()?;
    let (action, lease) = controller(&root)?;
    let copy = active(&root)?;
    {
        let mut session = SESSION.lock().map_err(|_| error("QA 会话状态异常。"))?;
        session.copy = Some(copy);
        session.leases = Some((action, lease));
    }
    if let Err(err) = validate_live().and_then(|_| load_state_core()) {
        let mut session = SESSION.lock().map_err(|_| error("QA 会话状态异常。"))?;
        session.copy = None;
        session.leases = None;
        return Err(err);
    }
    status()
}
#[tauri::command]
pub(crate) fn qa_leave_live_validation() -> Result<QaLiveValidationStatus, SwitcherError> {
    let _transition = Transition::begin()?;
    if env::var("CODEX_PROVIDER_SWITCHER_QA_LIVE_VALIDATION").as_deref() == Ok("1") {
        return Err(error(
            "这是旧版独立验证进程。请先关闭它，再从新版 QA 进入。",
        ));
    }
    if live_requested() {
        stop_login_on_exit();
    }
    {
        let mut session = SESSION.lock().map_err(|_| error("QA 会话状态异常。"))?;
        session.copy = None;
        session.leases = None;
    }
    status()
}
pub(crate) fn login_command(path: &Path) -> Result<std::process::Command, SwitcherError> {
    let mut command = std::process::Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if is_development_release_channel() {
        let home = validate_live()?;
        command
            .current_dir(&home)
            .env(OFFICIAL_CODEX_HOME_ENV, home)
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .args(["-c", "cli_auth_credentials_store=\"file\""]);
    }
    Ok(command)
}
pub(crate) fn start_login(mut command: std::process::Command) -> Result<(), SwitcherError> {
    let mut login = LOGIN.lock().map_err(|_| error("登录状态异常。"))?;
    if let Some(child) = login.as_mut() {
        if child.try_wait()?.is_none() {
            return Err(error(
                "Codex 官方登录仍在进行中；请先完成或取消当前浏览器授权。",
            ));
        }
        *login = None;
    }
    *login = Some(command.spawn()?);
    let login_id = login.as_ref().unwrap().id();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(300));
        if let Ok(mut guard) = LOGIN.lock() {
            if guard.as_ref().is_some_and(|child| child.id() == login_id) {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                *guard = None;
            }
        }
    });
    Ok(())
}

pub(crate) fn login_is_running() -> Result<bool, SwitcherError> {
    let mut login = LOGIN.lock().map_err(|_| error("登录状态异常。"))?;
    let Some(child) = login.as_mut() else {
        return Ok(false);
    };
    if child.try_wait()?.is_some() {
        *login = None;
        Ok(false)
    } else {
        Ok(true)
    }
}

#[tauri::command]
pub(crate) fn cancel_chatgpt_login() -> Result<(), SwitcherError> {
    let _scope = operation_scope()?;
    let mut login = LOGIN.lock().map_err(|_| error("登录状态异常。"))?;
    if let Some(child) = login.as_mut() {
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
        child.wait()?;
    }
    *login = None;
    Ok(())
}

pub(crate) fn stop_login_on_exit() {
    if !live_requested() {
        return;
    }
    if let Ok(mut target) = TARGET.lock() {
        if let Some((child, _, _)) = target.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *target = None;
    }
    if let Ok(mut login) = LOGIN.lock() {
        if let Some(child) = login.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        *login = None;
    }
}

#[tauri::command]
pub(crate) fn qa_check_summary() -> Result<Value, SwitcherError> {
    let (project, _, _) = development_fixture_roots()?;
    let path = project.join(".codex/runtime/qa-receipts/latest-qa-quick.json");
    if !path.is_file() {
        return Ok(json!({"result":"not-run"}));
    }
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    if value["kind"] != "qa-quick/v2" {
        return Ok(json!({"result":"legacy"}));
    }
    // 不把命令输出、机器路径或真实资料送进问题包。
    Ok(
        json!({"runId":value["runId"],"result":value["result"],"sourceRevision":value["sourceRevision"],"sourceFingerprint":value["sourceFingerprint"],"fixtureFingerprint":value["fixtureFingerprint"],"finishedAt":value["finishedAt"],"checks":value["checks"],"skipped":value["skipped"]}),
    )
}

#[cfg(all(test, windows))]
pub(crate) mod tests {
    #[test]
    fn mode_transition_rejects_inflight_operations() {
        let mut session = super::Session {
            copy: None,
            operations: 1,
            transitioning: false,
            leases: None,
        };
        assert!(session.begin_transition().is_err());
        assert!(!session.transitioning);
        session.operations = 0;
        session.begin_transition().unwrap();
        assert!(session.begin_transition().is_err());
    }

    // Invoked by the explicit boundary fixture runner, never with user data.
    pub(crate) fn single_window_roundtrip(app: &Path, codex: &Path) {
        let previous_dir = env::current_dir().unwrap();
        let project = previous_dir.parent().unwrap();
        assert!(project.join(".codex/runtime").is_dir());
        env::set_current_dir(project).unwrap();
        let test_root = app.parent().unwrap().join("single-window-session");
        fs::create_dir_all(&test_root).unwrap();
        env::set_var("SIGNALMAN_QA_TEST_ROOT", &test_root);
        create_snapshot_at(&test_root, codex, app).unwrap();
        import_at(&test_root).unwrap();
        let original = fs::read(codex.join("config.toml")).unwrap();
        let original_pid = std::process::id();
        let scope = operation_scope().unwrap();
        assert!(open_window().is_err());
        drop(scope);
        for _ in 0..2 {
            assert_eq!(open_window().unwrap().mode, "live-copy");
            assert_ne!(
                app_data_dir().unwrap().canonicalize().unwrap(),
                app.canonicalize().unwrap()
            );
            assert_ne!(
                codex_home().unwrap().canonicalize().unwrap(),
                codex.canonicalize().unwrap()
            );
            assert_eq!(
                validate_live().unwrap(),
                codex_home().unwrap().canonicalize().unwrap()
            );
            assert!(clear_copy().is_err());
            assert!(qa_clear_snapshots().is_err());
            let scope = operation_scope().unwrap();
            assert!(qa_leave_live_validation().is_err());
            drop(scope);
            assert_eq!(qa_leave_live_validation().unwrap().mode, "fixture");
            assert_eq!(std::process::id(), original_pid);
            assert_eq!(fs::read(codex.join("config.toml")).unwrap(), original);
            assert_eq!(
                codex_home().unwrap().canonicalize().unwrap(),
                codex.canonicalize().unwrap()
            );
        }
        let copy = active(&test_root).unwrap();
        fs::write(copy.join("codex-home/config.toml"), "not valid [").unwrap();
        assert!(open_window().is_err());
        assert!(!live_requested());
        assert!(lock(&test_root, "live.lock").is_ok());
        env::remove_var("SIGNALMAN_QA_TEST_ROOT");
        env::set_current_dir(previous_dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn isolated_target_stops_when_its_lifetime_ends() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let lifetime = match super::TargetLifetime::bind(&child) {
            Ok(value) => value,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("{err}");
            }
        };
        assert!(child.try_wait().unwrap().is_none());
        drop(lifetime);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("isolated child outlived its job");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    #[cfg(windows)]
    #[test]
    fn active_login_cannot_be_replaced_by_a_second_start() {
        let command = || {
            let mut command = std::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            command
        };
        super::start_login(command()).unwrap();
        assert!(super::login_is_running().unwrap());
        assert!(super::start_login(command()).is_err());
        assert!(super::login_is_running().unwrap());
        let mut login = super::LOGIN.lock().unwrap();
        if let Some(child) = login.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *login = None;
    }
    use super::*;
    #[test]
    fn qa_snapshot_transaction_and_corruption() {
        let root = env::temp_dir().join(unique_backup_label("signalman-qa-test"));
        fs::create_dir_all(root.join("source")).unwrap();
        let source = root.join("source");
        fs::write(source.join("config.toml"), "model = 'example'\n").unwrap();
        create_snapshot_at(&root, &source, &source).unwrap();
        import_at(&root).unwrap();
        let before = fs::read(root.join("active.txt")).unwrap();
        let copy = active(&root).unwrap();
        assert!(fs::read_to_string(copy.join("codex-home/config.toml"))
            .unwrap()
            .contains("cli_auth_credentials_store = \"file\""));
        let environment =
            fs::read_to_string(copy.join("app-data/connection-environment.json")).unwrap();
        assert!(environment.contains("\"takeover_version\":1"));
        let (manifest, _) = snapshot(&root).unwrap();
        fs::write(
            root.join(format!("snapshots/{}/config.toml.dpapi", manifest.id)),
            "corrupt",
        )
        .unwrap();
        assert!(import_at(&root).is_err());
        assert_eq!(before, fs::read(root.join("active.txt")).unwrap());
        assert!(active(&root).is_ok());
        fs::remove_file(copy.join("codex-home/config.toml")).unwrap();
        assert!(active(&root).is_err());
        assert_eq!(
            fs::read_to_string(source.join("config.toml")).unwrap(),
            "model = 'example'\n"
        );
        assert!(safe_id("../outside").is_err());
        assert!(child_path(&root, "../outside").is_err());
        let lease = lock(&root, "test.lock").unwrap();
        assert!(lock(&root, "test.lock").is_err());
        drop(lease);
        assert!(lock(&root, "test.lock").is_ok());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn qa_external_auth_helper_removed_from_copy() {
        let root = env::temp_dir().join(unique_backup_label("signalman-qa-helper-test"));
        fs::create_dir_all(root.join("source")).unwrap();
        let source = root.join("source");
        let config = "[model_providers.custom]\nname='demo'\n[model_providers.custom.auth]\ncommand='do-not-run'\n";
        fs::write(source.join("config.toml"), config).unwrap();
        create_snapshot_at(&root, &source, &source).unwrap();
        import_at(&root).unwrap();
        let actual =
            fs::read_to_string(active(&root).unwrap().join("codex-home/config.toml")).unwrap();
        assert!(!actual.contains("do-not-run"));
        assert_eq!(
            fs::read_to_string(source.join("config.toml")).unwrap(),
            config
        );
        fs::remove_dir_all(root).unwrap();
    }
}
