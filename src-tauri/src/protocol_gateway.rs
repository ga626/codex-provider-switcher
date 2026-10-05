use crate::{
    current_profile_id, load_catalog, provider_probe_endpoint, read_config, StoredProfile,
};
use reqwest::blocking::{Client, Response};
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 47834;
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_HEADERS: usize = 32 * 1024;

static GATEWAY_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

pub(crate) fn requires_gateway(protocol: &str) -> bool {
    matches!(protocol, "chat_completions" | "anthropic_messages")
}

pub(crate) fn stop_owned_gateway() {
    let Ok(mut child) = GATEWAY_CHILD.lock() else {
        return;
    };
    if let Some(mut process) = child.take() {
        if process.try_wait().ok().flatten().is_none() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

pub(crate) fn local_base_url() -> String {
    format!("http://{HOST}:{PORT}/v1")
}

pub(crate) fn ensure_running() -> Result<(), String> {
    if gateway_healthy() {
        return Ok(());
    }
    let executable = gateway_executable()?;
    let mut command = Command::new(executable);
    command
        .arg("--run-protocol-gateway")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000 | 0x00000008 | 0x00000200);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动本机转换服务：{error}"))?;
    if let Ok(mut owned) = GATEWAY_CHILD.lock() {
        *owned = Some(child);
    }
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(100));
        if gateway_healthy() {
            return Ok(());
        }
    }
    Err("本机转换服务没有在 4 秒内启动；配置未切换。".to_string())
}

pub(crate) fn ensure_active_profile_running() -> Result<(), String> {
    let config = read_config().map_err(|error| error.to_string())?;
    let catalog = load_catalog().map_err(|error| error.to_string())?;
    let id = current_profile_id(&catalog, &config);
    let Some(raw) = catalog.profiles.get(&id) else {
        return Ok(());
    };
    let profile: StoredProfile =
        serde_json::from_value(raw.clone()).map_err(|error| error.to_string())?;
    if profile
        .capability_profile
        .as_ref()
        .is_some_and(|capability| requires_gateway(&capability.protocol))
    {
        ensure_running()?;
    }
    Ok(())
}

fn gateway_executable() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let file = current
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if file.eq_ignore_ascii_case("codex-provider-switcher.exe") || !cfg!(windows) {
        return Ok(current);
    }
    let candidate = current.with_file_name("codex-provider-switcher.exe");
    if candidate.is_file() {
        return Ok(candidate);
    }
    Err("找不到 Signalman 主程序，无法启动本机转换服务。".to_string())
}

fn gateway_healthy() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], PORT)),
        Duration::from_millis(150),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    if stream
        .write_all(
            b"GET /_signalman/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response.contains("signalman-protocol-gateway")
}

pub(crate) fn run() -> Result<(), String> {
    let listener = TcpListener::bind((HOST, PORT))
        .map_err(|error| format!("监听本机转换端口失败：{error}"))?;
    for stream in listener.incoming() {
        if let Ok(stream) = stream {
            std::thread::spawn(move || handle(stream));
        }
    }
    Ok(())
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || path.is_empty() {
        return Err("无效的 HTTP 请求行。".to_string());
    }
    let mut headers = Vec::new();
    let mut content_length = None;
    let mut chunked = false;
    let mut header_bytes = request_line.len();
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        header_bytes = header_bytes.saturating_add(line.len());
        if header_bytes > MAX_HEADERS {
            return Err("HTTP 请求头超过大小限制。".to_string());
        }
        if line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if name == "content-length" {
                content_length = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| "Content-Length 格式无效。".to_string())?,
                );
            }
            if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
            headers.push((name, value));
        }
    }
    let body = if chunked {
        read_chunked_body(&mut reader)?
    } else {
        let length = content_length.unwrap_or(0);
        if length > MAX_BODY {
            return Err("请求正文超过 8 MB 限制。".to_string());
        }
        let mut body = vec![0; length];
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("读取请求正文失败：{error}"))?;
        body
    };
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn read_chunked_body(reader: &mut impl BufRead) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        reader
            .read_line(&mut size_line)
            .map_err(|error| error.to_string())?;
        let size_text = size_line.trim().split(';').next().unwrap_or_default();
        let size =
            usize::from_str_radix(size_text, 16).map_err(|_| "分块请求长度无效。".to_string())?;
        if size == 0 {
            loop {
                let mut trailer = String::new();
                reader
                    .read_line(&mut trailer)
                    .map_err(|error| error.to_string())?;
                if trailer == "\r\n" || trailer == "\n" || trailer.is_empty() {
                    return Ok(body);
                }
            }
        }
        if body.len().saturating_add(size) > MAX_BODY {
            return Err("请求正文超过 8 MB 限制。".to_string());
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|error| error.to_string())?;
        let mut ending = [0; 2];
        reader
            .read_exact(&mut ending)
            .map_err(|error| error.to_string())?;
        if ending != *b"\r\n" {
            return Err("分块请求结束标记无效。".to_string());
        }
    }
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn handle(mut stream: TcpStream) {
    if let Err(error) = handle_inner(&mut stream) {
        let _ = write_json(
            &mut stream,
            502,
            &json!({"error":{"message":error,"type":"signalman_gateway_error"}}),
        );
    }
}

