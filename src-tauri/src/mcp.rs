use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPublic {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub url: String,
    pub header_keys: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPublic {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    pub description: String,
    pub schema: Value,
    pub read_only: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOffer {
    pub pending_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallOutcome {
    pub text: String,
    pub is_error: bool,
    pub offer: Option<ConnectOffer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretField {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub id: Option<String>,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<SecretField>,
    pub url: String,
    pub headers: Vec<SecretField>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SavedSecret {
    key: String,
    secret_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct SavedServer {
    id: String,
    name: String,
    transport: String,
    command: String,
    args: Vec<String>,
    env: Vec<SavedSecret>,
    url: String,
    headers: Vec<SavedSecret>,
}

#[derive(Default, Serialize, Deserialize)]
struct Disk {
    servers: Vec<SavedServer>,
}

pub fn list_servers() -> Vec<ServerPublic> {
    load().servers.into_iter().map(public_server).collect()
}

pub fn save_server(input: ServerInput) -> Result<ServerPublic, String> {
    let mut disk = load();
    let id = input.id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| format!("mcp{}", crate::sftpnav::fresh_id()));
    let previous = disk.servers.iter().find(|server| server.id == id).cloned();
    let transport = if input.transport == "http" { "http" } else { "stdio" };
    if transport == "stdio" && input.command.trim().is_empty() {
        return Err("Enter the command to run.".into());
    }
    if transport == "http" && input.url.trim().is_empty() {
        return Err("Enter the server URL.".into());
    }
    let env = store_fields(&id, "env", &input.env, previous.as_ref().map(|server| server.env.as_slice()).unwrap_or(&[]))?;
    let headers = store_fields(&id, "header", &input.headers, previous.as_ref().map(|server| server.headers.as_slice()).unwrap_or(&[]))?;
    let saved = SavedServer {
        id: id.clone(),
        name: if input.name.trim().is_empty() { "MCP server".into() } else { input.name.trim().to_string() },
        transport: transport.into(),
        command: input.command.trim().to_string(),
        args: input.args,
        env,
        url: input.url.trim().to_string(),
        headers,
    };
    if let Some(slot) = disk.servers.iter_mut().find(|server| server.id == id) {
        *slot = saved.clone();
    } else {
        disk.servers.push(saved.clone());
    }
    save(&disk)?;
    Ok(public_server(saved))
}

pub fn delete_server(id: &str) -> Result<(), String> {
    let mut disk = load();
    if let Some(server) = disk.servers.iter().find(|server| server.id == id).cloned() {
        for item in server.env.iter().chain(server.headers.iter()) {
            crate::secrets::delete(&item.secret_id);
        }
    }
    disk.servers.retain(|server| server.id != id);
    save(&disk)
}

pub fn list_tools(server_id: &str) -> Result<Vec<ToolPublic>, String> {
    let server = find(server_id)?;
    let result = with_session(&server, |session| session.request("tools/list", json!({})))?;
    let tools = result.get("tools").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    Ok(tools.into_iter().filter_map(|tool| tool_public(&server, &tool)).collect())
}

pub fn call_tool(server_id: &str, name: &str, arguments: Value) -> Result<CallOutcome, String> {
    let server = find(server_id)?;
    let result = with_session(&server, |session| session.request("tools/call", json!({ "name": name, "arguments": arguments })))?;
    let is_error = result.get("isError").and_then(|value| value.as_bool()).unwrap_or(false);
    let mut texts = Vec::new();
    if let Some(content) = result.get("content").and_then(|value| value.as_array()) {
        for block in content {
            if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                texts.push(text.to_string());
            }
        }
    }
    let mut offer = None;
    for text in &texts {
        if let Some(found) = json_connect(text) {
            offer = Some(found);
            break;
        }
    }
    if offer.is_none() {
        if let Some(found) = result.get("structuredContent").and_then(value_connect) {
            offer = Some(found);
        }
    }
    let shown = texts.into_iter().map(|text| redact_text(&text)).collect::<Vec<_>>().join("\n");
    let text = if shown.is_empty() { "The tool finished without any text.".into() } else { shown };
    Ok(CallOutcome { text, is_error, offer })
}

fn json_connect(text: &str) -> Option<ConnectOffer> {
    let found = found_from_text(text)?;
    let pending_id = crate::sftpnav::stash_secret(found.password, found.private_key, found.passphrase).ok()?;
    Some(ConnectOffer { pending_id, host: found.host, port: found.port, username: found.username, remote_path: found.remote_path })
}

fn found_from_text(text: &str) -> Option<FoundConnect> {
    let value: Value = serde_json::from_str(text).ok()?;
    let mut found = None;
    walk(&value, &mut found);
    found
}

fn value_connect(value: &Value) -> Option<ConnectOffer> {
    let mut found = None;
    walk(value, &mut found);
    let found = found?;
    let pending_id = crate::sftpnav::stash_secret(found.password, found.private_key, found.passphrase).ok()?;
    Some(ConnectOffer { pending_id, host: found.host, port: found.port, username: found.username, remote_path: found.remote_path })
}

struct FoundConnect {
    host: String,
    port: u16,
    username: String,
    remote_path: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
}

fn walk(value: &Value, found: &mut Option<FoundConnect>) {
    if found.is_some() {
        return;
    }
    match value {
        Value::Object(map) => {
            if let Some(hit) = as_connect(map) {
                *found = Some(hit);
                return;
            }
            for child in map.values() {
                walk(child, found);
            }
        }
        Value::Array(items) => {
            for child in items {
                walk(child, found);
            }
        }
        _ => {}
    }
}

fn as_connect(map: &serde_json::Map<String, Value>) -> Option<FoundConnect> {
    let protocol = string_field(map, &["protocol"])?;
    if !protocol.eq_ignore_ascii_case("sftp") {
        return None;
    }
    let host = string_field(map, &["host"])?;
    let username = string_field(map, &["username", "user"])?;
    let password = string_field(map, &["password"]);
    let private_key = string_field(map, &["privateKey", "private_key"]);
    if password.is_none() && private_key.is_none() {
        return None;
    }
    let port = map.get("port").and_then(|value| value.as_u64().map(|port| port as u16).or_else(|| value.as_str().and_then(|text| text.parse().ok()))).unwrap_or(22);
    let remote_path = string_field(map, &["remotePath", "remote_path"]).unwrap_or_else(|| "/".into());
    Some(FoundConnect {
        host,
        port,
        username,
        remote_path,
        password,
        private_key,
        passphrase: string_field(map, &["passphrase"]),
    })
}

fn string_field(map: &serde_json::Map<String, Value>, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(value) = map.get(*name).and_then(|value| value.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn redact_text(text: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(text) else { return text.to_string() };
    redact(&mut value);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| text.to_string())
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                let secret = matches!(key.to_ascii_lowercase().as_str(), "password" | "private_key" | "privatekey" | "passphrase" | "secret");
                if let Some(child) = map.get_mut(&key) {
                    if secret && !child.is_null() {
                        *child = Value::String("••••".into());
                    } else {
                        redact(child);
                    }
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

trait Session {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String>;
}

fn with_session<T>(server: &SavedServer, run: impl FnOnce(&mut dyn Session) -> Result<T, String>) -> Result<T, String> {
    if server.transport == "http" {
        let mut session = HttpSession::open(server)?;
        run(&mut session)
    } else {
        let mut session = StdioSession::open(server)?;
        run(&mut session)
    }
}

struct StdioSession {
    child: std::process::Child,
    incoming: std::sync::mpsc::Receiver<Result<Value, String>>,
}

impl StdioSession {
    fn open(server: &SavedServer) -> Result<Self, String> {
        let mut command = Command::new(&server.command);
        command.args(&server.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        for item in &server.env {
            if let Ok(value) = crate::secrets::get(&item.secret_id) {
                command.env(&item.key, value);
            }
        }
        let mut child = command.spawn().map_err(|_| format!("Can't run {}.", server.command))?;
        let stdout = child.stdout.take().ok_or_else(|| "The MCP server has no output.".to_string())?;
        let (tx, incoming) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_frame(&mut reader) {
                    Ok(value) => {
                        if tx.send(Ok(value)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Err("The MCP server closed.".into()));
                        break;
                    }
                }
            }
        });
        let mut session = StdioSession { child, incoming };
        session.request("initialize", json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "FilePad", "version": "0.1.0" }
        }))?;
        session.notify("notifications/initialized", json!({}))?;
        Ok(session)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        write_frame(self.child.stdin.as_mut().ok_or_else(|| "The MCP server has no input.".to_string())?, &message)
    }
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

impl Session for StdioSession {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = 1;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        write_frame(self.child.stdin.as_mut().ok_or_else(|| "The MCP server has no input.".to_string())?, &message)?;
        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("The MCP server timed out.".into());
            }
            let value = self.incoming.recv_timeout(remaining).map_err(|_| "The MCP server timed out.".to_string())??;
            if value.get("id").and_then(|value| value.as_i64()) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                let message = error.get("message").and_then(|value| value.as_str()).unwrap_or("The MCP server returned an error.");
                return Err(message.to_string());
            }
            return value.get("result").cloned().ok_or_else(|| "The MCP server sent no result.".to_string());
        }
    }
}

