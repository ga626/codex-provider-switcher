use codex_switcher_tauri_lib::{
    delete_profile_core, load_state_core, refresh_models_core, restore_latest_backup_core,
    save_profile_core, set_default_profile_core, switch_profile_core, toggle_auto_start_core,
    verify_profile_core, AppState, EditableProfile, SwitcherError,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    time::Duration,
};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 47832;

fn main() {
    if let Err(err) = run() {
        eprintln!("CodeX Provider Switcher local backend failed: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let port = arg_value("--port")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = arg_value("--host").unwrap_or_else(|| DEFAULT_HOST.to_string());
    if host != DEFAULT_HOST {
        return Err("local backend only supports 127.0.0.1 binding".into());
    }

    let listener = TcpListener::bind((host.as_str(), port))?;
    let dist_dir = resolve_dist_dir()?;
    println!("CodeX Provider Switcher local backend: http://{host}:{port}/");
    println!("Serving frontend from {}", dist_dir.display());

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let dist_dir = dist_dir.clone();
                if let Err(err) = handle_connection(stream, &dist_dir) {
                    eprintln!("request failed: {err}");
                }
            }
            Err(err) => eprintln!("connection failed: {err}"),
        }
    }
    Ok(())
}

fn arg_value(flag: &str) -> Option<String> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}

fn resolve_dist_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(value) = env::var("CODEX_PROVIDER_SWITCHER_DIST_DIR") {
        let path = PathBuf::from(value);
        if path.join("index.html").exists() {
            return Ok(path);
        }
    }

    let cwd_dist = env::current_dir()?.join("dist");
    if cwd_dist.join("index.html").exists() {
        return Ok(cwd_dist);
    }

    let exe_dist = env::current_exe()?
        .parent()
        .map(|path| path.join("dist"))
        .filter(|path| path.join("index.html").exists());
    if let Some(path) = exe_dist {
        return Ok(path);
    }

    let packaged_dist = env::current_exe()?
        .parent()
        .and_then(|path| path.parent())
        .map(|path| path.join("dist"))
        .filter(|path| path.join("index.html").exists());
    packaged_dist.ok_or_else(|| "dist/index.html not found; run npm run build first".into())
}

fn handle_connection(
    mut stream: TcpStream,
    dist_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    stream.set_read_timeout(Some(Duration::from_secs(8)))?;
    let request = read_request(&mut stream)?;
    let (method, path, headers, body) = request;

    if method == "OPTIONS" {
        return write_response(&mut stream, 204, "text/plain; charset=utf-8", b"");
    }

    if path.starts_with("/api/") {
        if !is_allowed_local_api_request(&headers) {
            return write_json(&mut stream, 403, &json!({ "error": "forbidden origin" }));
        }
        return handle_api(&mut stream, &method, &path, &body);
    }

    if method != "GET" && method != "HEAD" {
        return write_json(&mut stream, 405, &json!({ "error": "method not allowed" }));
    }

    let (content_type, bytes) = static_asset(dist_dir, &path)?;
    if method == "HEAD" {
        write_response(&mut stream, 200, content_type, b"")
    } else {
        write_response(&mut stream, 200, content_type, &bytes)
    }
}

fn read_request(
    stream: &mut TcpStream,
) -> Result<(String, String, Vec<(String, String)>, Vec<u8>), Box<dyn std::error::Error>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut header_end = None;
    let mut content_length = 0_usize;

    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);

        if header_end.is_none() {
            header_end = find_header_end(&buffer);
            if let Some(end) = header_end {
                let headers = String::from_utf8_lossy(&buffer[..end]);
                content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
            }
        }

        if let Some(end) = header_end {
            if buffer.len() >= end + 4 + content_length {
                break;
            }
        }
    }

    let end = header_end.ok_or("invalid HTTP request")?;
    let head = String::from_utf8_lossy(&buffer[..end]);
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing method")?.to_string();
    let path = parts.next().ok_or("missing path")?.to_string();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    let body_start = end + 4;
    let body_end = body_start + content_length;
    let body = if buffer.len() >= body_end {
        buffer[body_start..body_end].to_vec()
    } else {
        Vec::new()
    };

    Ok((method, path, headers, body))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header_name, _)| header_name == name)
        .map(|(_, value)| value.as_str())
}

