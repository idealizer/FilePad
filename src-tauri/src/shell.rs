use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CmdChunk {
    id: String,
    text: String,
    done: bool,
    code: Option<i32>,
}

pub struct ShellState {
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<std::process::Child>>>>>,
    pty_writer: Mutex<Option<Box<dyn Write + Send>>>,
    pty_master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pty_child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            pty_writer: Mutex::new(None),
            pty_master: Mutex::new(None),
            pty_child: Mutex::new(None),
        }
    }
}

pub fn run_command(app: AppHandle, state: &ShellState, id: String, cwd: String, command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Enter a command.".into());
    }
    let mut child = command_in(&cwd, &command)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(Mutex::new(child));
    state.jobs.lock().map_err(|err| err.to_string())?.insert(id.clone(), shared.clone());
    let jobs = state.jobs.clone();
    std::thread::spawn(move || {
        let mut readers = Vec::new();
        if let Some(pipe) = stdout {
            readers.push(pump(app.clone(), id.clone(), pipe));
        }
        if let Some(pipe) = stderr {
            readers.push(pump(app.clone(), id.clone(), pipe));
        }
        let code = loop {
            let finished = {
                let mut child = match shared.lock() {
                    Ok(child) => child,
                    Err(_) => break None,
                };
                match child.try_wait() {
                    Ok(Some(status)) => Some(status.code()),
                    Ok(None) => None,
                    Err(_) => Some(None),
                }
            };
            if let Some(code) = finished {
                break code;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        };
        for reader in readers {
            let _ = reader.join();
        }
        if let Ok(mut jobs) = jobs.lock() {
            jobs.remove(&id);
        }
        let _ = app.emit("cmd-output", CmdChunk { id, text: String::new(), done: true, code });
    });
    Ok(())
}

pub fn cancel_command(state: &ShellState, id: &str) -> Result<(), String> {
    let jobs = state.jobs.lock().map_err(|err| err.to_string())?;
    let Some(child) = jobs.get(id) else { return Ok(()) };
    let mut child = child.lock().map_err(|err| err.to_string())?;
    let _ = child.kill();
    Ok(())
}

pub fn terminal_open(app: AppHandle, state: &ShellState, cwd: String, cols: u16, rows: u16) -> Result<(), String> {
    if state.pty_child.lock().map_err(|err| err.to_string())?.is_some() {
        return Ok(());
    }
    let system = native_pty_system();
    let pair = system
        .openpty(PtySize { rows: rows.max(8), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
        .map_err(|err| format!("Can't open a terminal: {err}"))?;
    let mut command = CommandBuilder::new(shell_program());
    for arg in shell_args() {
        command.arg(arg);
    }
    if !cwd.trim().is_empty() {
        command.cwd(cwd);
    }
    let child = pair.slave.spawn_command(command).map_err(|err| format!("Can't start the shell: {err}"))?;
    let mut reader = pair.master.try_clone_reader().map_err(|err| err.to_string())?;
    let writer = pair.master.take_writer().map_err(|err| err.to_string())?;
    *state.pty_master.lock().map_err(|err| err.to_string())? = Some(pair.master);
    *state.pty_writer.lock().map_err(|err| err.to_string())? = Some(writer);
    *state.pty_child.lock().map_err(|err| err.to_string())? = Some(child);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..count]);
                    if app.emit("term-data", data).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("term-exit", ());
    });
    Ok(())
}

pub fn terminal_write(state: &ShellState, data: &[u8]) -> Result<(), String> {
    let mut guard = state.pty_writer.lock().map_err(|err| err.to_string())?;
    let Some(writer) = guard.as_mut() else { return Err("The terminal isn't open.".into()) };
    writer.write_all(data).map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn terminal_resize(state: &ShellState, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.pty_master.lock().map_err(|err| err.to_string())?;
    if let Some(master) = guard.as_ref() {
        master
            .resize(PtySize { rows: rows.max(8), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn terminal_cd(state: &ShellState, path: &str) -> Result<(), String> {
    let command = cd_command(path);
    terminal_write(state, command.as_bytes())
}

fn pump(app: AppHandle, id: String, mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buf[..count]).to_string();
                    let _ = app.emit("cmd-output", CmdChunk { id: id.clone(), text, done: false, code: None });
                }
            }
        }
    })
}

fn command_in(cwd: &str, command: &str) -> Result<std::process::Child, String> {
    let mut process = shell_command(command);
    if !cwd.trim().is_empty() {
        process.current_dir(cwd);
    }
    process.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }
    process.spawn().map_err(|err| format!("Can't run that command: {err}"))
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("cmd");
    process.args(["/C", &format!("chcp 65001>nul & {command}")]);
    process
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("sh");
    process.args(["-c", command]);
    process
}

#[cfg(windows)]
fn shell_program() -> &'static str {
    "powershell.exe"
}

#[cfg(not(windows))]
fn shell_program() -> &'static str {
    "bash"
}

#[cfg(windows)]
fn shell_args() -> &'static [&'static str] {
    &["-NoLogo"]
}

#[cfg(not(windows))]
fn shell_args() -> &'static [&'static str] {
    &["-i"]
}

#[cfg(windows)]
fn cd_command(path: &str) -> String {
    format!("Set-Location -LiteralPath '{}'\r", path.replace('\'', "''"))
}

#[cfg(not(windows))]
fn cd_command(path: &str) -> String {
    format!("cd {}\n", shell_quote(path))
}

#[cfg(not(windows))]
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}
