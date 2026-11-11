use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::fsops::{self, DirEntry, DirListing, ItemDetails, TransferProgress, TransferResult};

const PREVIEW_CAP: u64 = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePublic {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_path: String,
    pub fingerprint: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    pub status: String,
    pub path: Option<String>,
    pub profile_id: Option<String>,
    pub fingerprint: String,
    pub pinned: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub profile_id: Option<String>,
    pub label: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub remote_path: Option<String>,
    pub accept_fingerprint: Option<String>,
    pub pending_id: Option<String>,
    #[serde(default)]
    pub replace_pin: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBytes {
    pub name: String,
    pub size: u64,
    pub data: Vec<u8>,
    pub truncated: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct Secret {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Profile {
    id: String,
    label: String,
    host: String,
    port: u16,
    username: String,
    remote_path: String,
    fingerprint: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Disk {
    profiles: Vec<Profile>,
    hosts: HashMap<String, String>,
}

pub fn is_remote(raw: &str) -> bool {
    split(raw).is_some()
}

pub fn split(raw: &str) -> Option<(String, String)> {
    let rest = raw.trim().strip_prefix("sftp:")?;
    let (id, remote) = rest.split_once(':')?;
    if id.is_empty() || id.contains('/') || id.contains('\\') {
        return None;
    }
    Some((id.to_string(), normalize_remote(remote)))
}

pub fn join(profile: &str, remote: &str) -> String {
    format!("sftp:{profile}:{}", normalize_remote(remote))
}

pub fn normalize_remote(path: &str) -> String {
    let flat = path.replace('\\', "/");
    let mut parts = Vec::new();
    for part in flat.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() { "/".into() } else { format!("/{}", parts.join("/")) }
}

pub fn list(raw: &str) -> Result<DirListing, String> {
    call(Op::List(raw.to_string()))
}

pub fn make_dir(parent: &str, name: &str) -> Result<String, String> {
    call(Op::Mkdir(parent.to_string(), name.to_string()))
}

pub fn make_file(parent: &str, name: &str) -> Result<String, String> {
    call(Op::Mkfile(parent.to_string(), name.to_string()))
}

pub fn rename(raw: &str, name: &str) -> Result<String, String> {
    call(Op::Rename(raw.to_string(), name.to_string()))
}

pub fn delete(paths: &[String]) -> Result<u64, String> {
    call(Op::Delete(paths.to_vec()))
}

pub fn read_capped(raw: &str, max: u64) -> Result<RemoteBytes, String> {
    call(Op::Read { path: raw.to_string(), max })
}

pub fn export_temp(raw: &str) -> Result<String, String> {
    call(Op::Export(raw.to_string()))
}

pub fn describe(raw: &str) -> Result<ItemDetails, String> {
    call(Op::Stat(raw.to_string()))
}

pub fn transfer(app: &AppHandle, sources: &[String], dest: &str, overwrite: bool, relocate: bool) -> Result<TransferResult, String> {
    if sources.is_empty() {
        return Err("Nothing selected.".into());
    }
    if sources.iter().any(|path| path.trim().starts_with("zip:") || path.trim().starts_with("gz:")) || dest.trim().starts_with("zip:") || dest.trim().starts_with("gz:") {
        return Err("Copy archive contents separately from a server.".into());
    }
    let profiles: Vec<String> = sources.iter().filter_map(|path| split(path).map(|(id, _)| id)).chain(split(dest).map(|(id, _)| id)).collect();
    if profiles.iter().any(|id| id != &profiles[0]) {
        return Err("Copy between two servers isn't available yet. Use a local folder in between.".into());
    }
    call(Op::Transfer {
        app: app.clone(),
        sources: sources.to_vec(),
        dest: dest.to_string(),
        overwrite,
        relocate,
    })
}

pub fn open(request: OpenRequest) -> Result<OpenResponse, String> {
    call(Op::Open(request))
}

pub fn profiles() -> Result<Vec<ProfilePublic>, String> {
    call(Op::Profiles)
}

pub fn forget(id: &str) -> Result<(), String> {
    call(Op::Forget(id.to_string()))
}

pub fn disconnect(id: &str) -> Result<(), String> {
    call(Op::Disconnect(id.to_string()))
}

pub fn stash_secret(password: Option<String>, private_key: Option<String>, passphrase: Option<String>) -> Result<String, String> {
    let id = format!("pending-{}", fresh_id());
    let secret = Secret { password, private_key, passphrase };
    let text = serde_json::to_string(&secret).map_err(|_| "Can't store that secret.".to_string())?;
    crate::secrets::put(&id, &text)?;
    Ok(id)
}

enum Op {
    Open(OpenRequest),
    List(String),
    Mkdir(String, String),
    Mkfile(String, String),
    Rename(String, String),
    Delete(Vec<String>),
    Read { path: String, max: u64 },
    Export(String),
    Stat(String),
    Transfer { app: AppHandle, sources: Vec<String>, dest: String, overwrite: bool, relocate: bool },
    Profiles,
    Forget(String),
    Disconnect(String),
}

enum Out {
    Listing(DirListing),
    Text(String),
    Count(u64),
    Open(OpenResponse),
    Bytes(RemoteBytes),
    Details(ItemDetails),
    Transfer(TransferResult),
    Profiles(Vec<ProfilePublic>),
    Unit,
}

fn call<T>(op: Op) -> Result<T, String>
where
    T: FromOut,
{
    let (tx, rx) = mpsc::channel();
    pool().send(Job { op, reply: tx }).map_err(|_| "The SFTP worker stopped.".to_string())?;
    let out = rx.recv().map_err(|_| "The SFTP worker stopped.".to_string())??;
    T::from_out(out)
}

trait FromOut: Sized {
    fn from_out(out: Out) -> Result<Self, String>;
}

impl FromOut for DirListing {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Listing(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for String {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Text(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for u64 {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Count(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for OpenResponse {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Open(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for RemoteBytes {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Bytes(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for ItemDetails {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Details(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for TransferResult {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Transfer(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for Vec<ProfilePublic> {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Profiles(value) => Ok(value), _ => Err("Unexpected SFTP result.".into()) }
    }
}
impl FromOut for () {
    fn from_out(out: Out) -> Result<Self, String> {
        match out { Out::Unit => Ok(()), _ => Err("Unexpected SFTP result.".into()) }
    }
}

struct Job {
    op: Op,
    reply: mpsc::Sender<Result<Out, String>>,
}

struct Pool {
    tx: mpsc::Sender<Job>,
}

fn pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new().name("filepad-sftp".into()).spawn(move || worker(rx)).ok();
        Pool { tx }
    })
}

impl Pool {
    fn send(&self, job: Job) -> Result<(), mpsc::SendError<Job>> {
        self.tx.send(job)
    }
}

struct Live {
    _handle: russh::client::Handle<KeyCheck>,
    sftp: russh_sftp::client::SftpSession,
}

struct KeyCheck {
    seen: Arc<Mutex<String>>,
    allow: Option<String>,
}

#[derive(Debug)]
struct SshFail(String);

impl std::fmt::Display for SshFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SshFail {}
impl From<russh::Error> for SshFail {
    fn from(err: russh::Error) -> Self {
        SshFail(err.to_string())
    }
}

impl russh::client::Handler for KeyCheck {
    type Error = SshFail;

    fn check_server_key(&mut self, server_public_key: &russh::keys::PublicKeyOrCertificate) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let fingerprint = server_public_key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
        if let Ok(mut seen) = self.seen.lock() {
            *seen = fingerprint.clone();
        }
        let ok = self.allow.as_ref().is_some_and(|expected| expected == &fingerprint);
        async move { Ok(ok) }
    }
}

fn worker(rx: mpsc::Receiver<Job>) {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(_) => return,
    };
    let mut sessions: HashMap<String, Live> = HashMap::new();
    let _ = fs::remove_dir_all(temp_root());
    while let Ok(job) = rx.recv() {
        let result = runtime.block_on(dispatch(&mut sessions, job.op));
        let _ = job.reply.send(result);
    }
}

async fn dispatch(sessions: &mut HashMap<String, Live>, op: Op) -> Result<Out, String> {
    match op {
        Op::Open(request) => Ok(Out::Open(open_session(sessions, request).await?)),
        Op::List(path) => Ok(Out::Listing(list_path(sessions, &path).await?)),
        Op::Mkdir(parent, name) => Ok(Out::Text(mkdir_remote(sessions, &parent, &name).await?)),
        Op::Mkfile(parent, name) => Ok(Out::Text(mkfile_remote(sessions, &parent, &name).await?)),
        Op::Rename(path, name) => Ok(Out::Text(rename_path(sessions, &path, &name).await?)),
        Op::Delete(paths) => Ok(Out::Count(delete_paths(sessions, &paths).await?)),
        Op::Read { path, max } => Ok(Out::Bytes(read_remote(sessions, &path, max).await?)),
        Op::Export(path) => Ok(Out::Text(export_remote(sessions, &path).await?)),
        Op::Stat(path) => Ok(Out::Details(describe_remote(sessions, &path).await?)),
        Op::Transfer { app, sources, dest, overwrite, relocate } => Ok(Out::Transfer(transfer_remote(sessions, &app, &sources, &dest, overwrite, relocate).await?)),
        Op::Profiles => Ok(Out::Profiles(load_disk().profiles.into_iter().map(public_profile).collect())),
        Op::Forget(id) => {
            sessions.remove(&id);
            let mut disk = load_disk();
            disk.profiles.retain(|profile| profile.id != id);
            save_disk(&disk)?;
            crate::secrets::delete(&id);
            let _ = fs::remove_dir_all(temp_root().join(&id));
            Ok(Out::Unit)
        }
        Op::Disconnect(id) => {
            if let Some(live) = sessions.remove(&id) {
                let _ = live.sftp.close().await;
            }
            let _ = fs::remove_dir_all(temp_root().join(&id));
            Ok(Out::Unit)
        }
    }
}

async fn open_session(sessions: &mut HashMap<String, Live>, request: OpenRequest) -> Result<OpenResponse, String> {
    let mut disk = load_disk();
    let existing = request.profile_id.as_ref().and_then(|id| disk.profiles.iter().find(|profile| &profile.id == id).cloned());
    let pending = if let Some(id) = request.pending_id.as_ref() {
        let text = crate::secrets::get(id)?;
        Some(serde_json::from_str::<Secret>(&text).map_err(|_| "The saved secret is unreadable.".to_string())?)
    } else {
        None
    };
    let host = request.host.clone().filter(|value| !value.trim().is_empty()).or_else(|| existing.as_ref().map(|profile| profile.host.clone())).ok_or_else(|| "Enter a host.".to_string())?;
    let host = host.trim().to_string();
    if host.contains([' ', '/', '\\', '\n', '\r']) {
        return Err("That host isn't valid.".into());
    }
    let port = request.port.or_else(|| existing.as_ref().map(|profile| profile.port)).unwrap_or(22);
    if port == 0 {
        return Err("Enter a port from 1 to 65535.".into());
    }
    let username = request.username.clone().filter(|value| !value.trim().is_empty()).or_else(|| existing.as_ref().map(|profile| profile.username.clone())).ok_or_else(|| "Enter a user name.".to_string())?;
    let username = username.trim().to_string();
    let remote_path = normalize_remote(&request.remote_path.clone().filter(|value| !value.trim().is_empty()).or_else(|| existing.as_ref().map(|profile| profile.remote_path.clone())).unwrap_or_else(|| "/".into()));
    let label = request.label.clone().filter(|value| !value.trim().is_empty()).or_else(|| existing.as_ref().map(|profile| profile.label.clone())).unwrap_or_else(|| format!("{username}@{host}"));
    let mut secret = pending.unwrap_or(Secret { password: None, private_key: None, passphrase: None });
    if secret.password.as_ref().map(|value| value.is_empty()).unwrap_or(true) && secret.private_key.as_ref().map(|value| value.trim().is_empty()).unwrap_or(true) {
        if let Some(profile) = &existing {
            let text = crate::secrets::get(&profile.id)?;
            secret = serde_json::from_str(&text).map_err(|_| "The saved secret is unreadable.".to_string())?;
        }
    }
    if let Some(password) = request.password.clone().filter(|value| !value.is_empty()) {
        secret.password = Some(password);
    }
    if let Some(key) = request.private_key.clone().filter(|value| !value.trim().is_empty()) {
        secret.private_key = Some(key);
        secret.passphrase = request.passphrase.clone();
    }
    let host_key = format!("{host}:{port}");
    let pinned = disk.hosts.get(&host_key).cloned().or_else(|| existing.as_ref().map(|profile| profile.fingerprint.clone())).filter(|value| !value.is_empty());
    let accept = request.accept_fingerprint.clone().filter(|value| !value.trim().is_empty()).map(|value| value.trim().to_string());
    if !request.replace_pin {
        if let (Some(pinned_key), Some(accepted)) = (&pinned, &accept) {
            if pinned_key != accepted {
                let profile = Profile {
                    id: existing.as_ref().map(|profile| profile.id.clone()).unwrap_or_else(fresh_id),
                    label: label.clone(),
                    host: host.clone(),
                    port,
                    username: username.clone(),
                    remote_path: remote_path.clone(),
                    fingerprint: pinned_key.clone(),
                };
                return Ok(mismatch(&profile, accepted, pinned_key));
            }
        }
    }
    let allow = if request.replace_pin { accept.clone().or_else(|| pinned.clone()) } else { pinned.clone().or_else(|| accept.clone()) };
    let profile = Profile {
        id: existing.as_ref().map(|profile| profile.id.clone()).unwrap_or_else(fresh_id),
        label,
        host: host.clone(),
        port,
        username: username.clone(),
        remote_path: remote_path.clone(),
        fingerprint: pinned.clone().unwrap_or_default(),
    };
    match connect_live(&profile, &secret, allow).await {
        Ok((live, fingerprint)) => {
            if let Some(pinned) = &pinned {
                if accept.is_none() && pinned != &fingerprint {
                    return Ok(mismatch(&profile, &fingerprint, pinned));
                }
            }
            sessions.insert(profile.id.clone(), live);
            let text = serde_json::to_string(&secret).map_err(|_| "Can't store that secret.".to_string())?;
            crate::secrets::put(&profile.id, &text)?;
            if let Some(id) = &request.pending_id {
                crate::secrets::delete(id);
            }
            disk.hosts.insert(host_key, fingerprint.clone());
            let mut saved = profile.clone();
            saved.fingerprint = fingerprint.clone();
            saved.remote_path = remote_path.clone();
            if let Some(slot) = disk.profiles.iter_mut().find(|item| item.id == saved.id) {
                *slot = saved.clone();
            } else {
                disk.profiles.push(saved.clone());
            }
            save_disk(&disk)?;
            Ok(OpenResponse {
                status: "ready".into(),
                path: Some(join(&saved.id, &remote_path)),
                profile_id: Some(saved.id),
                fingerprint,
                pinned: None,
                host,
                port,
                username,
                remote_path,
            })
        }
        Err(OpenFail::NeedPin(fingerprint)) => Ok(OpenResponse {
            status: "needPin".into(),
            path: None,
            profile_id: existing.as_ref().map(|profile| profile.id.clone()),
            fingerprint,
            pinned: None,
            host,
            port,
            username,
            remote_path,
        }),
        Err(OpenFail::Mismatch { seen, pinned }) => Ok(mismatch(&profile, &seen, &pinned)),
        Err(OpenFail::Message(message)) => Err(message),
    }
}

fn mismatch(profile: &Profile, seen: &str, pinned: &str) -> OpenResponse {
    OpenResponse {
        status: "mismatch".into(),
        path: None,
        profile_id: Some(profile.id.clone()),
        fingerprint: seen.to_string(),
        pinned: Some(pinned.to_string()),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        remote_path: profile.remote_path.clone(),
    }
}

enum OpenFail {
    NeedPin(String),
    Mismatch { seen: String, pinned: String },
    Message(String),
}

fn reach_message(host: &str, port: u16, err: &SshFail) -> String {
    let text = err.to_string().to_ascii_lowercase();
    if text.contains("no such host") || text.contains("not known") || text.contains("name or service not known") || text.contains("nodename nor servname") {
        return format!("Can't find {host}. Use the SFTP host, which may be an IP address.");
    }
    if text.contains("invalid ssh version") {
        return format!("{host}:{port} answered, but not as SFTP.");
    }
    if text.contains("refused") {
        return format!("Nothing is listening on {host}:{port}.");
    }
    format!("Can't reach {host}:{port}.")
}

async fn connect_live(profile: &Profile, secret: &Secret, allow: Option<String>) -> Result<(Live, String), OpenFail> {
    let seen = Arc::new(Mutex::new(String::new()));
    let handler = KeyCheck { seen: seen.clone(), allow: allow.clone() };
    let config = Arc::new(russh::client::Config::default());
    let address = format!("{}:{}", profile.host, profile.port);
    let connect = russh::client::connect(config, address, handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(12), connect).await {
        Ok(Ok(handle)) => handle,
        Ok(Err(err)) => {
            let fingerprint = seen.lock().map(|value| value.clone()).unwrap_or_default();
            if fingerprint.is_empty() {
                return Err(OpenFail::Message(reach_message(&profile.host, profile.port, &err)));
            }
            let _ = err;
            return match allow {
                None => Err(OpenFail::NeedPin(fingerprint)),
                Some(pinned) if pinned != fingerprint => Err(OpenFail::Mismatch { seen: fingerprint, pinned }),
                Some(_) => Err(OpenFail::NeedPin(fingerprint)),
            };
        }
        Err(_) => return Err(OpenFail::Message(format!("Can't reach {}:{}.", profile.host, profile.port))),
    };
    let authed = if let Some(pem) = secret.private_key.as_ref().filter(|value| !value.trim().is_empty()) {
        let passphrase = secret.passphrase.as_deref().filter(|value| !value.is_empty());
        let key = russh::keys::decode_secret_key(pem, passphrase).map_err(|_| OpenFail::Message("Can't read that private key.".into()))?;
        let hash = if key.algorithm().is_rsa() {
            handle.best_supported_rsa_hash().await.ok().flatten().flatten()
        } else {
            None
        };
        let pair = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash);
        handle.authenticate_publickey(&profile.username, pair).await
    } else if let Some(password) = secret.password.as_ref().filter(|value| !value.is_empty()) {
        handle.authenticate_password(&profile.username, password).await
    } else {
        return Err(OpenFail::Message("Enter a password or a private key.".into()));
    };
    match authed {
        Ok(result) if result.success() => {}
        _ => return Err(OpenFail::Message("The server refused that login.".into())),
    }
    let channel = handle.channel_open_session().await.map_err(|_| OpenFail::Message("Can't open a session.".into()))?;
    channel.request_subsystem(true, "sftp").await.map_err(|_| OpenFail::Message("This server has no SFTP.".into()))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await.map_err(|_| OpenFail::Message("Can't start SFTP.".into()))?;
    sftp.set_timeout(120);
    let fingerprint = seen.lock().map(|value| value.clone()).unwrap_or_default();
    Ok((Live { _handle: handle, sftp }, fingerprint))
}

async fn ensure<'a>(sessions: &'a mut HashMap<String, Live>, id: &str) -> Result<&'a russh_sftp::client::SftpSession, String> {
    if !sessions.contains_key(id) {
        let disk = load_disk();
        let profile = disk.profiles.iter().find(|profile| profile.id == id).cloned().ok_or_else(|| "That server profile is gone.".to_string())?;
        if profile.fingerprint.is_empty() {
            return Err("Connect again and accept the server key.".into());
        }
        let text = crate::secrets::get(id)?;
        let secret = serde_json::from_str::<Secret>(&text).map_err(|_| "The saved secret is unreadable.".to_string())?;
        match connect_live(&profile, &secret, Some(profile.fingerprint.clone())).await {
            Ok((live, fingerprint)) => {
                if fingerprint != profile.fingerprint {
                    return Err("This server's key changed. Connect again to review it.".into());
                }
                sessions.insert(id.to_string(), live);
            }
            Err(OpenFail::Mismatch { .. }) => return Err("This server's key changed. Connect again to review it.".into()),
            Err(OpenFail::NeedPin(_)) => return Err("Connect again and accept the server key.".into()),
            Err(OpenFail::Message(message)) => return Err(message),
        }
    }
    sessions.get(id).map(|live| &live.sftp).ok_or_else(|| "Connect to this server again.".to_string())
}

async fn list_path(sessions: &mut HashMap<String, Live>, raw: &str) -> Result<DirListing, String> {
    let (id, remote) = split(raw).ok_or_else(|| "That isn't a server folder.".to_string())?;
    let sftp = ensure(sessions, &id).await?;
    let read = sftp.read_dir(&remote).await.map_err(sftp_err)?;
    let mut entries = Vec::new();
    for entry in read {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let kind = entry.file_type();
        let link = kind.is_symlink();
        let is_dir = kind.is_dir() && !link;
        let meta = entry.metadata();
        let extension = if link {
            "link".into()
        } else if is_dir {
            String::new()
        } else {
            extension_of(&name)
        };
        entries.push(DirEntry {
            name: name.clone(),
            path: join(&id, &normalize_remote(&entry.path())),
            is_dir,
            size: if is_dir { 0 } else { meta.size.unwrap_or(0) },
            modified: meta.mtime.unwrap_or(0) as u64 * 1000,
            extension,
            hidden: name.starts_with('.'),
        });
    }
    Ok(DirListing { path: join(&id, &remote), parent: parent_of(&id, &remote), entries })
}

async fn mkdir_remote(sessions: &mut HashMap<String, Live>, parent: &str, name: &str) -> Result<String, String> {
    let (id, remote) = split(parent).ok_or_else(|| "That isn't a server folder.".to_string())?;
    let name = clean_name(name)?;
    let path = child(&remote, name);
    let sftp = ensure(sessions, &id).await?;
    if sftp.try_exists(&path).await.unwrap_or(false) {
        return Err("That name is already used.".into());
    }
    sftp.create_dir(&path).await.map_err(sftp_err)?;
    Ok(join(&id, &path))
}

async fn mkfile_remote(sessions: &mut HashMap<String, Live>, parent: &str, name: &str) -> Result<String, String> {
    let (id, remote) = split(parent).ok_or_else(|| "That isn't a server folder.".to_string())?;
    let name = clean_name(name)?;
    let path = child(&remote, name);
    let sftp = ensure(sessions, &id).await?;
    if sftp.try_exists(&path).await.unwrap_or(false) {
        return Err("That name is already used.".into());
    }
    let file = sftp.create(&path).await.map_err(sftp_err)?;
    file.close().await.map_err(sftp_err)?;
    Ok(join(&id, &path))
}

async fn rename_path(sessions: &mut HashMap<String, Live>, raw: &str, name: &str) -> Result<String, String> {
    let (id, remote) = split(raw).ok_or_else(|| "That isn't on a server.".to_string())?;
    if remote == "/" {
        return Err("That folder can't be renamed.".into());
    }
    let name = clean_name(name)?;
    let parent = parent_remote(&remote).unwrap_or_else(|| "/".into());
    let dest = child(&parent, name);
    let sftp = ensure(sessions, &id).await?;
    if dest != remote && sftp.try_exists(&dest).await.unwrap_or(false) {
        return Err("That name is already used.".into());
    }
    if dest != remote {
        sftp.rename(&remote, &dest).await.map_err(sftp_err)?;
    }
    Ok(join(&id, &dest))
}

async fn delete_paths(sessions: &mut HashMap<String, Live>, paths: &[String]) -> Result<u64, String> {
    if paths.is_empty() {
        return Err("Nothing selected.".into());
    }
    let mut ids = Vec::new();
    for path in paths {
        let (id, remote) = split(path).ok_or_else(|| "That isn't on a server.".to_string())?;
        if remote == "/" {
            return Err("That folder can't be deleted.".into());
        }
        ids.push((id, remote));
    }
    let id = ids[0].0.clone();
    if ids.iter().any(|(other, _)| other != &id) {
        return Err("Delete one server at a time.".into());
    }
    let sftp = ensure(sessions, &id).await?;
    for (_, remote) in &ids {
        delete_tree(sftp, remote).await?;
    }
    Ok(paths.len() as u64)
}

async fn delete_tree(sftp: &russh_sftp::client::SftpSession, root: &str) -> Result<(), String> {
    let mut pending = vec![root.to_string()];
    let mut dirs = Vec::new();
    while let Some(path) = pending.pop() {
        let meta = sftp.symlink_metadata(&path).await.map_err(sftp_err)?;
        let kind = meta.file_type();
        if kind.is_symlink() || !kind.is_dir() {
            sftp.remove_file(&path).await.map_err(sftp_err)?;
            continue;
        }
        dirs.push(path.clone());
        let read = sftp.read_dir(&path).await.map_err(sftp_err)?;
        for entry in read {
            pending.push(normalize_remote(&entry.path()));
        }
    }
    dirs.sort_by_key(|path| std::cmp::Reverse(path.len()));
    for path in dirs {
        sftp.remove_dir(&path).await.map_err(sftp_err)?;
    }
    Ok(())
}

async fn read_remote(sessions: &mut HashMap<String, Live>, raw: &str, max: u64) -> Result<RemoteBytes, String> {
    let (id, remote) = split(raw).ok_or_else(|| "That isn't on a server.".to_string())?;
    let sftp = ensure(sessions, &id).await?;
    let meta = sftp.symlink_metadata(&remote).await.map_err(|_| "Can't read that file.".to_string())?;
    if meta.file_type().is_dir() {
        return Err("Choose a file to preview.".into());
    }
    let size = meta.size.unwrap_or(0);
    let unlimited = max == u64::MAX;
    let cap = if unlimited { u64::MAX } else { max.min(PREVIEW_CAP) };
    let mut file = sftp.open(&remote).await.map_err(sftp_err)?;
    let mut data = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let limit = if unlimited { u64::MAX } else { cap.saturating_add(1) };
    while (data.len() as u64) < limit {
        let room = (limit as usize).saturating_sub(data.len());
        let want = room.min(buf.len());
        let read = file.read(&mut buf[..want]).await.map_err(sftp_err)?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&buf[..read]);
    }
    let _ = file.close().await;
    let truncated = !unlimited && ((data.len() as u64) > cap || size > cap);
    if !unlimited && (data.len() as u64) > cap {
        data.truncate(cap as usize);
    }
    let name = base_name(&remote);
    Ok(RemoteBytes { name, size: size.max(data.len() as u64), data, truncated })
}

async fn export_remote(sessions: &mut HashMap<String, Live>, raw: &str) -> Result<String, String> {
    let (id, remote) = split(raw).ok_or_else(|| "That isn't on a server.".to_string())?;
    let sftp = ensure(sessions, &id).await?;
    let meta = sftp.symlink_metadata(&remote).await.map_err(|_| "Can't find that item.".to_string())?;
    if meta.file_type().is_dir() {
        return Err("Choose a file.".into());
    }
    let dir = temp_root().join(&id);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let raw_name = base_name(&remote);
    let name = clean_name(&raw_name).unwrap_or("file").to_string();
    let dest = unique_file(&dir, &name);
    download_file(sftp, &remote, &dest).await?;
    Ok(dest.display().to_string())
}

async fn describe_remote(sessions: &mut HashMap<String, Live>, raw: &str) -> Result<ItemDetails, String> {
    let (id, remote) = split(raw).ok_or_else(|| "That isn't on a server.".to_string())?;
    let sftp = ensure(sessions, &id).await?;
    let meta = sftp.symlink_metadata(&remote).await.map_err(|_| "Can't find that item.".to_string())?;
    let kind = meta.file_type();
    let link = kind.is_symlink();
    let is_dir = kind.is_dir() && !link;
    let name = if remote == "/" { "/".into() } else { base_name(&remote) };
    let extension = if link { "link".into() } else if is_dir { String::new() } else { extension_of(&name) };
    let mut files = 0u64;
    let mut folders = 0u64;
    if is_dir {
        if let Ok(read) = sftp.read_dir(&remote).await {
            for entry in read {
                if entry.file_type().is_dir() { folders += 1; } else { files += 1; }
            }
        }
    }
    let location = parent_remote(&remote).unwrap_or_else(|| "/".into());
    Ok(ItemDetails {
        name,
        path: join(&id, &remote),
        location: join(&id, &location),
        kind: if link { "Link".into() } else if is_dir { "Folder".into() } else { fsops::kind_label(false, &extension) },
        is_dir,
        size: if is_dir { 0 } else { meta.size.unwrap_or(0) },
        size_known: !is_dir,
        modified: meta.mtime.unwrap_or(0) as u64 * 1000,
        created: 0,
        accessed: meta.atime.unwrap_or(0) as u64 * 1000,
        hidden: name_hidden(&base_name(&remote)),
        read_only: false,
        files,
        folders,
        counted: is_dir,
    })
}

async fn transfer_remote(sessions: &mut HashMap<String, Live>, app: &AppHandle, sources: &[String], dest: &str, overwrite: bool, relocate: bool) -> Result<TransferResult, String> {
    let dest_remote = split(dest);
    let source_remote = sources.iter().any(|path| is_remote(path));
    if let (true, Some((dest_id, dest_dir))) = (source_remote, dest_remote.as_ref()) {
        if sources.iter().all(|path| split(path).map(|(id, _)| id) == Some(dest_id.clone())) && relocate {
            return rename_move(sessions, app, sources, dest_id, dest_dir, overwrite).await;
        }
    }
    if dest_remote.is_some() && source_remote {
        return Err("Copy between two servers isn't available yet. Use a local folder in between.".into());
    }
    if let Some((id, remote_dest)) = dest_remote {
        return upload(sessions, app, sources, &id, &remote_dest, overwrite, relocate).await;
    }
    if source_remote {
        let local = PathBuf::from(dest.trim());
        if !local.is_dir() {
            return Err("Choose a destination folder.".into());
        }
        return download(sessions, app, sources, &local, overwrite, relocate).await;
    }
    Err("Nothing to copy.".into())
}

async fn rename_move(sessions: &mut HashMap<String, Live>, app: &AppHandle, sources: &[String], id: &str, dest_dir: &str, overwrite: bool) -> Result<TransferResult, String> {
    let sftp = ensure(sessions, id).await?;
    let mut conflicts = Vec::new();
    for source in sources {
        let (_, remote) = split(source).ok_or_else(|| "That isn't on a server.".to_string())?;
        let name = base_name(&remote);
        let target = child(dest_dir, &name);
        if target == remote {
            return Err("Can't put a folder inside itself.".into());
        }
        if remote != "/" && target.starts_with(&format!("{remote}/")) {
            return Err("Can't put a folder inside itself.".into());
        }
        if sftp.try_exists(&target).await.unwrap_or(false) {
            conflicts.push(name);
        }
    }
    if !conflicts.is_empty() && !overwrite {
        return Ok(TransferResult { done: 0, conflicts });
    }
    let total = sources.len() as u64;
    let mut done = 0u64;
    emit(app, done, total, "Starting");
    for source in sources {
        let (_, remote) = split(source).ok_or_else(|| "That isn't on a server.".to_string())?;
        let name = base_name(&remote);
        let target = child(dest_dir, &name);
        emit(app, done, total, &name);
        if sftp.try_exists(&target).await.unwrap_or(false) {
            delete_tree(sftp, &target).await?;
        }
        sftp.rename(&remote, &target).await.map_err(sftp_err)?;
        done += 1;
        emit(app, done, total, &name);
    }
    Ok(TransferResult { done, conflicts: Vec::new() })
}

async fn upload(sessions: &mut HashMap<String, Live>, app: &AppHandle, sources: &[String], id: &str, dest_dir: &str, overwrite: bool, relocate: bool) -> Result<TransferResult, String> {
    let mut locals = Vec::new();
    for source in sources {
        if is_remote(source) {
            return Err("Copy between two servers isn't available yet. Use a local folder in between.".into());
        }
        let path = PathBuf::from(source.trim());
        if !path.exists() {
            return Err(format!("Can't find {}", path.display()));
        }
        locals.push(path);
    }
    let sftp = ensure(sessions, id).await?;
    let mut conflicts = Vec::new();
    for path in &locals {
        let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        if sftp.try_exists(&child(dest_dir, &name)).await.unwrap_or(false) {
            conflicts.push(name);
        }
    }
    if !conflicts.is_empty() && !overwrite {
        return Ok(TransferResult { done: 0, conflicts });
    }
    let total: u64 = locals.iter().map(|path| count_local(path)).sum();
    let mut done = 0u64;
    emit(app, done, total, "Starting");
    for path in &locals {
        let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        upload_one(sftp, app, path, &child(dest_dir, &name), &mut done, total).await?;
        if relocate {
            if path.is_dir() { let _ = fs::remove_dir_all(path); } else { let _ = fs::remove_file(path); }
        }
    }
    Ok(TransferResult { done, conflicts: Vec::new() })
}

async fn upload_one(sftp: &russh_sftp::client::SftpSession, app: &AppHandle, src: &Path, dest: &str, done: &mut u64, total: u64) -> Result<(), String> {
    let mut stack = vec![(src.to_path_buf(), dest.to_string())];
    while let Some((src, dest)) = stack.pop() {
        let meta = fs::symlink_metadata(&src).map_err(|err| format!("Can't read {}: {err}", src.display()))?;
        let name = src.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        if meta.file_type().is_symlink() && !src.is_file() {
            return Err(format!("Skipped linked folder {name}."));
        }
        if meta.is_dir() && !meta.file_type().is_symlink() {
            if !sftp.try_exists(&dest).await.unwrap_or(false) {
                sftp.create_dir(&dest).await.map_err(sftp_err)?;
            }
            let mut children = Vec::new();
            for item in fs::read_dir(&src).map_err(|err| err.to_string())? {
                let item = item.map_err(|err| err.to_string())?;
                let child_name = item.file_name().to_string_lossy().to_string();
                children.push((item.path(), child(&dest, &child_name)));
            }
            stack.extend(children);
            continue;
        }
        emit(app, *done, total, &name);
        let mut local = File::open(&src).map_err(|err| format!("Can't read {}: {err}", src.display()))?;
        if sftp.try_exists(&dest).await.unwrap_or(false) {
            let meta = sftp.symlink_metadata(&dest).await.map_err(sftp_err)?;
            if meta.file_type().is_dir() {
                delete_tree(sftp, &dest).await?;
            }
        }
        let mut remote = sftp.create(&dest).await.map_err(sftp_err)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let read = local.read(&mut buf).map_err(|err| err.to_string())?;
            if read == 0 {
                break;
            }
            remote.write_all(&buf[..read]).await.map_err(sftp_err)?;
        }
        remote.shutdown().await.map_err(sftp_err)?;
        *done += 1;
        emit(app, *done, total, &name);
    }
    Ok(())
}

async fn download(sessions: &mut HashMap<String, Live>, app: &AppHandle, sources: &[String], dest_dir: &Path, overwrite: bool, relocate: bool) -> Result<TransferResult, String> {
    let mut items = Vec::new();
    for source in sources {
        let (id, remote) = split(source).ok_or_else(|| "That isn't on a server.".to_string())?;
        items.push((id, remote));
    }
    let id = items[0].0.clone();
    if items.iter().any(|(other, _)| other != &id) {
        return Err("Copy between two servers isn't available yet. Use a local folder in between.".into());
    }
    let sftp = ensure(sessions, &id).await?;
    let mut conflicts = Vec::new();
    for (_, remote) in &items {
        let name = base_name(remote);
        if dest_dir.join(&name).exists() {
            conflicts.push(name);
        }
    }
    if !conflicts.is_empty() && !overwrite {
        return Ok(TransferResult { done: 0, conflicts });
    }
    let mut total = 0u64;
    for (_, remote) in &items {
        total += count_remote(sftp, remote).await?;
    }
    let mut done = 0u64;
    emit(app, done, total, "Starting");
    for (_, remote) in &items {
        let name = base_name(remote);
        download_one(sftp, app, remote, &dest_dir.join(&name), &mut done, total).await?;
        if relocate {
            delete_tree(sftp, remote).await?;
        }
    }
    Ok(TransferResult { done, conflicts: Vec::new() })
}

async fn download_one(sftp: &russh_sftp::client::SftpSession, app: &AppHandle, remote: &str, dest: &Path, done: &mut u64, total: u64) -> Result<(), String> {
    let mut stack = vec![(remote.to_string(), dest.to_path_buf())];
    while let Some((remote, dest)) = stack.pop() {
        let meta = sftp.symlink_metadata(&remote).await.map_err(sftp_err)?;
        let kind = meta.file_type();
        let name = base_name(&remote);
        if kind.is_symlink() {
            return Err(format!("Skipped link {name}."));
        }
        if kind.is_dir() {
            fs::create_dir_all(&dest).map_err(|err| err.to_string())?;
            let read = sftp.read_dir(&remote).await.map_err(sftp_err)?;
            let mut children = Vec::new();
            for entry in read {
                children.push((normalize_remote(&entry.path()), dest.join(entry.file_name())));
            }
            stack.extend(children);
            continue;
        }
        emit(app, *done, total, &name);
        download_file(sftp, &remote, &dest).await?;
        *done += 1;
        emit(app, *done, total, &name);
    }
    Ok(())
}

async fn download_file(sftp: &russh_sftp::client::SftpSession, remote: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut remote_file = sftp.open(remote).await.map_err(sftp_err)?;
    let mut local = File::create(dest).map_err(|err| err.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = remote_file.read(&mut buf).await.map_err(sftp_err)?;
        if read == 0 {
            break;
        }
        local.write_all(&buf[..read]).map_err(|err| err.to_string())?;
    }
    let _ = remote_file.close().await;
    Ok(())
}

async fn count_remote(sftp: &russh_sftp::client::SftpSession, remote: &str) -> Result<u64, String> {
    let mut stack = vec![remote.to_string()];
    let mut total = 0u64;
    while let Some(path) = stack.pop() {
        let meta = sftp.symlink_metadata(&path).await.map_err(sftp_err)?;
        let kind = meta.file_type();
        if kind.is_symlink() || !kind.is_dir() {
            total += 1;
            continue;
        }
        let read = sftp.read_dir(&path).await.map_err(sftp_err)?;
        for entry in read {
            stack.push(normalize_remote(&entry.path()));
        }
    }
    Ok(total)
}

fn count_local(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 1 };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return 1;
    }
    let Ok(read) = fs::read_dir(path) else { return 1 };
    read.flatten().map(|item| count_local(&item.path())).sum()
}

fn emit(app: &AppHandle, done: u64, total: u64, current: &str) {
    let _ = app.emit("transfer-progress", TransferProgress { done, total, current: current.to_string() });
}

fn sftp_err(err: impl std::fmt::Display) -> String {
    let text = err.to_string();
    if text.is_empty() { "The server refused that.".into() } else { text }
}

fn parent_of(id: &str, remote: &str) -> Option<String> {
    parent_remote(remote).map(|parent| join(id, &parent))
}

fn parent_remote(remote: &str) -> Option<String> {
    let remote = normalize_remote(remote);
    if remote == "/" {
        return None;
    }
    match remote.rfind('/') {
        Some(0) | None => Some("/".into()),
        Some(index) => Some(remote[..index].to_string()),
    }
}

fn child(dir: &str, name: &str) -> String {
    let dir = normalize_remote(dir);
    if dir == "/" { format!("/{name}") } else { format!("{dir}/{name}") }
}

fn base_name(remote: &str) -> String {
    let remote = normalize_remote(remote);
    if remote == "/" { return "/".into(); }
    remote.rsplit('/').next().unwrap_or("file").to_string()
}

fn extension_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn name_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn clean_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') || name.chars().any(|ch| ch.is_control()) {
        return Err("That name isn't allowed.".into());
    }
    Ok(name)
}

pub(crate) fn fresh_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
    format!("{:x}{:x}", std::process::id(), nanos)
}

fn app_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("FilePad");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join("FilePad")
}