struct HttpSession {
    url: String,
    headers: Vec<(String, String)>,
    session: Option<String>,
}

impl HttpSession {
    fn open(server: &SavedServer) -> Result<Self, String> {
        let mut headers = Vec::new();
        for item in &server.headers {
            if let Ok(value) = crate::secrets::get(&item.secret_id) {
                headers.push((item.key.clone(), value));
            }
        }
        let mut session = HttpSession { url: server.url.clone(), headers, session: None };
        session.request("initialize", json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "FilePad", "version": "0.1.0" }
        }))?;
        session.notify("notifications/initialized")?;
        Ok(session)
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let body = json!({ "jsonrpc": "2.0", "method": method }).to_string();
        let _ = self.post(&body)?;
        Ok(())
    }

    fn post(&mut self, body: &str) -> Result<Value, String> {
        let mut request = ureq::post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session);
        }
        for (key, value) in &self.headers {
            request = request.header(key, value);
        }
        let mut response = request.send(body).map_err(|_| "Can't reach the MCP server.".to_string())?;
        if let Some(session) = response.headers().get("mcp-session-id").and_then(|value| value.to_str().ok()) {
            self.session = Some(session.to_string());
        }
        let status = response.status();
        let text = response.body_mut().read_to_string().map_err(|_| "Can't read the MCP server.".to_string())?;
        if !status.is_success() {
            return Err(format!("The MCP server returned {status}."));
        }
        parse_body(&text)
    }
}