fn handle_inner(stream: &mut TcpStream) -> Result<(), String> {
    let request = match read_request(stream) {
        Ok(request) => request,
        Err(error) => {
            return write_json(
                stream,
                400,
                &json!({"error":{"message":error,"type":"invalid_request_error"}}),
            )
        }
    };
    if request.method == "GET" && request.path == "/_signalman/health" {
        return write_json(
            stream,
            200,
            &json!({"service":"signalman-protocol-gateway","version":1}),
        );
    }
    if request.method == "OPTIONS" {
        return write_raw(stream, 204, "text/plain", b"");
    }
    if request.method != "POST" || !request.path.ends_with("/responses") {
        return write_json(
            stream,
            404,
            &json!({"error":{"message":"本机转换服务不支持该地址。","type":"invalid_request_error"}}),
        );
    }

    let config = read_config().map_err(|error| error.to_string())?;
    let catalog = load_catalog().map_err(|error| error.to_string())?;
    let id = current_profile_id(&catalog, &config);
    let raw = catalog
        .profiles
        .get(&id)
        .cloned()
        .ok_or_else(|| "当前没有匹配的服务商资料。".to_string())?;
    let profile: StoredProfile = serde_json::from_value(raw).map_err(|error| error.to_string())?;
    let protocol = profile
        .capability_profile
        .as_ref()
        .map(|capability| capability.protocol.as_str())
        .unwrap_or_default();
    if !requires_gateway(protocol) {
        return write_json(
            stream,
            409,
            &json!({"error":{"message":"当前服务商未检测为可转换的上游格式。","type":"invalid_request_error"}}),
        );
    }
    let expected = format!("Bearer {}", profile.api_key.trim());
    if profile.api_key.trim().is_empty()
        || header(&request, "authorization") != Some(expected.as_str())
    {
        return write_json(
            stream,
            401,
            &json!({"error":{"message":"本机转换请求未通过服务商凭据校验。","type":"authentication_error"}}),
        );
    }
    let input: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(_) => {
            return write_json(
                stream,
                400,
                &json!({"error":{"message":"请求不是有效 JSON。","type":"invalid_request_error"}}),
            )
        }
    };
    let stream_response = input
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let conversion = match protocol {
        "chat_completions" => responses_request_to_chat(&input),
        "anthropic_messages" => responses_request_to_anthropic(&input),
        _ => unreachable!("protocol was checked above"),
    };
    let upstream_body = match conversion {
        Ok(value) => value,
        Err(error) => {
            return write_json(
                stream,
                400,
                &json!({"error":{"message":error,"type":"unsupported_request_error"}}),
            )
        }
    };
    let endpoint_path = if protocol == "anthropic_messages" {
        "messages"
    } else {
        "chat/completions"
    };
    let endpoint = provider_probe_endpoint(&profile.base_url, endpoint_path)
        .map_err(|error| error.to_string())?;
    crate::qa::guard_network(&endpoint).map_err(|error| error.to_string())?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(180))
        .http1_only()
        .build()
        .map_err(|error| error.to_string())?;
    let mut upstream_request = client.post(endpoint).header(
        reqwest::header::ACCEPT,
        if stream_response {
            "text/event-stream"
        } else {
            "application/json"
        },
    );
    upstream_request = if protocol == "anthropic_messages" {
        upstream_request
            .header("x-api-key", profile.api_key.trim())
            .header("anthropic-version", "2023-06-01")
    } else {
        upstream_request.bearer_auth(profile.api_key.trim())
    };
    let response = upstream_request
        .json(&upstream_body)
        .send()
        .map_err(|error| format!("连接服务商失败：{error}"))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response
            .bytes()
            .map_err(|error| format!("读取服务商错误信息失败：{error}"))?;
        return write_raw(stream, status, "application/json", &body);
    }
    if stream_response {
        if protocol == "anthropic_messages" {
            translate_anthropic_stream(response, stream)
        } else {
            translate_stream(response, stream)
        }
    } else {
        let value: Value = response
            .json()
            .map_err(|error| format!("服务商返回了无效 JSON：{error}"))?;
        let converted = if protocol == "anthropic_messages" {
            anthropic_response_to_responses(&value)?
        } else {
            chat_response_to_responses(&value)?
        };
        write_json(stream, status, &converted)
    }
}

fn responses_request_to_chat(input: &Value) -> Result<Value, String> {
    let model = input
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请求缺少模型名称。".to_string())?;
    if input
        .get("previous_response_id")
        .is_some_and(|value| !value.is_null())
        || input
            .get("conversation")
            .is_some_and(|value| !value.is_null())
    {
        return Err(
            "当前模型转换不支持服务端保存的跨轮会话；请使用支持 Responses 的服务商。".to_string(),
        );
    }
    let mut messages = Vec::<Value>::new();
    if let Some(instructions) = input
        .get("instructions")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({"role":"system","content":instructions}));
    }
    match input.get("input").cloned().unwrap_or(Value::Null) {
        Value::String(text) => messages.push(json!({"role":"user","content":text})),
        Value::Array(items) => {
            for item in items {
                match item.get("type").and_then(Value::as_str).unwrap_or("message") {
                    "message" => {
                        let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                        let content = item.get("content").cloned().unwrap_or(Value::String(String::new()));
                        messages.push(json!({"role":role,"content":response_content_to_chat(content)?}));
                    }
                    "function_call" => messages.push(json!({"role":"assistant","tool_calls":[{"id":item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),"type":"function","function":{"name":item.get("name"),"arguments":item.get("arguments").and_then(Value::as_str).unwrap_or("{}")} }]})),
                    "function_call_output" => messages.push(json!({"role":"tool","tool_call_id":item.get("call_id").and_then(Value::as_str).unwrap_or_default(),"content":tool_output_text(item.get("output").unwrap_or(&Value::Null))})),
                    _ => return Err("当前转换不支持这类 Responses 输入（例如内部推理记录或图像生成任务）。".to_string()),
                }
            }
        }
        _ => return Err("Responses 输入格式暂不支持。".to_string()),
    }
    let mut body = json!({"model":model,"messages":messages,"stream":input.get("stream").and_then(Value::as_bool).unwrap_or(false)});
    if let Some(value) = input.get("max_output_tokens") {
        body["max_tokens"] = value.clone();
    }
    for key in [
        "temperature",
        "top_p",
        "parallel_tool_calls",
        "metadata",
        "user",
        "service_tier",
    ] {
        if let Some(value) = input.get(key) {
            body[key] = value.clone();
        }
    }
    if let Some(reasoning) = input.get("reasoning").and_then(|value| value.get("effort")) {
        body["reasoning_effort"] = reasoning.clone();
    }
    if let Some(tools) = input.get("tools").and_then(Value::as_array) {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    let mut function = Map::new();
                    for key in ["name", "description", "parameters", "strict"] {
                        if let Some(value) = tool.get(key) {
                            function.insert(key.to_string(), value.clone());
                        }
                    }
                    json!({"type":"function","function":function})
                })
                .collect(),
        );
    }
    if let Some(choice) = input.get("tool_choice") {
        body["tool_choice"] = tool_choice_to_chat(choice)?;
    }
    if body["stream"] == true {
        body["stream_options"] = json!({"include_usage":true});
    }
    Ok(body)
}