fn is_local_host(value: &str) -> bool {
    let host = value.split(':').next().unwrap_or(value);
    host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost")
}

fn is_local_origin(value: &str) -> bool {
    let origin = value.strip_prefix("http://").unwrap_or(value);
    is_local_host(origin)
}

fn is_allowed_local_api_request(headers: &[(String, String)]) -> bool {
    let Some(host) = header_value(headers, "host") else {
        return false;
    };
    if !is_local_host(host) {
        return false;
    }

    if let Some(fetch_site) = header_value(headers, "sec-fetch-site") {
        if fetch_site.eq_ignore_ascii_case("cross-site") {
            return false;
        }
    }

    if let Some(origin) = header_value(headers, "origin") {
        return is_local_origin(origin);
    }

    true
}

fn handle_api(
    stream: &mut TcpStream,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let result = match (method, path.split('?').next().unwrap_or(path)) {
        ("GET", "/api/health") => Ok(json!({ "ok": true, "runtimeMode": "local_web_backend" })),
        ("GET", "/api/state") => load_state_core().map(state_json),
        ("POST", "/api/profiles/save") => {
            let profile = request_json(body)?
                .get("profile")
                .cloned()
                .ok_or_else(|| SwitcherError::Message("缺少 profile。".to_string()))
                .and_then(|value| {
                    serde_json::from_value::<EditableProfile>(value).map_err(SwitcherError::from)
                })?;
            save_profile_core(profile).map(state_json)
        }
        ("POST", "/api/profiles/delete") => delete_profile_core(profile_id(body)?).map(state_json),
        ("POST", "/api/profiles/switch") => switch_profile_core(profile_id(body)?).map(state_json),
        ("POST", "/api/profiles/verify") => verify_profile_core(profile_id(body)?).map(state_json),
        ("POST", "/api/models/refresh") => refresh_models_core(profile_id(body)?).map(state_json),
        ("POST", "/api/profiles/default") => {
            set_default_profile_core(profile_id(body)?).map(state_json)
        }
        ("POST", "/api/auto-start") => {
            let enabled = request_json(body)?
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            toggle_auto_start_core(enabled).map(state_json)
        }
        ("POST", "/api/backup/restore-latest") => restore_latest_backup_core().map(state_json),
        _ => return write_json(stream, 404, &json!({ "error": "not found" })),
    };

    match result {
        Ok(value) => write_json(stream, 200, &value),
        Err(err) => write_json(stream, 500, &json!({ "error": err.to_string() })),
    }
}

fn request_json(body: &[u8]) -> Result<Value, SwitcherError> {
    if body.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice::<Value>(body).map_err(SwitcherError::from)
    }
}

fn profile_id(body: &[u8]) -> Result<String, SwitcherError> {
    request_json(body)?
        .get("profileId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| SwitcherError::Message("缺少 profileId。".to_string()))
}

fn state_json(mut state: AppState) -> Value {
    state.runtime_mode = "local_web_backend".to_string();
    serde_json::to_value(state).unwrap_or_else(|err| json!({ "error": err.to_string() }))
}

fn static_asset(
    dist_dir: &Path,
    request_path: &str,
) -> Result<(&'static str, Vec<u8>), Box<dyn std::error::Error>> {
    let path_without_query = request_path.split('?').next().unwrap_or(request_path);
    let relative = path_without_query.trim_start_matches('/');
    let candidate = if relative.is_empty() {
        dist_dir.join("index.html")
    } else if relative.contains("..") {
        return Err("invalid path".into());
    } else {
        dist_dir.join(relative)
    };

    let path = if candidate.is_file() {
        candidate
    } else {
        dist_dir.join("index.html")
    };
    let content_type = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "text/html; charset=utf-8",
    };
    Ok((content_type, fs::read(path)?))
}

fn write_json(
    stream: &mut TcpStream,
    status: u16,
    value: &Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = serde_json::to_vec(value)?;
    write_response(stream, status, "application/json; charset=utf-8", &bytes)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(())
}
