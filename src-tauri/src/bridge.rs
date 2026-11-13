use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::sftpnav::{self, OpenRequest};

struct Wait {
    tx: mpsc::Sender<Result<Value, String>>,
}

fn waiters() -> &'static Mutex<HashMap<String, Wait>> {
    static WAITERS: OnceLock<Mutex<HashMap<String, Wait>>> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(_) => return,
        };
        let Ok(address) = listener.local_addr() else { return };
        let token = sftpnav::fresh_id();
        if write_ticket(address.port(), &token).is_err() {
            return;
        }
        for stream in listener.incoming().flatten() {
            let _ = handle(stream, &token, &app);
        }
    });
}

pub fn reply(id: &str, ok: bool, result: Option<Value>, error: Option<String>) {
    let Some(wait) = waiters().lock().ok().and_then(|mut waiters| waiters.remove(id)) else { return };
    let message = if ok { Ok(result.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_else(|| "That didn't work.".into())) };
    let _ = wait.tx.send(message);
}

pub fn mcp_stdio() {
    let stdin = std::io::stdin();
    let mut reader = std::io::BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout();
    loop {
        let Ok(message) = read_frame(&mut reader) else { break };
        if message.get("method").and_then(|value| value.as_str()) == Some("notifications/initialized") {
            continue;
        }
        let Some(id) = message.get("id").cloned() else { continue };
        let method = message.get("method").and_then(|value| value.as_str()).unwrap_or("");
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "FilePad", "version": "2.0.0" }
            })),
            "tools/list" => Ok(json!({ "tools": tool_list() })),
            "ping" => Ok(json!({})),
            "tools/call" => {
                let params = message.get("params").cloned().unwrap_or(json!({}));
                let name = params.get("name").and_then(|value| value.as_str()).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                match forward(name, arguments) {
                    Ok(value) => Ok(json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false })),
                    Err(err) => Ok(json!({ "content": [{ "type": "text", "text": err }], "isError": true })),
                }
            }
            _ => Err("FilePad doesn't know that method.".to_string()),
        };
        let response = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } }),
        };
        if write_frame(&mut stdout, &response).is_err() {
            break;
        }
    }
}

fn tool_list() -> Value {
    json!([
        { "name": "get_state", "description": "Pane paths, selection, and saved SFTP profiles. No secrets.", "inputSchema": { "type": "object", "properties": {} }, "annotations": { "readOnlyHint": true } },
        { "name": "navigate", "description": "Open a path on the left or right pane.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" }, "path": { "type": "string" } }, "required": ["side", "path"] } },
        { "name": "list_dir", "description": "List the folder open on a pane.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" } }, "required": ["side"] }, "annotations": { "readOnlyHint": true } },
        { "name": "connect_sftp", "description": "Connect a pane over SFTP. Pass the host key fingerprint to pin it.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" }, "host": { "type": "string" }, "port": { "type": "number" }, "username": { "type": "string" }, "password": { "type": "string" }, "privateKey": { "type": "string" }, "passphrase": { "type": "string" }, "remotePath": { "type": "string" }, "fingerprint": { "type": "string" }, "profileId": { "type": "string" } }, "required": ["host", "username"] } },
        { "name": "disconnect", "description": "Close the SFTP session on a pane and return to the last local folder.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" } }, "required": ["side"] } },
        { "name": "copy_to_other", "description": "Copy the selection to the other pane.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" } } } },
        { "name": "move_to_other", "description": "Move the selection to the other pane.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" } } } },
        { "name": "mkdir", "description": "Create a folder on a pane.", "inputSchema": { "type": "object", "properties": { "side": { "type": "string" }, "name": { "type": "string" } }, "required": ["name"] } },
        { "name": "rename", "description": "Rename a file or folder.", "inputSchema": { "type": "object", "properties": { "path": { "type": "string" }, "name": { "type": "string" } }, "required": ["path", "name"] } },
        { "name": "delete", "description": "Delete paths. confirm must be true.", "inputSchema": { "type": "object", "properties": { "paths": { "type": "array", "items": { "type": "string" } }, "confirm": { "type": "boolean" } }, "required": ["paths", "confirm"] } }
    ])
}

fn forward(name: &str, arguments: Value) -> Result<Value, String> {
    ui_call(name, arguments)
}

fn connect_sftp(app: &AppHandle, arguments: Value) -> Result<Value, String> {
    let request = OpenRequest {
        profile_id: arguments.get("profileId").and_then(|value| value.as_str()).map(|value| value.to_string()),
        label: arguments.get("label").and_then(|value| value.as_str()).map(|value| value.to_string()),
        host: arguments.get("host").and_then(|value| value.as_str()).map(|value| value.to_string()),
        port: arguments.get("port").and_then(|value| value.as_u64()).map(|value| value as u16),
        username: arguments.get("username").and_then(|value| value.as_str()).map(|value| value.to_string()),
        password: arguments.get("password").and_then(|value| value.as_str()).map(|value| value.to_string()),
        private_key: arguments.get("privateKey").or_else(|| arguments.get("private_key")).and_then(|value| value.as_str()).map(|value| value.to_string()),
        passphrase: arguments.get("passphrase").and_then(|value| value.as_str()).map(|value| value.to_string()),
        remote_path: arguments.get("remotePath").or_else(|| arguments.get("remote_path")).and_then(|value| value.as_str()).map(|value| value.to_string()),
        accept_fingerprint: arguments.get("fingerprint").and_then(|value| value.as_str()).map(|value| value.to_string()),
        pending_id: None,
        replace_pin: false,
    };
    let opened = sftpnav::open(request)?;
    if opened.status == "ready" {
        if let Some(path) = &opened.path {
            let side = arguments.get("side").and_then(|value| value.as_str()).unwrap_or("left");
            let _ = ask_window(app, "navigate", json!({ "side": side, "path": path }));
        }
    }
    serde_json::to_value(&opened).map_err(|_| "Can't describe that connection.".to_string())
}