fn tool_output_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn tool_choice_to_chat(choice: &Value) -> Result<Value, String> {
    match choice {
        Value::String(_) => Ok(choice.clone()),
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("function") => {
            let name = map
                .get("name")
                .cloned()
                .ok_or_else(|| "指定工具时缺少工具名称。".to_string())?;
            Ok(json!({"type":"function","function":{"name":name}}))
        }
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("allowed_tools") => {
            Err("当前转换暂不支持受限工具集合；请改用支持 Responses 的服务商。".to_string())
        }
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("auto") => {
            Ok(json!("auto"))
        }
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("required") => {
            Ok(json!("required"))
        }
        _ => Err("工具选择方式暂不支持。".to_string()),
    }
}

fn response_content_to_chat(content: Value) -> Result<Value, String> {
    match content {
        Value::String(_) => Ok(content),
        Value::Array(parts) => {
            let mut out = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str).unwrap_or("") {
                    "input_text" | "output_text" | "text" => out.push(json!({"type":"text","text":part.get("text").cloned().unwrap_or(Value::Null)})),
                    "input_image" => {
                        let url = if let Some(url) = part.get("image_url").and_then(Value::as_str) {
                            url.to_string()
                        } else if let Some(data) = part.get("image_data").and_then(Value::as_str) {
                            let mime = part.get("mime_type").and_then(Value::as_str).unwrap_or("image/png");
                            format!("data:{mime};base64,{data}")
                        } else {
                            return Err("图片不是可转发的 URL 或 base64 图片数据。".to_string());
                        };
                        let detail = part.get("detail").and_then(Value::as_str).unwrap_or("auto");
                        out.push(json!({"type":"image_url","image_url":{"url":url,"detail":detail}}));
                    }
                    _ => return Err("当前本机转换不支持这类多模态输入。".to_string()),
                }
            }
            Ok(Value::Array(out))
        }
        _ => Err("消息内容格式暂不支持。".to_string()),
    }
}

fn responses_request_to_anthropic(input: &Value) -> Result<Value, String> {
    let model = input
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请求缺少模型名称。".to_string())?;
    if input
        .get("previous_response_id")
        .is_some_and(|value| !value.is_null())
        || input
            .get("conversation")
            .is_some_and(|value| !value.is_null())
    {
        return Err(
            "当前模型转换不支持服务端保存的跨轮会话；请使用支持 Responses 的服务商。".to_string(),
        );
    }

    let mut messages = Vec::<Value>::new();
    let mut pending_tool_results = Vec::<Value>::new();
    match input.get("input").cloned().unwrap_or(Value::Null) {
        Value::String(text) => messages.push(json!({"role":"user","content":text})),
        Value::Array(items) => {
            for item in items {
                match item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message")
                {
                    "message" => {
                        flush_anthropic_tool_results(&mut messages, &mut pending_tool_results);
                        let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                        if !matches!(role, "user" | "assistant") {
                            return Err("Anthropic Messages 只接受 user 或 assistant 消息；system/developer 内容应放在 instructions。".to_string());
                        }
                        let content = item
                            .get("content")
                            .cloned()
                            .unwrap_or(Value::String(String::new()));
                        messages.push(
                            json!({"role":role,"content":responses_content_to_anthropic(content)?}),
                        );
                    }
                    "function_call" => {
                        flush_anthropic_tool_results(&mut messages, &mut pending_tool_results);
                        let call_id = item
                            .get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                        let input = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .and_then(|text| serde_json::from_str::<Value>(text).ok())
                            .unwrap_or_else(|| json!({}));
                        messages.push(json!({"role":"assistant","content":[{"type":"tool_use","id":call_id,"name":name,"input":input}]}));
                    }
                    "function_call_output" => {
                        let content = item.get("output").map(tool_output_text).unwrap_or_default();
                        pending_tool_results.push(json!({"type":"tool_result","tool_use_id":item.get("call_id"),"content":content}));
                    }
                    _ => {
                        return Err(
                            "当前转换不支持这类 Responses 输入（例如内部推理记录或图像生成任务）。"
                                .to_string(),
                        )
                    }
                }
            }
        }
        _ => return Err("Responses 输入格式暂不支持。".to_string()),
    }
    flush_anthropic_tool_results(&mut messages, &mut pending_tool_results);

    let mut body = json!({
        "model":model,
        "messages":messages,
        "max_tokens":input.get("max_output_tokens").and_then(Value::as_u64).unwrap_or(1024),
        "stream":input.get("stream").and_then(Value::as_bool).unwrap_or(false),
    });
    if let Some(instructions) = input.get("instructions").and_then(Value::as_str) {
        body["system"] = json!(instructions);
    }
    for key in ["temperature", "top_p", "metadata"] {
        if let Some(value) = input.get(key) {
            body[key] = value.clone();
        }
    }
    let tools_disabled = input
        .get("tool_choice")
        .and_then(|choice| choice.get("type"))
        .and_then(Value::as_str)
        == Some("none");
    if !tools_disabled {
        if let Some(tools) = input.get("tools").and_then(Value::as_array) {
            body["tools"] = Value::Array(tools.iter().map(|tool| {
                json!({
                    "name":tool.get("name"),
                    "description":tool.get("description"),
                    "input_schema":tool.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
                })
            }).collect());
        }
    }
    if let Some(choice) = input.get("tool_choice") {
        body["tool_choice"] = match choice.get("type").and_then(Value::as_str).unwrap_or("auto") {
            "auto" => json!({"type":"auto"}),
            "none" => Value::Null,
            "required" => json!({"type":"any"}),
            "function" => json!({"type":"tool","name":choice.get("name")}),
            _ => return Err("当前转换不支持此工具选择方式。".to_string()),
        };
        if body["tool_choice"].is_null() {
            body.as_object_mut().unwrap().remove("tool_choice");
        }
    }
    Ok(body)
}