fn disk_path() -> PathBuf {
    app_dir().join("sftp-profiles.json")
}

fn load_disk() -> Disk {
    fs::read(disk_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save_disk(disk: &Disk) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(disk).map_err(|_| "Can't save the server list.".to_string())?;
    fs::write(disk_path(), bytes).map_err(|_| "Can't save the server list.".to_string())
}

fn public_profile(profile: Profile) -> ProfilePublic {
    ProfilePublic {
        id: profile.id,
        label: profile.label,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        remote_path: profile.remote_path,
        fingerprint: profile.fingerprint,
    }
}

fn unique_file(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name).file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let ext = Path::new(name).extension().map(|ext| format!(".{}", ext.to_string_lossy())).unwrap_or_default();
    for index in 2..10_000 {
        let path = dir.join(format!("{stem}-{index}{ext}"));
        if !path.exists() {
            return path;
        }
    }
    dir.join(format!("{stem}-{}", fresh_id()))
}

#[cfg(test)]
mod tests {
    use super::{join, normalize_remote, split};

    #[test]
    fn remote_paths_round_trip() {
        assert_eq!(normalize_remote("var/www/../www"), "/var/www");
        assert_eq!(normalize_remote("/"), "/");
        let path = join("abc", "/var/www");
        assert_eq!(split(&path), Some(("abc".into(), "/var/www".into())));
    }
}