fn ui_call(name: &str, arguments: Value) -> Result<Value, String> {
    let ticket = read_ticket()?;
    let body = json!({ "name": name, "arguments": arguments }).to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", ticket.port)).map_err(|_| "Open the FilePad window first.".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let request = format!(
        "POST /call HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        ticket.token,
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|_| "Open the FilePad window first.".to_string())?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|_| "The FilePad window didn't answer.".to_string())?;
    let payload = response.split("\r\n\r\n").nth(1).unwrap_or("");
    let value: Value = serde_json::from_str(payload).map_err(|_| "The FilePad window sent an unreadable answer.".to_string())?;
    if value.get("ok").and_then(|item| item.as_bool()) == Some(true) {
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(value.get("error").and_then(|item| item.as_str()).unwrap_or("That didn't work.").to_string())
    }
}

fn handle(mut stream: TcpStream, token: &str, app: &AppHandle) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end;
    loop {
        let read = stream.read(&mut chunk).map_err(|_| "Bad request.".to_string())?;
        if read == 0 {
            return Err("Bad request.".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return Err("Bad request.".into());
        }
    }
    let header = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    if !header.lines().next().unwrap_or("").starts_with("POST /call ") {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return Ok(());
    }
    let allowed = header.lines().any(|line| {
        let line = line.trim();
        line.len() > 22 && line[..22].eq_ignore_ascii_case("authorization: bearer ") && line[22..].trim() == token
    });
    if !allowed {
        let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return Ok(());
    }
    let length = header.lines().find_map(|line| {
        let line = line.trim();
        line.get(..15).filter(|prefix| prefix.eq_ignore_ascii_case("content-length:")).and_then(|_| line[15..].trim().parse::<usize>().ok())
    }).unwrap_or(0);
    while buffer.len() < header_end + length {
        let read = stream.read(&mut chunk).map_err(|_| "Bad request.".to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = buffer.get(header_end..header_end + length).unwrap_or(&[]);
    let request: Value = serde_json::from_slice(body).unwrap_or(json!({}));
    let name = request.get("name").and_then(|value| value.as_str()).unwrap_or("");
    let arguments = request.get("arguments").cloned().unwrap_or(json!({}));
    let result = if name == "connect_sftp" {
        connect_sftp(app, arguments)
    } else if name == "delete" && arguments.get("confirm").and_then(|value| value.as_bool()) != Some(true) {
        Err("Delete needs confirm: true.".into())
    } else {
        ask_window(app, name, arguments)
    };
    let payload = match result {
        Ok(result) => json!({ "ok": true, "result": result }).to_string(),
        Err(error) => json!({ "ok": false, "error": error }).to_string(),
    };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
    let _ = stream.write_all(response.as_bytes());
    Ok(())
}

fn ask_window(app: &AppHandle, name: &str, arguments: Value) -> Result<Value, String> {
    let id = sftpnav::fresh_id();
    let (tx, rx) = mpsc::channel();
    if let Ok(mut waiters) = waiters().lock() {
        waiters.insert(id.clone(), Wait { tx });
    }
    app.emit("bridge-request", json!({ "id": id, "name": name, "arguments": arguments })).map_err(|_| "The FilePad window isn't open.".to_string())?;
    rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "The FilePad window didn't answer.".to_string())?
}

struct Ticket {
    port: u16,
    token: String,
}

fn ticket_path() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME")).map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = base.join("FilePad");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("bridge.json")
}

fn write_ticket(port: u16, token: &str) -> Result<(), String> {
    let path = ticket_path();
    let body = json!({ "port": port, "token": token }).to_string();
    std::fs::write(&path, body).map_err(|_| "Can't write the bridge ticket.".to_string())?;
    lock_ticket(&path);
    Ok(())
}

fn read_ticket() -> Result<Ticket, String> {
    let bytes = std::fs::read(ticket_path()).map_err(|_| "Open the FilePad window first.".to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Open the FilePad window first.".to_string())?;
    let port = value.get("port").and_then(|item| item.as_u64()).ok_or_else(|| "Open the FilePad window first.".to_string())? as u16;
    let token = value.get("token").and_then(|item| item.as_str()).unwrap_or("").to_string();
    if token.is_empty() {
        return Err("Open the FilePad window first.".into());
    }
    Ok(Ticket { port, token })
}

fn lock_ticket(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_default();
        if user.is_empty() {
            return;
        }
        let _ = std::process::Command::new("icacls").arg(path).arg("/inheritance:r").arg(format!("/grant:r")).arg(format!("{user}:(R,W)")).output();
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
}

fn write_frame(writer: &mut dyn Write, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|_| "Can't write.".to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|_| "Can't write.".to_string())?;
    writer.write_all(&body).map_err(|_| "Can't write.".to_string())?;
    writer.flush().map_err(|_| "Can't write.".to_string())
}

fn read_frame(reader: &mut impl std::io::BufRead) -> Result<Value, String> {
    let mut length = None;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|_| "Closed.".to_string())?;
        if read == 0 {
            return Err("Closed.".into());
        }
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = rest.trim().parse::<usize>().ok();
        }
    }
    let length = length.ok_or_else(|| "Incomplete.".to_string())?;
    let mut body = vec![0u8; length];
    std::io::Read::read_exact(reader, &mut body).map_err(|_| "Closed.".to_string())?;
    serde_json::from_slice(&body).map_err(|_| "Not JSON.".to_string())
}