fn flush_anthropic_tool_results(messages: &mut Vec<Value>, pending: &mut Vec<Value>) {
    if !pending.is_empty() {
        messages.push(json!({"role":"user","content":std::mem::take(pending)}));
    }
}

fn responses_content_to_anthropic(content: Value) -> Result<Value, String> {
    match content {
        Value::String(text) => Ok(json!(text)),
        Value::Array(parts) => {
            let mut output = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str).unwrap_or("") {
                    "input_text" | "output_text" | "text" => output.push(json!({"type":"text","text":part.get("text").cloned().unwrap_or(Value::Null)})),
                    "input_image" => {
                        let image = part.get("image_url").and_then(Value::as_str)
                            .or_else(|| part.get("image_data").and_then(Value::as_str))
                            .ok_or_else(|| "图片不是可转发的 URL 或 base64 图片数据。".to_string())?;
                        if let Some(data) = image.strip_prefix("data:") {
                            let (mime, encoded) = data.split_once(";base64,").ok_or_else(|| "图片 data URL 格式无效。".to_string())?;
                            output.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":encoded}}));
                        } else {
                            output.push(json!({"type":"image","source":{"type":"url","url":image}}));
                        }
                    }
                    _ => return Err("当前本机转换不支持这类多模态输入。".to_string()),
                }
            }
            Ok(Value::Array(output))
        }
        _ => Err("消息内容格式暂不支持。".to_string()),
    }
}

fn anthropic_response_to_responses(value: &Value) -> Result<Value, String> {
    let content = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic 上游没有返回可识别的 content。".to_string())?;
    let mut output = Vec::new();
    let mut text = String::new();
    for (index, block) in content.iter().enumerate() {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                let part = block.get("text").and_then(Value::as_str).unwrap_or_default();
                text.push_str(part);
                output.push(json!({"id":format!("msg_{}_{index}",value.get("id").and_then(Value::as_str).unwrap_or("signalman")),"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":part,"annotations":[]}]}));
            }
            "tool_use" => output.push(json!({"id":block.get("id"),"type":"function_call","call_id":block.get("id"),"name":block.get("name"),"arguments":block.get("input").map(serde_json::to_string).transpose().map_err(|error| error.to_string())?.unwrap_or_else(|| "{}".to_string()),"status":"completed"})),
            _ => {}
        }
    }
    let usage = value.get("usage").cloned().unwrap_or(Value::Null);
    let input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let incomplete = value.get("stop_reason").and_then(Value::as_str) == Some("max_tokens");
    Ok(json!({
        "id":value.get("id").cloned().unwrap_or(json!("resp_signalman")),
        "object":"response",
        "status":if incomplete {"incomplete"} else {"completed"},
        "incomplete_details":if incomplete {json!({"reason":"max_output_tokens"})} else {Value::Null},
        "error":null,
        "model":value.get("model"),
        "output":output,
        "output_text":text,
        "usage":{"input_tokens":input_tokens,"output_tokens":output_tokens,"total_tokens":input_tokens+output_tokens,"input_tokens_details":{"cached_tokens":usage.get("cache_read_input_tokens").cloned().unwrap_or(json!(0))},"output_tokens_details":{"reasoning_tokens":0}},
        "metadata":{}
    }))
}

fn chat_response_to_responses(value: &Value) -> Result<Value, String> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "上游没有返回可识别的选择结果。".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "上游返回缺少 message。".to_string())?;
    let output = chat_message_output(
        message,
        value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("signalman"),
    );
    let usage = value.get("usage").cloned().unwrap_or(Value::Null);
    let input_tokens = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let finish = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("stop");
    let incomplete = finish == "length";
    let output_text = output
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .and_then(|item| item.pointer("/content/0/text"))
        .cloned()
        .unwrap_or(Value::String(String::new()));
    Ok(
        json!({"id":value.get("id").cloned().unwrap_or(json!("resp_signalman")),"object":"response","created_at":value.get("created").cloned().unwrap_or(json!(0)),"status":if incomplete {"incomplete"} else {"completed"},"error":null,"incomplete_details":if incomplete {json!({"reason":"max_output_tokens"})} else {Value::Null},"model":value.get("model"),"output":output,"output_text":output_text,"usage":{"input_tokens":input_tokens,"output_tokens":output_tokens,"total_tokens":input_tokens+output_tokens,"input_tokens_details":{"cached_tokens":usage.pointer("/prompt_tokens_details/cached_tokens").cloned().unwrap_or(json!(0))},"output_tokens_details":{"reasoning_tokens":usage.pointer("/completion_tokens_details/reasoning_tokens").cloned().unwrap_or(json!(0))}},"metadata":{}}),
    )
}

