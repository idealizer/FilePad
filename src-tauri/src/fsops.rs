use serde::{Deserialize, Serialize};
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub role: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub extension: String,
    pub hidden: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub done: u64,
    pub total: u64,
    pub current: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub done: u64,
    pub conflicts: Vec<String>,
}

pub fn home_dir() -> String {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|path| friendly(&path))
        .unwrap_or_else(|| ".".to_string())
}

pub fn list_places() -> Vec<Place> {
    let mut places = Vec::new();
    let home = PathBuf::from(home_dir());
    places.push(Place { name: "Home".into(), path: friendly(&home), kind: "place".into(), role: "home".into() });
    for (name, folder, role) in [("Desktop", "Desktop", "desktop"), ("Documents", "Documents", "documents"), ("Downloads", "Downloads", "downloads")] {
        let path = home.join(folder);
        if path.is_dir() {
            places.push(Place { name: name.into(), path: friendly(&path), kind: "place".into(), role: role.into() });
        }
    }
    places.extend(drives());
    places
}

fn virtual_kind(path: &str) -> Option<&'static str> {
    let path = path.trim();
    if path.starts_with("zip:") {
        Some("zip")
    } else if path.starts_with("gz:") {
        Some("gz")
    } else {
        None
    }
}

pub fn list_dir(raw: &str) -> Result<DirListing, String> {
    if crate::sftpnav::is_remote(raw) {
        return crate::sftpnav::list(raw);
    }
    if let Some((archive, inner)) = crate::zipnav::split(raw) {
        return zip_listing(&archive, &inner);
    }
    if let Some((archive, inner)) = crate::gzipnav::split(raw) {
        return gz_listing(&archive, &inner);
    }
    let direct = PathBuf::from(raw.trim());
    if direct.is_file() && crate::zipnav::is_zip_file(&direct) {
        return zip_listing(&direct, "");
    }
    if direct.is_file() && crate::gzipnav::is_gz_file(&direct) {
        return gz_listing(&direct, "");
    }
    let path = resolve_dir(raw)?;
    let shown = friendly(&path);
    let parent = path.parent().map(friendly).filter(|parent| parent != &shown && !parent.is_empty());
    let mut entries = Vec::new();
    let read = fs::read_dir(&path).map_err(|err| format!("Can't open {shown}: {err}"))?;
    for item in read {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        let is_dir = item.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let extension = if is_dir {
            String::new()
        } else {
            item.path().extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
        };
        entries.push(DirEntry {
            path: friendly(&item.path()),
            hidden: is_hidden(&meta, &name),
            size: if is_dir { 0 } else { meta.len() },
            modified: modified_ms(&meta),
            is_dir,
            extension,
            name,
        });
    }
    Ok(DirListing { path: shown, parent, entries })
}

fn zip_listing(archive: &std::path::Path, inner: &str) -> Result<DirListing, String> {
    let listing = crate::zipnav::list(archive, inner)?;
    let entries = listing
        .entries
        .into_iter()
        .map(|entry| DirEntry {
            name: entry.name,
            path: entry.path,
            is_dir: entry.is_dir,
            size: entry.size,
            modified: entry.modified,
            extension: entry.extension,
            hidden: entry.hidden,
        })
        .collect();
    Ok(DirListing { path: listing.path, parent: listing.parent, entries })
}

fn gz_listing(archive: &std::path::Path, inner: &str) -> Result<DirListing, String> {
    let listing = crate::gzipnav::list(archive, inner)?;
    let entries = listing
        .entries
        .into_iter()
        .map(|entry| DirEntry {
            name: entry.name,
            path: entry.path,
            is_dir: entry.is_dir,
            size: entry.size,
            modified: entry.modified,
            extension: entry.extension,
            hidden: entry.hidden,
        })
        .collect();
    Ok(DirListing { path: listing.path, parent: listing.parent, entries })
}

pub fn make_dir(parent: &str, name: &str) -> Result<String, String> {
    if crate::sftpnav::is_remote(parent) {
        return crate::sftpnav::make_dir(parent, name);
    }
    if virtual_kind(parent).is_some() {
        return Err("Can't create a folder inside an archive.".into());
    }
    let name = clean_name(name)?;
    let parent = resolve_dir(parent)?;
    let path = parent.join(name);
    if path.exists() {
        return Err("That name is already used.".into());
    }
    fs::create_dir(&path).map_err(|err| format!("Can't create the folder: {err}"))?;
    Ok(friendly(&path))
}

pub fn make_file(parent: &str, name: &str) -> Result<String, String> {
    if crate::sftpnav::is_remote(parent) {
        return crate::sftpnav::make_file(parent, name);
    }
    if virtual_kind(parent).is_some() {
        return Err("Can't create a file inside an archive.".into());
    }
    let name = clean_name(name)?;
    let parent = resolve_dir(parent)?;
    let path = parent.join(name);
    if path.exists() {
        return Err("That name is already used.".into());
    }
    fs::File::create(&path).map_err(|err| format!("Can't create the file: {err}"))?;
    Ok(friendly(&path))
}

pub fn copy_to_clipboard(raw: &str) -> Result<String, String> {
    let path = materialize(raw)?;
    run_ps(COPY_SCRIPT, &path)?;
    Ok("Copied. Paste it into Mail, a chat, or another folder.".into())
}