impl Session for HttpSession {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let value = self.post(&body)?;
        if let Some(error) = value.get("error") {
            let message = error.get("message").and_then(|item| item.as_str()).unwrap_or("The MCP server returned an error.");
            return Err(message.to_string());
        }
        value.get("result").cloned().ok_or_else(|| "The MCP server sent no result.".to_string())
    }
}

fn parse_body(body: &str) -> Result<Value, String> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).map_err(|_| "The MCP server sent something that isn't JSON.".to_string());
    }
    for line in trimmed.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if value.get("id").is_some() || value.get("result").is_some() || value.get("error").is_some() {
                return Ok(value);
            }
        }
    }
    Err("The MCP server sent an empty response.".into())
}

fn write_frame(writer: &mut dyn Write, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|_| "Can't write the MCP message.".to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|_| "Can't write to the MCP server.".to_string())?;
    writer.write_all(&body).map_err(|_| "Can't write to the MCP server.".to_string())?;
    writer.flush().map_err(|_| "Can't write to the MCP server.".to_string())
}

fn read_frame(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut length = None;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|_| "Can't read the MCP server.".to_string())?;
        if read == 0 {
            return Err("The MCP server closed.".into());
        }
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = rest.trim().parse::<usize>().ok();
        }
    }
    let length = length.ok_or_else(|| "The MCP server sent an incomplete message.".to_string())?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|_| "Can't read the MCP server.".to_string())?;
    serde_json::from_slice(&body).map_err(|_| "The MCP server sent something that isn't JSON.".to_string())
}

fn tool_public(server: &SavedServer, tool: &Value) -> Option<ToolPublic> {
    let name = tool.get("name")?.as_str()?.to_string();
    let description = tool.get("description").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let schema = tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    let read_only = tool.get("annotations").and_then(|value| value.get("readOnlyHint")).and_then(|value| value.as_bool()).unwrap_or(false);
    Some(ToolPublic { server_id: server.id.clone(), server_name: server.name.clone(), name, description, schema, read_only })
}

fn store_fields(server_id: &str, kind: &str, fields: &[SecretField], previous: &[SavedSecret]) -> Result<Vec<SavedSecret>, String> {
    let mut kept = Vec::new();
    for field in fields {
        let key = field.key.trim();
        if key.is_empty() {
            continue;
        }
        let secret_id = previous.iter().find(|item| item.key == key).map(|item| item.secret_id.clone()).unwrap_or_else(|| format!("{server_id}-{kind}-{key}"));
        if let Some(value) = field.value.as_ref() {
            if value.is_empty() {
                crate::secrets::delete(&secret_id);
                continue;
            }
            crate::secrets::put(&secret_id, value)?;
        } else if !previous.iter().any(|item| item.key == key) {
            continue;
        }
        kept.push(SavedSecret { key: key.to_string(), secret_id });
    }
    for item in previous {
        if !kept.iter().any(|kept| kept.key == item.key) {
            crate::secrets::delete(&item.secret_id);
        }
    }
    Ok(kept)
}

fn find(id: &str) -> Result<SavedServer, String> {
    load().servers.into_iter().find(|server| server.id == id).ok_or_else(|| "That MCP server is gone.".to_string())
}

fn public_server(server: SavedServer) -> ServerPublic {
    ServerPublic {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env_keys: server.env.into_iter().map(|item| item.key).collect(),
        url: server.url,
        header_keys: server.headers.into_iter().map(|item| item.key).collect(),
    }
}

fn disk_path() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME")).map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = base.join("FilePad");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("mcp-servers.json")
}

fn load() -> Disk {
    std::fs::read(disk_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save(disk: &Disk) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(disk).map_err(|_| "Can't save the MCP servers.".to_string())?;
    std::fs::write(disk_path(), bytes).map_err(|_| "Can't save the MCP servers.".to_string())
}

#[cfg(test)]
mod tests {
    use super::found_from_text;

    #[test]
    fn connection_object_is_detected_without_storing_it() {
        let text = r#"{"username":"site","password":"secret","host":"203.0.113.10","port":22,"remote_path":"/var/www","protocol":"sftp"}"#;
        let found = found_from_text(text).expect("sftp object");
        assert_eq!(found.host, "203.0.113.10");
        assert_eq!(found.remote_path, "/var/www");
        assert!(found_from_text(r#"{"username":"a","password":"b","host":"mail"}"#).is_none());
    }
}
