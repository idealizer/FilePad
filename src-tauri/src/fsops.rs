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
    places.push(Place { name: "Home".into(), path: friendly(&home), kind: "place".into() });
    for (name, folder) in [("Desktop", "Desktop"), ("Documents", "Documents"), ("Downloads", "Downloads")] {
        let path = home.join(folder);
        if path.is_dir() {
            places.push(Place { name: name.into(), path: friendly(&path), kind: "place".into() });
        }
    }
    places.extend(drives());
    places
}

pub fn list_dir(raw: &str) -> Result<DirListing, String> {
    if let Some((archive, inner)) = crate::zipnav::split(raw) {
        return zip_listing(&archive, &inner);
    }
    let direct = PathBuf::from(raw.trim());
    if direct.is_file() && crate::zipnav::is_zip_file(&direct) {
        return zip_listing(&direct, "");
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

pub fn make_dir(parent: &str, name: &str) -> Result<String, String> {
    if parent.trim().starts_with("zip:") {
        return Err("Can't create a folder inside a zip.".into());
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

pub fn rename_path(raw: &str, name: &str) -> Result<String, String> {
    if raw.trim().starts_with("zip:") {
        return Err("Can't rename a file inside a zip. Copy it out first.".into());
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
    let mut jobs: Vec<(PathBuf, PathBuf)> = Vec::new();
    for item in items {
        if item.path.trim().starts_with("zip:") {
            return Err("Can't rename a file inside a zip. Copy it out first.".into());
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
    if paths.iter().any(|path| path.starts_with("zip:")) {
        return Err("Can't delete files inside a zip.".into());
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
    if dest_dir.trim().starts_with("zip:") {
        return Err("Can't add files to a zip.".into());
    }
    if sources.iter().any(|source| source.starts_with("zip:")) {
        if sources.iter().any(|source| !source.starts_with("zip:")) {
            return Err("Copy zip contents separately from other files.".into());
        }
        let dest = resolve_dir(dest_dir)?;
        let copied = crate::zipnav::extract(sources, &dest, overwrite, &mut |done, total, name| emit(app, done, total, name))?;
        return Ok(TransferResult { done: copied.done, conflicts: copied.conflicts });
    }
    transfer(app, sources, dest_dir, overwrite, false)
}

pub fn move_paths(app: &AppHandle, sources: &[String], dest_dir: &str, overwrite: bool) -> Result<TransferResult, String> {
    if dest_dir.trim().starts_with("zip:") {
        return Err("Can't add files to a zip.".into());
    }
    if sources.iter().any(|source| source.starts_with("zip:")) {
        return Err("Copy files out of a zip. The archive stays unchanged.".into());
    }
    transfer(app, sources, dest_dir, overwrite, true)
}

pub fn textpad_available() -> bool {
    textpad_path().is_some()
}

pub fn open_in_textpad(file: &str) -> Result<(), String> {
    let exe = textpad_path().ok_or_else(|| "TextPad isn't installed.".to_string())?;
    std::process::Command::new(exe)
        .arg(file)
        .spawn()
        .map_err(|err| format!("Can't open TextPad: {err}"))?;
    Ok(())
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
    let meta = fs::symlink_metadata(path).map_err(|err| format!("Can't delete {}: {err}", path.display()))?;
    let result = if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|err| format!("Can't delete {}: {err}", path.display()))
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
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let home = PathBuf::from(home);
    for rel in ["TextPad/src-tauri/target/debug/textpad.exe", "TextPad/src-tauri/target/release/textpad.exe"] {
        let path = home.join(rel);
        if path.is_file() {
            return Some(path);
        }
    }
    None
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
        drives.push(Place { name: drive_title(letter, kind, &label), path, kind: "drive".into() });
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
    vec![Place { name: "Root".into(), path: "/".into(), kind: "drive".into() }]
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