pub fn print_file(raw: &str) -> Result<String, String> {
    let path = materialize(raw)?;
    let mode = run_ps_gui(PRINT_SCRIPT, &path)?;
    if mode.trim() == "cancelled" {
        return Ok(String::new());
    }
    Ok("Sent to print.".into())
}

pub fn email_file(raw: &str) -> Result<String, String> {
    let path = materialize(raw)?;
    let mode = run_ps_text(EMAIL_SCRIPT, &path, false)?;
    if mode.trim() == "mapi" {
        return Ok("Opening a message with that file.".into());
    }
    let _ = run_ps(COPY_SCRIPT, &path);
    Ok("Mail is open. The file is on the clipboard so you can attach it.".into())
}

pub fn share_file(raw: &str, target: &str) -> Result<String, String> {
    let path = materialize(raw)?;
    let kind = media_kind(&path);
    let public = matches!(target, "instagram" | "facebook" | "x" | "linkedin" | "tiktok" | "youtube");
    if public && kind.is_empty() {
        return Err("Pictures and videos can be posted. Other files stay on Email and WhatsApp.".into());
    }
    if target == "youtube" && kind != "video" {
        return Err("YouTube is for videos.".into());
    }
    if kind == "image" {
        run_ps(IMAGE_CLIP_SCRIPT, &path)?;
    } else {
        run_ps(COPY_SCRIPT, &path)?;
    }
    let (label, primary, fallback): (&str, String, String) = match target {
        "whatsapp" => ("WhatsApp", "whatsapp://send".into(), "https://web.whatsapp.com/".into()),
        "instagram" => ("Instagram", "https://www.instagram.com/".into(), String::new()),
        "facebook" => ("Facebook", "https://www.facebook.com/".into(), String::new()),
        "x" => ("X", "https://x.com/compose/post".into(), String::new()),
        "linkedin" => ("LinkedIn", "https://www.linkedin.com/feed/?shareActive=true".into(), String::new()),
        "tiktok" => ("TikTok", "https://www.tiktok.com/tiktokstudio/upload".into(), String::new()),
        "youtube" => ("YouTube", "https://www.youtube.com/upload".into(), String::new()),
        _ => return Err("Pick a place to send this file.".into()),
    };
    if open::that(&primary).is_err() && (fallback.is_empty() || open::that(&fallback).is_err()) {
        return Err(format!("Can't open {label}. The file is still on the clipboard."));
    }
    let noun = if kind == "video" { "video" } else if kind == "image" { "picture" } else { "file" };
    if kind == "video" && public {
        return Ok(format!("The video is copied. Paste it into {label}, or drop the file on the page."));
    }
    Ok(format!("The {noun} is copied. Paste it into {label}."))
}

fn media_kind(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "ico" | "svg" | "heic" | "heif" => "image",
        "mp4" | "m4v" | "webm" | "ogv" | "mov" | "mkv" => "video",
        _ => "",
    }
}

fn materialize(raw: &str) -> Result<PathBuf, String> {
    if crate::sftpnav::is_remote(raw) {
        return Err("Copy that file to this computer first.".into());
    }
    let target = match virtual_kind(raw) {
        Some("zip") => crate::zipnav::export_temp(raw)?,
        Some("gz") => crate::gzipnav::export_temp(raw)?,
        _ => raw.trim().to_string(),
    };
    let path = PathBuf::from(&target);
    if !path.exists() {
        return Err("Can't find that item.".into());
    }
    Ok(path)
}

fn run_ps(script: &str, path: &Path) -> Result<(), String> {
    let _ = run_ps_text(script, path, false)?;
    Ok(())
}

fn run_ps_gui(script: &str, path: &Path) -> Result<String, String> {
    #[cfg(windows)]
    unsafe {
        AllowSetForegroundWindow(0xFFFF_FFFF);
    }
    run_ps_text(script, path, true)
}

fn run_ps_text(script: &str, path: &Path, gui: bool) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut args = vec!["-NoProfile", "-STA"];
        if !gui {
            args.push("-NonInteractive");
        }
        args.extend(["-Command", script]);
        let output = std::process::Command::new("powershell")
            .args(&args)
            .env("FILEPAD_ITEM", path)
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|err| format!("Can't do that: {err}"))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let err = String::from_utf8_lossy(&output.stderr);
        let line = err
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.contains("CategoryInfo") && !line.contains("FullyQualifiedErrorId") && !line.starts_with('+') && !line.starts_with("At "))
            .unwrap_or("That didn't work.");
        return Err(line.to_string());
    }
    #[cfg(not(windows))]
    {
        let _ = (script, path, gui);
        Err("That works on Windows.".into())
    }
}

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn AllowSetForegroundWindow(dw_process_id: u32) -> i32;
}

const COPY_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$path = $env:FILEPAD_ITEM
if (-not (Test-Path -LiteralPath $path)) { throw "Can't find that item." }
$full = (Resolve-Path -LiteralPath $path).Path
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($full)
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
$ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
$images = '.png','.jpg','.jpeg','.bmp','.gif','.tif','.tiff','.webp','.ico','.heic','.heif'
if ($ext -in $images) {
  try {
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($full)
    $data.SetImage($img)
    $img.Dispose()
  } catch {}
}
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"#;

const IMAGE_CLIP_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = $env:FILEPAD_ITEM
if (-not (Test-Path -LiteralPath $path)) { throw "Can't find that item." }
$full = (Resolve-Path -LiteralPath $path).Path
$data = New-Object System.Windows.Forms.DataObject
$placed = $false
try {
  $img = [System.Drawing.Image]::FromFile($full)
  $data.SetImage($img)
  $img.Dispose()
  $placed = $true
} catch {}
if (-not $placed) {
  $files = New-Object System.Collections.Specialized.StringCollection
  [void]$files.Add($full)
  $data.SetFileDropList($files)
}
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"#;