fn chat_message_output(message: &Value, fallback_id: &str) -> Vec<Value> {
    let mut output = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        output.push(json!({"id":format!("msg_{fallback_id}"),"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let id = call.get("id").cloned().unwrap_or(Value::Null);
            output.push(json!({"id":id,"type":"function_call","call_id":call.get("id"),"name":call.pointer("/function/name"),"arguments":call.pointer("/function/arguments"),"status":"completed"}));
        }
    }
    output
}

fn write_json(stream: &mut TcpStream, status: u16, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_raw(stream, status, "application/json", &body)
}

fn write_raw(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        _ => "Upstream Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).map_err(|error| error.to_string())?;
    stream.write_all(body).map_err(|error| error.to_string())
}

fn translate_stream(mut response: Response, stream: &mut TcpStream) -> Result<(), String> {
    let id = format!("resp_{}", crate::unique_backup_label("gateway"));
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n").map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(&mut response);
    let mut line = String::new();
    let mut content = String::new();
    let mut tool_calls: std::collections::BTreeMap<u64, Value> = std::collections::BTreeMap::new();
    let mut output = Vec::<Value>::new();
    let mut output_index = 0usize;
    let mut created = false;
    let mut model = Value::Null;
    let mut usage = Value::Null;
    let mut finish_reason: Option<String> = None;
    loop {
        line.clear();
        let count = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(value) = event.get("model") {
            model = value.clone();
        }
        if let Some(value) = event.get("usage").filter(|value| !value.is_null()) {
            usage = value.clone();
        }
        let Some(delta) = event.pointer("/choices/0/delta") else {
            if let Some(reason) = event
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
            {
                finish_reason = Some(reason.to_string());
            }
            continue;
        };
        if !created {
            let response = json!({"id":id,"object":"response","status":"in_progress","model":model,"output":[]});
            emit_event(
                stream,
                "response.created",
                &json!({"type":"response.created","response":response}),
            )?;
            emit_event(
                stream,
                "response.in_progress",
                &json!({"type":"response.in_progress","response":response}),
            )?;
            created = true;
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            if output
                .iter()
                .all(|item| item.get("type").and_then(Value::as_str) != Some("message"))
            {
                output_index = output.len();
                output.push(json!({"id":format!("msg_{id}"),"type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"","annotations":[]}]}));
                emit_event(
                    stream,
                    "response.output_item.added",
                    &json!({"type":"response.output_item.added","output_index":output_index,"item":output[output_index]}),
                )?;
                emit_event(
                    stream,
                    "response.content_part.added",
                    &json!({"type":"response.content_part.added","item_id":format!("msg_{id}"),"output_index":output_index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                )?;
            }
            content.push_str(text);
            emit_event(
                stream,
                "response.output_text.delta",
                &json!({"type":"response.output_text.delta","item_id":format!("msg_{id}"),"output_index":output_index,"content_index":0,"delta":text}),
            )?;
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                if !tool_calls.contains_key(&index) {
                    let item_index = output.len();
                    let item = json!({"id":call.get("id").cloned().unwrap_or(json!(format!("call_{id}_{index}"))),"type":"function_call","call_id":call.get("id").cloned().unwrap_or(json!(format!("call_{id}_{index}"))),"name":"","arguments":"","status":"in_progress"});
                    output.push(item.clone());
                    tool_calls.insert(
                        index,
                        json!({"output_index":item_index,"id":item["id"],"name":"","arguments":""}),
                    );
                }
                let current = tool_calls.get_mut(&index).unwrap();
                if let Some(value) = call.get("id").and_then(Value::as_str) {
                    current["id"] = json!(value);
                    output[current["output_index"].as_u64().unwrap() as usize]["id"] = json!(value);
                    output[current["output_index"].as_u64().unwrap() as usize]["call_id"] =
                        json!(value);
                }
                if let Some(value) = call.pointer("/function/name").and_then(Value::as_str) {
                    current["name"] = json!(format!(
                        "{}{}",
                        current["name"].as_str().unwrap_or_default(),
                        value
                    ));
                    let index = current["output_index"].as_u64().unwrap() as usize;
                    output[index]["name"] = current["name"].clone();
                }
                if let Some(value) = call.pointer("/function/arguments").and_then(Value::as_str) {
                    current["arguments"] = json!(format!(
                        "{}{}",
                        current["arguments"].as_str().unwrap_or_default(),
                        value
                    ));
                    let index = current["output_index"].as_u64().unwrap() as usize;
                    output[index]["arguments"] = current["arguments"].clone();
                }
            }
        }
        if let Some(reason) = event
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
        {
            finish_reason = Some(reason.to_string());
        }
    }

    for item in &mut output {
        if item.get("type").and_then(Value::as_str) == Some("message") {
            item["status"] = json!("completed");
            item["content"][0]["text"] = json!(content);
        } else if item.get("type").and_then(Value::as_str) == Some("function_call") {
            item["status"] = json!("completed");
        }
    }
    for call in tool_calls.values() {
        let index = call["output_index"].as_u64().unwrap_or(0) as usize;
        let item_id = call.get("id").cloned().unwrap_or(Value::Null);
        let arguments = call.get("arguments").cloned().unwrap_or(json!(""));
        let mut added_item = output[index].clone();
        added_item["arguments"] = json!("");
        emit_event(
            stream,
            "response.output_item.added",
            &json!({"type":"response.output_item.added","output_index":index,"item":added_item}),
        )?;
        if let Some(arguments) = arguments.as_str().filter(|value| !value.is_empty()) {
            emit_event(
                stream,
                "response.function_call_arguments.delta",
                &json!({"type":"response.function_call_arguments.delta","item_id":item_id,"output_index":index,"delta":arguments}),
            )?;
        }
        emit_event(
            stream,
            "response.function_call_arguments.done",
            &json!({"type":"response.function_call_arguments.done","item_id":item_id,"output_index":index,"arguments":arguments}),
        )?;
        emit_event(
            stream,
            "response.output_item.done",
            &json!({"type":"response.output_item.done","output_index":index,"item":output[index]}),
        )?;
    }
    if let Some(index) = output
        .iter()
        .position(|item| item.get("type").and_then(Value::as_str) == Some("message"))
    {
        let item_id = output[index]["id"].clone();
        emit_event(
            stream,
            "response.output_text.done",
            &json!({"type":"response.output_text.done","item_id":item_id,"output_index":index,"content_index":0,"text":content}),
        )?;
        emit_event(
            stream,
            "response.content_part.done",
            &json!({"type":"response.content_part.done","item_id":item_id,"output_index":index,"content_index":0,"part":{"type":"output_text","text":content,"annotations":[]}}),
        )?;
        emit_event(
            stream,
            "response.output_item.done",
            &json!({"type":"response.output_item.done","output_index":index,"item":output[index]}),
        )?;
    }

    let input_tokens = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let finish = finish_reason
        .as_deref()
        .unwrap_or("stream_ended_without_finish_reason");
    let incomplete = !matches!(finish, "stop" | "tool_calls" | "function_call");
    let result = json!({"id":id,"object":"response","status":if incomplete {"incomplete"} else {"completed"},"incomplete_details":if incomplete {json!({"reason":finish})} else {Value::Null},"error":null,"model":model,"output":output,"output_text":content,"usage":{"input_tokens":input_tokens,"output_tokens":output_tokens,"total_tokens":input_tokens+output_tokens,"input_tokens_details":{"cached_tokens":usage.pointer("/prompt_tokens_details/cached_tokens").cloned().unwrap_or(json!(0))},"output_tokens_details":{"reasoning_tokens":usage.pointer("/completion_tokens_details/reasoning_tokens").cloned().unwrap_or(json!(0))}}});
    if incomplete {
        emit_event(
            stream,
            "response.incomplete",
            &json!({"type":"response.incomplete","response":result}),
        )?;
    } else {
        emit_event(
            stream,
            "response.completed",
            &json!({"type":"response.completed","response":result}),
        )?;
    }
    stream
        .write_all(b"0\r\n\r\n")
        .map_err(|error| error.to_string())
}

fn translate_anthropic_stream(
    mut response: Response,
    stream: &mut TcpStream,
) -> Result<(), String> {
    #[derive(Default)]
    struct ToolBlock {
        output_index: usize,
        item_id: String,
        arguments: String,
    }

    let fallback_id = format!("resp_{}", crate::unique_backup_label("gateway"));
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n").map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(&mut response);
    let mut line = String::new();
    let mut event_name = String::new();
    let mut data = String::new();
    let mut response_id = fallback_id;
    let mut model = Value::Null;
    let mut output = Vec::<Value>::new();
    let mut tools = std::collections::BTreeMap::<u64, ToolBlock>::new();
    let mut text = String::new();
    let mut text_output_index = None;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut stop_reason = String::new();
    let mut created = false;

    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            break;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event_name = value.trim().to_string();
            continue;
        }
        if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.trim());
            continue;
        }
        if !line.trim().is_empty() || data.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            data.clear();
            event_name.clear();
            continue;
        };
        data.clear();
        match event_name.as_str() {
            "message_start" => {
                if let Some(message) = event.get("message") {
                    response_id = message
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(&response_id)
                        .to_string();
                    model = message.get("model").cloned().unwrap_or(Value::Null);
                    input_tokens = message
                        .pointer("/usage/input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                }
                if !created {
                    let response_value = json!({"id":response_id,"object":"response","status":"in_progress","model":model,"output":[]});
                    emit_event(
                        stream,
                        "response.created",
                        &json!({"type":"response.created","response":response_value}),
                    )?;
                    emit_event(
                        stream,
                        "response.in_progress",
                        &json!({"type":"response.in_progress","response":response_value}),
                    )?;
                    created = true;
                }
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let block = event.get("content_block").cloned().unwrap_or(Value::Null);
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if text_output_index.is_none() {
                            let output_index = output.len();
                            let item = json!({"id":format!("msg_{response_id}"),"type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"","annotations":[]}]});
                            output.push(item.clone());
                            text_output_index = Some(output_index);
                            emit_event(
                                stream,
                                "response.output_item.added",
                                &json!({"type":"response.output_item.added","output_index":output_index,"item":item}),
                            )?;
                            emit_event(
                                stream,
                                "response.content_part.added",
                                &json!({"type":"response.content_part.added","item_id":item["id"],"output_index":output_index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                            )?;
                        }
                        if let Some(initial) = block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            text.push_str(initial);
                            emit_event(
                                stream,
                                "response.output_text.delta",
                                &json!({"type":"response.output_text.delta","item_id":format!("msg_{response_id}"),"output_index":text_output_index.unwrap_or(0),"content_index":0,"delta":initial}),
                            )?;
                        }
                    }
                    "tool_use" => {
                        let item_id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("call_signalman")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let output_index = output.len();
                        let item = json!({"id":item_id,"type":"function_call","call_id":item_id,"name":name,"arguments":"","status":"in_progress"});
                        output.push(item.clone());
                        tools.insert(
                            index,
                            ToolBlock {
                                output_index,
                                item_id: item_id.clone(),
                                arguments: String::new(),
                            },
                        );
                        emit_event(
                            stream,
                            "response.output_item.added",
                            &json!({"type":"response.output_item.added","output_index":output_index,"item":item}),
                        )?;
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        if text_output_index.is_none() {
                            let output_index = output.len();
                            let item = json!({"id":format!("msg_{response_id}"),"type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"","annotations":[]}]});
                            output.push(item.clone());
                            text_output_index = Some(output_index);
                            emit_event(
                                stream,
                                "response.output_item.added",
                                &json!({"type":"response.output_item.added","output_index":output_index,"item":item}),
                            )?;
                            emit_event(
                                stream,
                                "response.content_part.added",
                                &json!({"type":"response.content_part.added","item_id":item["id"],"output_index":output_index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                            )?;
                        }
                        if let Some(value) = delta.get("text").and_then(Value::as_str) {
                            text.push_str(value);
                            emit_event(
                                stream,
                                "response.output_text.delta",
                                &json!({"type":"response.output_text.delta","item_id":format!("msg_{response_id}"),"output_index":text_output_index.unwrap_or(0),"content_index":0,"delta":value}),
                            )?;
                        }
                    }
                    "input_json_delta" => {
                        if let Some(tool) = tools.get_mut(&index) {
                            if let Some(value) = delta.get("partial_json").and_then(Value::as_str) {
                                tool.arguments.push_str(value);
                                emit_event(
                                    stream,
                                    "response.function_call_arguments.delta",
                                    &json!({"type":"response.function_call_arguments.delta","item_id":tool.item_id,"output_index":tool.output_index,"delta":value}),
                                )?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(delta) = event.get("delta") {
                    stop_reason = delta
                        .get("stop_reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
                if let Some(usage) = event.get("usage") {
                    output_tokens = usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(output_tokens);
                }
            }
            _ => {}
        }
        event_name.clear();
    }

    for (index, item) in output.iter_mut().enumerate() {
        item["status"] = json!("completed");
        if item.get("type").and_then(Value::as_str) == Some("message") {
            item["content"][0]["text"] = json!(text);
            emit_event(
                stream,
                "response.output_text.done",
                &json!({"type":"response.output_text.done","item_id":item["id"],"output_index":index,"content_index":0,"text":text}),
            )?;
            emit_event(
                stream,
                "response.content_part.done",
                &json!({"type":"response.content_part.done","item_id":item["id"],"output_index":index,"content_index":0,"part":item["content"][0]}),
            )?;
        }
        emit_event(
            stream,
            "response.output_item.done",
            &json!({"type":"response.output_item.done","output_index":index,"item":item}),
        )?;
    }
    for tool in tools.values() {
        emit_event(
            stream,
            "response.function_call_arguments.done",
            &json!({"type":"response.function_call_arguments.done","item_id":tool.item_id,"output_index":tool.output_index,"arguments":tool.arguments}),
        )?;
    }
    let incomplete = stop_reason == "max_tokens";
    let result = json!({"id":response_id,"object":"response","status":if incomplete {"incomplete"} else {"completed"},"incomplete_details":if incomplete {json!({"reason":"max_output_tokens"})} else {Value::Null},"error":null,"model":model,"output":output,"output_text":text,"usage":{"input_tokens":input_tokens,"output_tokens":output_tokens,"total_tokens":input_tokens+output_tokens,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}});
    let event_name = if incomplete {
        "response.incomplete"
    } else {
        "response.completed"
    };
    emit_event(
        stream,
        event_name,
        &json!({"type":event_name,"response":result}),
    )?;
    stream
        .write_all(b"0\r\n\r\n")
        .map_err(|error| error.to_string())
}

fn emit_event(stream: &mut TcpStream, name: &str, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let event = format!(
        "event: {name}\ndata: {}\n\n",
        String::from_utf8_lossy(&body)
    )
    .into_bytes();
    let header = format!("{:X}\r\n", event.len());
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&event))
        .and_then(|_| stream.write_all(b"\r\n"))
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        anthropic_response_to_responses, chat_response_to_responses, read_chunked_body,
        responses_request_to_anthropic, responses_request_to_chat, translate_anthropic_stream,
        translate_stream,
    };
    use reqwest::blocking::Client;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Cursor, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    #[test]
    fn converts_responses_messages_tools_images_and_stream_options() {
        let request = json!({"model":"deepseek-chat","instructions":"be concise","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"},{"type":"input_image","image_data":"aGVsbG8=","mime_type":"image/jpeg"}]},{"type":"function_call_output","call_id":"call_1","output":{"ok":true}}],"tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}],"tool_choice":{"type":"function","name":"lookup"},"stream":true,"max_output_tokens":42,"reasoning":{"effort":"low"}});
        let converted = responses_request_to_chat(&request).unwrap();
        assert_eq!(converted["model"], "deepseek-chat");
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(converted["messages"][1]["content"][0]["text"], "hello");
        assert_eq!(
            converted["messages"][1]["content"][1]["image_url"]["url"],
            "data:image/jpeg;base64,aGVsbG8="
        );
        assert_eq!(converted["messages"][2]["role"], "tool");
        assert_eq!(converted["stream"], true);
        assert_eq!(converted["stream_options"]["include_usage"], true);
        assert_eq!(converted["max_tokens"], 42);
        assert_eq!(converted["reasoning_effort"], "low");
        assert_eq!(converted["tool_choice"]["function"]["name"], "lookup");
        assert_eq!(converted["tools"][0]["function"]["name"], "lookup");
    }

    #[test]
    fn rejects_stateful_or_unmapped_responses_requests() {
        assert!(responses_request_to_chat(
            &json!({"model":"m","input":"x","previous_response_id":"resp_1"})
        )
        .unwrap_err()
        .contains("跨轮"));
        assert!(responses_request_to_chat(
            &json!({"model":"m","input":[{"type":"reasoning","summary":[]}]})
        )
        .unwrap_err()
        .contains("不支持"));
    }

    #[test]
    fn converts_chat_completion_text_and_tool_calls_back_to_responses() {
        let response = json!({"id":"chatcmpl_1","model":"deepseek-chat","choices":[{"finish_reason":"tool_calls","message":{"content":"hi","tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}],"usage":{"prompt_tokens":2,"completion_tokens":3}});
        let converted = chat_response_to_responses(&response).unwrap();
        assert_eq!(converted["output"][0]["content"][0]["text"], "hi");
        assert_eq!(converted["output"][1]["type"], "function_call");
        assert_eq!(converted["usage"]["total_tokens"], 5);
    }

    #[test]
    fn converts_responses_input_to_anthropic_messages_and_tools() {
        let request = json!({
            "model":"claude-sonnet",
            "instructions":"Be concise",
            "input":[
                {"type":"message","role":"user","content":[{"type":"input_text","text":"look up"},{"type":"input_image","image_url":"https://example.test/image.png"}]},
                {"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\"q\":\"x\"}"},
                {"type":"function_call_output","call_id":"call_1","output":{"ok":true}}
            ],
            "tools":[{"type":"function","name":"lookup","description":"Search","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}],
            "tool_choice":{"type":"function","name":"lookup"},
            "max_output_tokens":128,
            "stream":true
        });
        let converted = responses_request_to_anthropic(&request).unwrap();
        assert_eq!(converted["model"], "claude-sonnet");
        assert_eq!(converted["system"], "Be concise");
        assert_eq!(converted["max_tokens"], 128);
        assert_eq!(
            converted["messages"][0]["content"][1]["source"]["type"],
            "url"
        );
        assert_eq!(converted["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(
            converted["messages"][2]["content"][0]["tool_use_id"],
            "call_1"
        );
        assert_eq!(converted["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(converted["tool_choice"]["type"], "tool");
    }

    #[test]
    fn anthropic_none_tool_choice_omits_tools_to_prevent_tool_use() {
        let converted = responses_request_to_anthropic(&json!({
            "model":"claude-sonnet",
            "input":"answer without tools",
            "tools":[{"type":"function","name":"dangerous_action","parameters":{"type":"object"}}],
            "tool_choice":{"type":"none"}
        }))
        .unwrap();

        assert!(converted.get("tools").is_none());
        assert!(converted.get("tool_choice").is_none());
    }

    #[test]
    fn converts_anthropic_json_text_tools_and_usage_to_responses() {
        let converted = anthropic_response_to_responses(&json!({
            "id":"msg_1","model":"claude-sonnet","stop_reason":"tool_use",
            "content":[{"type":"text","text":"Searching"},{"type":"tool_use","id":"call_1","name":"lookup","input":{"q":"x"}}],
            "usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":3}
        })).unwrap();
        assert_eq!(converted["output_text"], "Searching");
        assert_eq!(converted["output"][1]["type"], "function_call");
        assert_eq!(converted["output"][1]["arguments"], "{\"q\":\"x\"}");
        assert_eq!(converted["usage"]["total_tokens"], 14);
        assert_eq!(
            converted["usage"]["input_tokens_details"]["cached_tokens"],
            3
        );
    }

    #[test]
    fn decodes_chunked_http_request_body() {
        let bytes = b"4\r\ntest\r\n6\r\n hello\r\n0\r\n\r\n";
        assert_eq!(
            read_chunked_body(&mut BufReader::new(Cursor::new(bytes))).unwrap(),
            b"test hello"
        );
    }

    #[test]
    fn translates_stream_with_final_output_and_usage() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let upstream_body = concat!(
            "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n",
            "data: [DONE]\n\n"
        );
        let upstream_server = thread::spawn(move || {
            let (mut socket, _) = upstream.accept().unwrap();
            let mut request = BufReader::new(socket.try_clone().unwrap());
            let mut line = String::new();
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{upstream_body}", upstream_body.len()).unwrap();
        });
        let response = Client::new()
            .get(format!("http://{upstream_address}/stream"))
            .send()
            .unwrap();
        upstream_server.join().unwrap();
        let downstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let downstream_address = downstream.local_addr().unwrap();
        let translate = thread::spawn(move || {
            let (mut socket, _) = downstream.accept().unwrap();
            translate_stream(response, &mut socket).unwrap();
        });
        let mut received = String::new();
        TcpStream::connect(downstream_address)
            .unwrap()
            .read_to_string(&mut received)
            .unwrap();
        translate.join().unwrap();
        assert!(received.contains("event: response.output_text.delta"));
        assert!(received.contains("event: response.completed"));
        assert!(received.contains("\"text\":\"hello\""));
        assert!(received.contains("\"total_tokens\":3"));
    }

    #[test]
    fn translates_anthropic_sse_to_responses_completion_events() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let upstream_body = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-sonnet\",\"usage\":{\"input_tokens\":2}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        );
        let upstream_server = thread::spawn(move || {
            let (mut socket, _) = upstream.accept().unwrap();
            let mut request = BufReader::new(socket.try_clone().unwrap());
            let mut line = String::new();
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{upstream_body}", upstream_body.len()).unwrap();
        });
        let response = Client::new()
            .get(format!("http://{upstream_address}/stream"))
            .send()
            .unwrap();
        upstream_server.join().unwrap();
        let downstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let downstream_address = downstream.local_addr().unwrap();
        let translate = thread::spawn(move || {
            let (mut socket, _) = downstream.accept().unwrap();
            translate_anthropic_stream(response, &mut socket).unwrap();
        });
        let mut received = String::new();
        TcpStream::connect(downstream_address)
            .unwrap()
            .read_to_string(&mut received)
            .unwrap();
        translate.join().unwrap();
        assert!(received.contains("event: response.output_text.delta"));
        assert!(received.contains("event: response.completed"));
        assert!(received.contains("\"text\":\"hello\""));
        assert!(received.contains("\"total_tokens\":3"));
    }
}