const PRINT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$path = $env:FILEPAD_ITEM
if (-not (Test-Path -LiteralPath $path)) { throw "Can't find that item." }
$full = (Resolve-Path -LiteralPath $path).Path
$ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
$images = '.png','.jpg','.jpeg','.gif','.bmp','.tif','.tiff','.webp','.ico','.svg'
$texts = '.txt','.md','.markdown','.json','.jsonl','.log','.xml','.html','.htm','.css','.js','.jsx','.ts','.tsx','.rs','.py','.toml','.yaml','.yml','.ini','.php','.sh','.ps1','.bat','.cmd','.sql','.c','.h','.cpp','.hpp','.cs','.go','.java','.rb','.csv','.tsv'
$kind = if ($images -contains $ext) { 'image' } elseif ($texts -contains $ext) { 'text' } else { '' }
if (-not $kind) { throw "Open this file and print it from the app that opens it." }

$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.DocumentName = [IO.Path]::GetFileName($full)
$dialog = New-Object System.Windows.Forms.PrintDialog
$dialog.Document = $doc
$dialog.UseEXDialog = $true
$dialog.AllowPrintToFile = $true
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { 'cancelled'; exit 0 }

if ($kind -eq 'image') {
  try { $script:img = [System.Drawing.Image]::FromFile($full) }
  catch { throw "That picture can't be printed from here. Use Open, then print from the app that opens it." }
  $doc.add_PrintPage({
    param($sender, $e)
    $bounds = $e.MarginBounds
    $scale = [Math]::Min($bounds.Width / $script:img.Width, $bounds.Height / $script:img.Height)
    $w = [Math]::Max(1, [int]($script:img.Width * $scale))
    $h = [Math]::Max(1, [int]($script:img.Height * $scale))
    $x = $bounds.Left + [int](($bounds.Width - $w) / 2)
    $y = $bounds.Top + [int](($bounds.Height - $h) / 2)
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.FillRectangle([System.Drawing.Brushes]::White, $x, $y, $w, $h)
    $e.Graphics.DrawImage($script:img, $x, $y, $w, $h)
    $e.HasMorePages = $false
  })
  try { $doc.Print() } finally { $script:img.Dispose() }
} else {
  $bytes = [IO.File]::ReadAllBytes($full)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $script:text = [Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $script:text = [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  } else {
    $utf8 = New-Object Text.UTF8Encoding $false, $true
    try { $script:text = $utf8.GetString($bytes) } catch { $script:text = [Text.Encoding]::Default.GetString($bytes) }
  }
  $script:cursor = 0
  $script:font = New-Object System.Drawing.Font('Consolas', 10)
  $doc.add_BeginPrint({ $script:cursor = 0 })
  $doc.add_PrintPage({
    param($sender, $e)
    $bounds = $e.MarginBounds
    $rest = if ($script:cursor -lt $script:text.Length) { $script:text.Substring($script:cursor) } else { '' }
    if (-not $rest) { $e.HasMorePages = $false; return }
    $format = New-Object System.Drawing.StringFormat
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
    $format.Trimming = [System.Drawing.StringTrimming]::Word
    $layout = New-Object System.Drawing.SizeF($bounds.Width, $bounds.Height)
    $chars = 0
    $lines = 0
    [void]$e.Graphics.MeasureString($rest, $script:font, $layout, $format, [ref]$chars, [ref]$lines)
    if ($chars -lt 1) { $chars = [Math]::Min(1, $rest.Length) }
    if ($chars -gt $rest.Length) { $chars = $rest.Length }
    $page = $rest.Substring(0, $chars)
    $rect = New-Object System.Drawing.RectangleF($bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)
    $e.Graphics.DrawString($page, $script:font, [System.Drawing.Brushes]::Black, $rect, $format)
    $script:cursor += $chars
    $e.HasMorePages = $script:cursor -lt $script:text.Length
  })
  try { $doc.Print() } finally { $script:font.Dispose() }
}
'printed'
"#;

const EMAIL_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$path = $env:FILEPAD_ITEM
if (-not (Test-Path -LiteralPath $path)) { throw "Can't find that item." }
$full = (Resolve-Path -LiteralPath $path).Path
$send = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo\Mail Recipient.MAPIMail'
$sent = $false
if (Test-Path -LiteralPath $send) {
  try {
    Start-Process -FilePath $send -ArgumentList @($full) -ErrorAction Stop
    $sent = $true
  } catch {}
}
if ($sent) { 'mapi' } else {
  $name = [IO.Path]::GetFileName($full)
  Start-Process ('mailto:?subject=' + [uri]::EscapeDataString($name))
  'mailto'
}
"#;

pub fn rename_path(raw: &str, name: &str) -> Result<String, String> {
    if crate::sftpnav::is_remote(raw) {
        return crate::sftpnav::rename(raw, name);
    }
    if virtual_kind(raw).is_some() {
        return Err("Can't rename a file inside an archive. Copy it out first.".into());
    }
    let name = clean_name(name)?;
    let src = PathBuf::from(raw.trim());
    if protected(&src) {
        return Err("That folder can't be renamed.".into());
    }
    if !src.exists() {
        return Err("Can't find that item.".into());
    }
    let dest = src.parent().ok_or_else(|| "That folder can't be renamed.".to_string())?.join(name);
    if dest.exists() && !same_file(&src, &dest) {
        return Err("That name is already used.".into());
    }
    if src.file_name() == dest.file_name() {
        return Ok(friendly(&dest));
    }
    rename_many(&[RenameItem { path: friendly(&src), name: name.to_string() }])?;
    Ok(friendly(&dest))
}

#[derive(Deserialize)]
pub struct RenameItem {
    pub path: String,
    pub name: String,
}

pub fn rename_many(items: &[RenameItem]) -> Result<u64, String> {
    if items.is_empty() {
        return Err("Nothing selected.".into());
    }
    if items.iter().any(|item| crate::sftpnav::is_remote(&item.path)) {
        if items.iter().any(|item| !crate::sftpnav::is_remote(&item.path)) {
            return Err("Rename server files separately from local files.".into());
        }
        for item in items {
            crate::sftpnav::rename(&item.path, &item.name)?;
        }
        return Ok(items.len() as u64);
    }
    let mut jobs: Vec<(PathBuf, PathBuf)> = Vec::new();
    for item in items {
        if virtual_kind(&item.path).is_some() {
            return Err("Can't rename a file inside an archive. Copy it out first.".into());
        }
        let name = clean_name(&item.name)?.to_string();
        let src = PathBuf::from(item.path.trim());
        if protected(&src) {
            return Err("That folder can't be renamed.".into());
        }
        if !src.exists() {
            return Err(format!("Can't find {}", src.display()));
        }
        let dest = src.parent().ok_or_else(|| "That folder can't be renamed.".to_string())?.join(&name);
        if src.file_name() == dest.file_name() {
            continue;
        }
        jobs.push((src, dest));
    }
    for (index, (_, dest)) in jobs.iter().enumerate() {
        if jobs.iter().skip(index + 1).any(|(_, other)| same_file(dest, other)) {
            return Err("Two items would get the same name.".into());
        }
    }
    for (_, dest) in &jobs {
        if dest.exists() && !jobs.iter().any(|(src, _)| same_file(src, dest)) {
            let label = dest.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| dest.display().to_string());
            return Err(format!("{label} is already used."));
        }
    }
    let mut staged: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new();
    for (src, dest) in &jobs {
        let parent = src.parent().ok_or_else(|| "That folder can't be renamed.".to_string())?;
        let temp = fresh_temp(parent, staged.len());
        if let Err(err) = fs::rename(src, &temp) {
            restore_sources(&staged);
            return Err(format!("Can't rename: {err}"));
        }
        staged.push((temp, src.clone(), dest.clone()));
    }
    for index in 0..staged.len() {
        let (temp, _src, dest) = &staged[index];
        if let Err(err) = fs::rename(temp, dest) {
            for (done_temp, done_src, done_dest) in staged.iter().take(index).rev() {
                let _ = fs::rename(done_dest, done_src);
                let _ = done_temp;
            }
            for (temp, src, _) in staged.iter().skip(index) {
                let _ = fs::rename(temp, src);
            }
            return Err(format!("Can't rename: {err}"));
        }
    }
    Ok(jobs.len() as u64)
}

fn fresh_temp(parent: &Path, index: usize) -> PathBuf {
    let mut salt = index;
    loop {
        let path = parent.join(format!(".filepad-rename-{}-{salt}", std::process::id()));
        if !path.exists() {
            return path;
        }
        salt += 1;
    }
}

fn restore_sources(staged: &[(PathBuf, PathBuf, PathBuf)]) {
    for (temp, src, _) in staged.iter().rev() {
        let _ = fs::rename(temp, src);
    }
}

fn same_file(left: &Path, right: &Path) -> bool {
    normalize(left).to_string_lossy().eq_ignore_ascii_case(&normalize(right).to_string_lossy())
}

pub fn delete_paths(paths: &[String]) -> Result<u64, String> {
    if paths.is_empty() {
        return Err("Nothing selected.".into());
    }
    if paths.iter().any(|path| crate::sftpnav::is_remote(path)) {
        if paths.iter().any(|path| !crate::sftpnav::is_remote(path)) {
            return Err("Delete server files separately from local files.".into());
        }
        return crate::sftpnav::delete(paths);
    }
    if paths.iter().any(|path| virtual_kind(path).is_some()) {
        return Err("Can't delete files inside an archive.".into());
    }
    for raw in paths {
        let path = PathBuf::from(raw);
        if protected(&path) {
            return Err("That folder can't be deleted.".into());
        }
        delete_path(&path)?;
    }
    Ok(paths.len() as u64)
}

pub fn copy_paths(app: &AppHandle, sources: &[String], dest_dir: &str, overwrite: bool) -> Result<TransferResult, String> {
    if crate::sftpnav::is_remote(dest_dir) || sources.iter().any(|source| crate::sftpnav::is_remote(source)) {
        return crate::sftpnav::transfer(app, sources, dest_dir, overwrite, false);
    }
    if virtual_kind(dest_dir).is_some() {
        return Err("Can't add files to an archive.".into());
    }
    if sources.iter().any(|source| virtual_kind(source).is_some()) {
        if sources.iter().any(|source| virtual_kind(source).is_none()) || sources.iter().any(|source| virtual_kind(source) != virtual_kind(&sources[0])) {
            return Err("Copy archive contents separately from other files.".into());
        }
        let dest = resolve_dir(dest_dir)?;
        let mut report = |done, total, name: &str| emit(app, done, total, name);
        return if virtual_kind(&sources[0]) == Some("gz") {
            let copied = crate::gzipnav::extract(sources, &dest, overwrite, &mut report)?;
            Ok(TransferResult { done: copied.done, conflicts: copied.conflicts })
        } else {
            let copied = crate::zipnav::extract(sources, &dest, overwrite, &mut report)?;
            Ok(TransferResult { done: copied.done, conflicts: copied.conflicts })
        };
    }
    transfer(app, sources, dest_dir, overwrite, false)
}

pub fn move_paths(app: &AppHandle, sources: &[String], dest_dir: &str, overwrite: bool) -> Result<TransferResult, String> {
    if crate::sftpnav::is_remote(dest_dir) || sources.iter().any(|source| crate::sftpnav::is_remote(source)) {
        return crate::sftpnav::transfer(app, sources, dest_dir, overwrite, true);
    }
    if virtual_kind(dest_dir).is_some() {
        return Err("Can't add files to an archive.".into());
    }
    if sources.iter().any(|source| virtual_kind(source).is_some()) {
        return Err("Copy files out of an archive. The archive stays unchanged.".into());
    }
    transfer(app, sources, dest_dir, overwrite, true)
}

pub fn textpad_available() -> bool {
    textpad_path().is_some()
}

pub fn open_in_textpad(file: &str) -> Result<(), String> {
    let exe = textpad_path().ok_or_else(|| "TextPad isn't installed.".to_string())?;
    let path = if crate::sftpnav::is_remote(file) { PathBuf::from(crate::sftpnav::export_temp(file)?) } else { materialize(file)? };
    std::process::Command::new(&exe)
        .arg(&path)
        .spawn()
        .map_err(|err| format!("Can't open TextPad: {err}"))?;
    Ok(())
}

pub fn open_item(raw: &str) -> Result<(), String> {
    let path = if crate::sftpnav::is_remote(raw) { PathBuf::from(crate::sftpnav::export_temp(raw)?) } else { materialize(raw)? };
    // ShellExecute uses the type's default action. The other opener launches
    // Explorer, which only selects some types instead of opening them.
    #[cfg(windows)]
    unsafe {
        AllowSetForegroundWindow(0xFFFF_FFFF);
    }
    open::that_detached(&path).map_err(|err| format!("Can't open that file: {err}"))?;
    Ok(())
}

pub fn extract_archives(app: &AppHandle, archives: &[String], dest_dir: &str) -> Result<Vec<String>, String> {
    if archives.is_empty() {
        return Err("Nothing selected.".into());
    }
    let dest_root = resolve_dir(dest_dir)?;
    let mut made = Vec::new();
    for raw in archives {
        if virtual_kind(raw).is_some() {
            return Err("Pick the archive file itself to extract all of it.".into());
        }
        let archive = PathBuf::from(raw.trim());
        let gzip = archive.is_file() && crate::gzipnav::is_gz_file(&archive);
        if !archive.is_file() || (!crate::zipnav::is_zip_file(&archive) && !gzip) {
            return Err("Choose a zip or gzip file.".into());
        }
        let stem = archive.file_stem().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "archive".into());
        let folder = fresh_folder(&dest_root, &stem);
        fs::create_dir(&folder).map_err(|err| format!("Can't create the folder: {err}"))?;
        let prefix = if gzip { "gz" } else { "zip" };
        let token = format!("{prefix}:{}|", friendly(&archive));
        let extracted = if gzip {
            crate::gzipnav::extract(&[token], &folder, true, &mut |done, total, name| emit(app, done, total, name)).map(|copied| copied.done)
        } else {
            crate::zipnav::extract(&[token], &folder, true, &mut |done, total, name| emit(app, done, total, name)).map(|copied| copied.done)
        };
        match extracted {
            Ok(0) => {
                let _ = fs::remove_dir_all(&folder);
                return Err("That archive has no files.".into());
            }
            Ok(_) => made.push(friendly(&folder)),
            Err(err) => {
                let _ = fs::remove_dir_all(&folder);
                return Err(err);
            }
        }
    }
    Ok(made)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetails {
    pub name: String,
    pub path: String,
    pub location: String,
    pub kind: String,
    pub is_dir: bool,
    pub size: u64,
    pub size_known: bool,
    pub modified: u64,
    pub created: u64,
    pub accessed: u64,
    pub hidden: bool,
    pub read_only: bool,
    pub files: u64,
    pub folders: u64,
    pub counted: bool,
}

pub fn describe_items(paths: &[String]) -> Result<Vec<ItemDetails>, String> {
    if paths.is_empty() {
        return Err("Nothing selected.".into());
    }
    paths.iter().map(|path| describe_one(path)).collect()
}

fn describe_one(raw: &str) -> Result<ItemDetails, String> {
    if crate::sftpnav::is_remote(raw) {
        return crate::sftpnav::describe(raw);
    }
    if let Some((archive, inner)) = crate::zipnav::split(raw) {
        return describe_zip(&archive, &inner, raw.trim());
    }
    if let Some((archive, inner)) = crate::gzipnav::split(raw) {
        return describe_gz(&archive, &inner, raw.trim());
    }
    let path = PathBuf::from(raw.trim());
    let meta = fs::symlink_metadata(&path).map_err(|_| "Can't find that item.".to_string())?;
    let name = path.file_name().map(|item| item.to_string_lossy().to_string()).unwrap_or_else(|| friendly(&path));
    let is_dir = meta.is_dir();
    let extension = if is_dir { String::new() } else { path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase() };
    let mut files = 0u64;
    let mut folders = 0u64;
    if is_dir {
        if let Ok(read) = fs::read_dir(&path) {
            for item in read.flatten() {
                match item.file_type() {
                    Ok(kind) if kind.is_dir() => folders += 1,
                    Ok(_) => files += 1,
                    Err(_) => {}
                }
            }
        }
    }
    let mut kind = kind_label(is_dir, &extension);
    let mut counted = is_dir;
    if !is_dir && crate::zipnav::is_zip_file(&path) {
        if let Ok(stat) = crate::zipnav::stat(&path, "") {
            files = stat.files;
            counted = true;
        }
        kind = "Zip archive".into();
    }
    if !is_dir && crate::gzipnav::is_gz_file(&path) {
        if let Ok(stat) = crate::gzipnav::stat(&path, "") {
            files = stat.files;
            folders = stat.folders;
            counted = true;
        }
        kind = "Gzip archive".into();
    }
    Ok(ItemDetails {
        location: path.parent().map(friendly).unwrap_or_default(),
        path: friendly(&path),
        name: name.clone(),
        kind,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        size_known: !is_dir,
        modified: modified_ms(&meta),
        created: time_ms(meta.created()),
        accessed: time_ms(meta.accessed()),
        hidden: is_hidden(&meta, &name),
        read_only: is_readonly(&meta),
        files,
        folders,
        counted,
    })
}

fn describe_zip(archive: &Path, inner: &str, raw: &str) -> Result<ItemDetails, String> {
    let stat = crate::zipnav::stat(archive, inner)?;
    let archive_text = friendly(archive);
    let location = if inner.is_empty() {
        archive.parent().map(friendly).unwrap_or_default()
    } else {
        let parent = inner.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
        if parent.is_empty() { archive_text.clone() } else { format!("{archive_text}\\{}", parent.replace('/', "\\")) }
    };
    let path = if inner.is_empty() { archive_text } else { raw.to_string() };
    Ok(ItemDetails {
        name: stat.name,
        path,
        location,
        kind: if inner.is_empty() { "Zip archive".into() } else { kind_label(stat.is_dir, &stat.extension) },
        is_dir: stat.is_dir || inner.is_empty(),
        size: if inner.is_empty() { fs::metadata(archive).map(|meta| meta.len()).unwrap_or(0) } else { stat.size },
        size_known: inner.is_empty() || !stat.is_dir,
        modified: if inner.is_empty() { fs::metadata(archive).ok().map(|meta| modified_ms(&meta)).unwrap_or(0) } else { stat.modified },
        created: if inner.is_empty() { fs::metadata(archive).ok().and_then(|meta| meta.created().ok()).map(|time| time_ms(Ok(time))).unwrap_or(0) } else { 0 },
        accessed: 0,
        hidden: false,
        read_only: false,
        files: stat.files,
        folders: stat.folders,
        counted: stat.is_dir || inner.is_empty(),
    })
}

fn describe_gz(archive: &Path, inner: &str, raw: &str) -> Result<ItemDetails, String> {
    let stat = crate::gzipnav::stat(archive, inner)?;
    let archive_text = friendly(archive);
    let location = if inner.is_empty() {
        archive.parent().map(friendly).unwrap_or_default()
    } else {
        let parent = inner.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
        if parent.is_empty() { archive_text.clone() } else { format!("{archive_text}\\{}", parent.replace('/', "\\")) }
    };
    let path = if inner.is_empty() { archive_text } else { raw.to_string() };
    Ok(ItemDetails {
        name: stat.name,
        path,
        location,
        kind: if inner.is_empty() { "Gzip archive".into() } else { kind_label(stat.is_dir, &stat.extension) },
        is_dir: stat.is_dir || inner.is_empty(),
        size: if inner.is_empty() { fs::metadata(archive).map(|meta| meta.len()).unwrap_or(0) } else { stat.size },
        size_known: inner.is_empty() || !stat.is_dir,
        modified: if inner.is_empty() { fs::metadata(archive).ok().map(|meta| modified_ms(&meta)).unwrap_or(0) } else { stat.modified },
        created: if inner.is_empty() { fs::metadata(archive).ok().and_then(|meta| meta.created().ok()).map(|time| time_ms(Ok(time))).unwrap_or(0) } else { 0 },
        accessed: 0,
        hidden: false,
        read_only: false,
        files: stat.files,
        folders: stat.folders,
        counted: stat.is_dir || inner.is_empty(),
    })
}

pub(crate) fn kind_label(is_dir: bool, extension: &str) -> String {
    if is_dir {
        return "Folder".into();
    }
    match extension {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" => "Picture".into(),
        "pdf" => "PDF document".into(),
        "doc" | "docx" | "odt" => "Word document".into(),
        "xls" | "xlsx" => "Excel workbook".into(),
        "ppt" | "pptx" | "pps" | "ppsx" => "PowerPoint presentation".into(),
        "pot" | "potx" => "PowerPoint template".into(),
        "mp3" | "wav" | "ogg" | "flac" | "m4a" | "aac" => "Audio".into(),
        "mp4" | "mov" | "mkv" | "webm" | "m4v" => "Video".into(),
        "zip" => "Zip archive".into(),
        "gz" | "gzip" | "tgz" => "Gzip archive".into(),
        "txt" | "md" | "markdown" | "log" => "Text".into(),
        "" => "File".into(),
        other => format!("{} file", other.to_ascii_uppercase()),
    }
}

fn time_ms(time: Result<std::time::SystemTime, std::io::Error>) -> u64 {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

fn is_readonly(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return (meta.file_attributes() & 1) != 0;
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

fn fresh_folder(parent: &Path, stem: &str) -> PathBuf {
    let cleaned: String = stem
        .chars()
        .map(|ch| if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() { '_' } else { ch })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let base = if cleaned.is_empty() { "archive" } else { cleaned };
    let mut candidate = parent.join(base);
    let mut index = 2u32;
    while candidate.exists() && index < 10_000 {
        candidate = parent.join(format!("{base}_{index}"));
        index += 1;
    }
    candidate
}

fn transfer(app: &AppHandle, sources: &[String], dest_dir: &str, overwrite: bool, relocate: bool) -> Result<TransferResult, String> {
    if sources.is_empty() {
        return Err("Nothing selected.".into());
    }
    let dest_dir = resolve_dir(dest_dir)?;
    let sources: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    for src in &sources {
        if protected(src) {
            return Err("That folder can't be changed.".into());
        }
        if !src.exists() {
            return Err(format!("Can't find {}", src.display()));
        }
        let Some(name) = src.file_name() else {
            return Err("That folder can't be changed.".into());
        };
        let target = dest_dir.join(name);
        if paths_equal(src, &target) || path_inside(src, &dest_dir) {
            return Err("Can't put a folder inside itself.".into());
        }
    }
    let conflicts: Vec<String> = sources
        .iter()
        .filter_map(|src| {
            let name = src.file_name()?.to_string_lossy().to_string();
            if dest_dir.join(&name).exists() { Some(name) } else { None }
        })
        .collect();
    if !conflicts.is_empty() && !overwrite {
        return Ok(TransferResult { done: 0, conflicts });
    }
    let total: u64 = sources.iter().map(|src| count_items(src)).sum();
    let mut done = 0u64;
    emit(app, done, total, "Starting");
    for src in &sources {
        let name = src.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let target = dest_dir.join(&name);
        if relocate {
            move_one(app, src, &target, &mut done, total)?;
        } else {
            copy_one(app, src, &target, &mut done, total)?;
        }
    }
    Ok(TransferResult { done, conflicts: Vec::new() })
}

fn copy_one(app: &AppHandle, src: &Path, dest: &Path, done: &mut u64, total: u64) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|err| format!("Can't read {}: {err}", src.display()))?;
    if meta.file_type().is_symlink() {
        if src.is_file() {
            return copy_file(app, src, dest, done, total);
        }
        return Err(format!("Skipped linked folder {}", src.display()));
    }
    if meta.is_dir() {
        if dest.is_file() {
            fs::remove_file(dest).map_err(|err| format!("Can't replace {}: {err}", dest.display()))?;
        }
        fs::create_dir_all(dest).map_err(|err| format!("Can't create {}: {err}", dest.display()))?;
        for item in fs::read_dir(src).map_err(|err| format!("Can't read {}: {err}", src.display()))? {
            let item = item.map_err(|err| err.to_string())?;
            copy_one(app, &item.path(), &dest.join(item.file_name()), done, total)?;
        }
        return Ok(());
    }
    copy_file(app, src, dest, done, total)
}

fn copy_file(app: &AppHandle, src: &Path, dest: &Path, done: &mut u64, total: u64) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let label = dest.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    emit(app, *done, total, &label);
    fs::copy(src, dest).map_err(|err| format!("Can't copy {}: {err}", src.display()))?;
    *done += 1;
    emit(app, *done, total, &label);
    Ok(())
}

fn move_one(app: &AppHandle, src: &Path, dest: &Path, done: &mut u64, total: u64) -> Result<(), String> {
    let items = count_items(src);
    if !dest.exists() && fs::rename(src, dest).is_ok() {
        *done += items;
        let label = dest.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        emit(app, *done, total, &label);
        return Ok(());
    }
    copy_one(app, src, dest, done, total)?;
    delete_path(src)?;
    Ok(())
}

fn delete_path(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_err() {
        return Err(format!("Can't delete {}.", path.display()));
    }
    #[cfg(windows)]
    {
        recycle(path)
    }
    #[cfg(not(windows))]
    {
        let meta = fs::symlink_metadata(path).map_err(|err| format!("Can't delete {}: {err}", path.display()))?;
        let result = if meta.is_dir() && !meta.file_type().is_symlink() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        result.map_err(|err| format!("Can't delete {}: {err}", path.display()))
    }
}

#[cfg(windows)]
fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FO_DELETE, SHFILEOPSTRUCTW, SHFileOperationW};

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    wide.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: windows::Win32::Foundation::HWND(std::ptr::null_mut()),
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(wide.as_ptr()),
        pTo: windows::core::PCWSTR(std::ptr::null()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0) as u16,
        fAnyOperationsAborted: windows::core::BOOL(0),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: windows::core::PCWSTR(std::ptr::null()),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.fAnyOperationsAborted.0 != 0 {
        return Err(format!("Can't move {} to the Recycle Bin.", path.display()));
    }
    Ok(())
}

fn count_items(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 1 };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return 1;
    }
    let Ok(read) = fs::read_dir(path) else { return 0 };
    read.flatten().map(|item| count_items(&item.path())).sum()
}

fn emit(app: &AppHandle, done: u64, total: u64, current: &str) {
    let _ = app.emit("transfer-progress", TransferProgress { done, total, current: current.to_string() });
}

fn resolve_dir(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let path = if trimmed.is_empty() { PathBuf::from(home_dir()) } else { PathBuf::from(trimmed) };
    if !path.exists() {
        return Err(format!("Can't find {}", path.display()));
    }
    let path = path.canonicalize().unwrap_or(path);
    let path = PathBuf::from(friendly(&path));
    if !path.is_dir() {
        return Err("That path is not a folder.".into());
    }
    Ok(path)
}

fn clean_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let name = name.trim_end_matches(['.', ' ']);
    let illegal = name.chars().any(|ch| matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control());
    if name.is_empty() || name == "." || name == ".." || illegal {
        return Err("That name has a character Windows won't allow.".into());
    }
    Ok(name)
}

fn protected(path: &Path) -> bool {
    path.file_name().is_none()
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    normalize(left) == normalize(right)
}

fn path_inside(parent: &Path, child: &Path) -> bool {
    let parent = normalize(parent);
    let child = normalize(child);
    child.starts_with(&parent) && child != parent
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn friendly(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn modified_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

fn is_hidden(meta: &Metadata, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return (meta.file_attributes() & 2) != 0;
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

fn textpad_path() -> Option<PathBuf> {
    let mut found = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        found.push(PathBuf::from(local).join("TextPad").join("textpad.exe"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        found.push(home.join("TextPad").join("src-tauri").join("target").join("release").join("textpad.exe"));
        found.push(home.join("TextPad").join("src-tauri").join("target").join("debug").join("textpad.exe"));
    }
    found.into_iter().find(|path| path.is_file())
}

#[cfg(windows)]
fn drives() -> Vec<Place> {
    use std::os::windows::ffi::OsStrExt;
    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let path = format!("{letter}:\\");
        let wide: Vec<u16> = std::ffi::OsStr::new(&path).encode_wide().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if !(2..=6).contains(&kind) {
            continue;
        }
        let label = if kind == 2 || kind == 3 || kind == 6 { volume_label(&path) } else { String::new() };
        let role = match kind {
            2 => "removable",
            4 => "remote",
            5 => "cd",
            6 => "ram",
            _ => "fixed",
        };
        drives.push(Place { name: drive_title(letter, kind, &label), path, kind: "drive".into(), role: role.into() });
    }
    drives
}

#[cfg(windows)]
fn volume_label(root: &str) -> String {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = std::ffi::OsStr::new(root).encode_wide().chain(std::iter::once(0)).collect();
    let mut name = [0u16; 261];
    let ok = unsafe {
        GetVolumeInformationW(wide.as_ptr(), name.as_mut_ptr(), name.len() as u32, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0)
    };
    if ok == 0 {
        return String::new();
    }
    let end = name.iter().position(|unit| *unit == 0).unwrap_or(name.len());
    String::from_utf16_lossy(&name[..end]).trim().to_string()
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetVolumeInformationW(root: *const u16, name: *mut u16, name_len: u32, serial: *mut u32, max_component: *mut u32, flags: *mut u32, fs: *mut u16, fs_len: u32) -> i32;
}

fn drive_title(letter: char, kind: u32, label: &str) -> String {
    let label = label.trim();
    if !label.is_empty() {
        return format!("{label} ({letter}:)");
    }
    let fallback = match kind {
        2 => "Removable",
        3 => "Local Disk",
        4 => "Network",
        5 => "CD Drive",
        6 => "RAM Disk",
        _ => "Drive",
    };
    format!("{fallback} ({letter}:)")
}

#[cfg(not(windows))]
fn drives() -> Vec<Place> {
    vec![Place { name: "Root".into(), path: "/".into(), kind: "drive".into(), role: "fixed".into() }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(friendly(Path::new(r"\\?\C:\Users")), r"C:\Users");
    }

    #[test]
    fn drive_root_is_protected() {
        assert!(protected(Path::new(r"C:\")));
        assert!(!protected(Path::new(r"C:\Users")));
    }

    #[test]
    fn drive_names_include_the_letter() {
        assert_eq!(drive_title('C', 3, "Windows"), "Windows (C:)");
        assert_eq!(drive_title('D', 3, ""), "Local Disk (D:)");
        assert_eq!(drive_title('E', 5, ""), "CD Drive (E:)");
    }

    #[test]
    fn folder_is_not_inside_a_sibling() {
        assert!(!path_inside(Path::new(r"C:\data"), Path::new(r"C:\database")));
        assert!(path_inside(Path::new(r"C:\data"), Path::new(r"C:\data\notes")));
    }

    #[test]
    fn renames_a_batch_without_clobbering() {
        let dir = std::env::temp_dir().join(format!("filepad-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), b"aaa").unwrap();
        fs::write(dir.join("b.txt"), b"bbb").unwrap();
        let count = rename_many(&[
            RenameItem { path: dir.join("a.txt").display().to_string(), name: "b.txt".into() },
            RenameItem { path: dir.join("b.txt").display().to_string(), name: "c.txt".into() },
        ])
        .unwrap();
        assert_eq!(count, 2);
        assert_eq!(fs::read(dir.join("b.txt")).unwrap(), b"aaa");
        assert_eq!(fs::read(dir.join("c.txt")).unwrap(), b"bbb");
        assert!(!dir.join("a.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
