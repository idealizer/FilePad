use flate2::read::GzDecoder;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_INFLATE: u64 = 4 * 1024 * 1024 * 1024;

pub struct GzEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub extension: String,
    pub hidden: bool,
}

pub struct GzListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<GzEntry>,
}

pub struct GzPayload {
    pub name: String,
    pub size: u64,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

pub struct GzCopy {
    pub done: u64,
    pub conflicts: Vec<String>,
}

pub struct GzStat {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub extension: String,
    pub files: u64,
    pub folders: u64,
}

struct Member {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

pub fn split(raw: &str) -> Option<(PathBuf, String)> {
    let rest = raw.trim().strip_prefix("gz:")?;
    let (archive, inner) = rest.split_once('|')?;
    if archive.is_empty() {
        return None;
    }
    Some((PathBuf::from(archive), normalize(inner)))
}

pub fn is_gz_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    let name = name.to_ascii_lowercase();
    name.ends_with(".gz") || name.ends_with(".gzip") || name.ends_with(".tgz")
}

pub fn list(archive: &Path, inner: &str) -> Result<GzListing, String> {
    if !archive.is_file() {
        return Err("Can't open that archive.".into());
    }
    let inner = normalize(inner);
    let members = members(archive)?;
    let mut children: BTreeMap<String, GzEntry> = BTreeMap::new();
    for member in &members {
        let Some(rest) = rest_inside(&member.name, &inner) else { continue };
        if rest.is_empty() {
            continue;
        }
        let (child, nested) = match rest.split_once('/') {
            Some((head, _)) => (head.to_string(), true),
            None => (rest, false),
        };
        if child.is_empty() || child == "." || child == ".." {
            continue;
        }
        let is_dir = nested || member.is_dir;
        let child_inner = if inner.is_empty() { child.clone() } else { format!("{inner}/{child}") };
        let path = token(archive, &child_inner);
        if let Some(existing) = children.get_mut(&child) {
            if is_dir && !existing.is_dir {
                existing.is_dir = true;
                existing.size = 0;
                existing.extension.clear();
                existing.path = path;
            }
            continue;
        }
        let extension = if is_dir {
            String::new()
        } else {
            Path::new(&child).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
        };
        children.insert(
            child.clone(),
            GzEntry {
                name: child.clone(),
                path,
                is_dir,
                size: if is_dir { 0 } else { member.size },
                modified: member.modified,
                extension,
                hidden: child.starts_with('.'),
            },
        );
    }
    if children.is_empty() && !inner.is_empty() && !members.iter().any(|member| member.name == inner || member.name.starts_with(&format!("{inner}/"))) {
        return Err("Can't find that folder in the archive.".into());
    }
    Ok(GzListing {
        path: token(archive, &inner),
        parent: parent_of(archive, &inner),
        entries: children.into_values().collect(),
    })
}

pub fn read(archive: &Path, inner: &str, limit: u64, partial: bool) -> Result<GzPayload, String> {
    let inner = normalize(inner);
    if inner.is_empty() {
        return Err("Choose a file.".into());
    }
    if is_tar_name(archive) || sniff_tar(archive) {
        return read_tar(archive, &inner, limit, partial);
    }
    read_single(archive, &inner, limit, partial)
}

pub fn export_temp(raw: &str) -> Result<String, String> {
    let (archive, inner) = split(raw).ok_or_else(|| "That is not inside an archive.".to_string())?;
    if inner.is_empty() {
        return Err("Choose a file.".into());
    }
    let leaf = safe_leaf(inner.rsplit('/').next().unwrap_or(&inner));
    let dir = std::env::temp_dir().join("FilePadOpen");
    fs::create_dir_all(&dir).map_err(|err| format!("Can't open that file: {err}"))?;
    let dest = dir.join(leaf);
    copy_member(&archive, &inner, &dest)?;
    Ok(plain(&dest))
}

pub fn extract(sources: &[String], dest_dir: &Path, overwrite: bool, progress: &mut dyn FnMut(u64, u64, &str)) -> Result<GzCopy, String> {
    if sources.is_empty() {
        return Err("Nothing selected.".into());
    }
    let mut jobs = Vec::new();
    for source in sources {
        let (archive, inner) = split(source).ok_or_else(|| "Copy archive contents separately from other files.".to_string())?;
        let leaf = inner.rsplit('/').next().unwrap_or(&inner).to_string();
        jobs.push((archive, inner, leaf));
    }
    let mut conflicts = Vec::new();
    for (_, _, leaf) in &jobs {
        if leaf.is_empty() {
            continue;
        }
        if dest_dir.join(leaf).exists() {
            conflicts.push(leaf.clone());
        }
    }
    if !conflicts.is_empty() && !overwrite {
        return Ok(GzCopy { done: 0, conflicts });
    }
    let mut planned: BTreeMap<PathBuf, Vec<(String, PathBuf)>> = BTreeMap::new();
    for (archive, inner, _) in &jobs {
        planned.entry(archive.clone()).or_default().extend(matching(archive, inner)?);
    }
    let total: u64 = planned.values().map(|files| files.len() as u64).sum();
    if total == 0 {
        return Err("That archive is empty.".into());
    }
    progress(0, total, "Starting");
    let mut done = 0u64;
    for (archive, files) in planned {
        write_members(&archive, &files, dest_dir, &mut done, total, progress)?;
    }
    Ok(GzCopy { done, conflicts: Vec::new() })
}

fn write_members(archive: &Path, files: &[(String, PathBuf)], dest_dir: &Path, done: &mut u64, total: u64, progress: &mut dyn FnMut(u64, u64, &str)) -> Result<(), String> {
    if is_tar_name(archive) || sniff_tar(archive) {
        return write_tar(archive, files, dest_dir, done, total, progress);
    }
    for (name, relative) in files {
        let dest = dest_dir.join(relative);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("Can't copy: {err}"))?;
        }
        copy_single(archive, name, &dest)?;
        *done += 1;
        let label = relative.file_name().map(|item| item.to_string_lossy().to_string()).unwrap_or_default();
        progress(*done, total, &label);
    }
    Ok(())
}

fn write_tar(archive: &Path, files: &[(String, PathBuf)], dest_dir: &Path, done: &mut u64, total: u64, progress: &mut dyn FnMut(u64, u64, &str)) -> Result<(), String> {
    let wanted: BTreeMap<&str, &Path> = files.iter().map(|(name, relative)| (name.as_str(), relative.as_path())).collect();
    let mut tar = tar::Archive::new(capped(open_gz(archive)?, true)?);
    let entries = tar.entries().map_err(|err| format!("Can't read that archive: {err}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|err| format!("Can't read that archive: {err}"))?;
        let raw = entry.path().map_err(|err| format!("Can't read that archive: {err}"))?.to_string_lossy().to_string();
        let name = normalize(&raw);
        let Some(relative) = wanted.get(name.as_str()) else { continue };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let dest = dest_dir.join(relative);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("Can't copy: {err}"))?;
        }
        let mut out = File::create(&dest).map_err(|err| format!("Can't copy: {err}"))?;
        io::copy(&mut entry, &mut out).map_err(|err| format!("Can't copy: {err}"))?;
        *done += 1;
        let label = relative.file_name().map(|item| item.to_string_lossy().to_string()).unwrap_or_default();
        progress(*done, total, &label);
    }
    Ok(())
}

pub fn stat(archive: &Path, inner: &str) -> Result<GzStat, String> {
    let inner = normalize(inner);
    let rows = members(archive)?;
    if inner.is_empty() {
        let name = archive.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "archive.gz".into());
        let files = rows.iter().filter(|row| !row.is_dir).count() as u64;
        let folders = rows.iter().filter(|row| row.is_dir).count() as u64;
        return Ok(GzStat { name, is_dir: true, size: 0, modified: 0, extension: "gz".into(), files, folders });
    }
    if let Some(found) = rows.iter().find(|row| row.name == inner) {
        if !found.is_dir {
            let name = inner.rsplit('/').next().unwrap_or(&inner).to_string();
            let extension = Path::new(&name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
            return Ok(GzStat { name, is_dir: false, size: found.size, modified: found.modified, extension, files: 0, folders: 0 });
        }
    }
    let prefix = format!("{inner}/");
    if rows.iter().any(|row| row.name == inner || row.name.starts_with(&prefix)) {
        let name = inner.rsplit('/').next().unwrap_or(&inner).to_string();
        let mut files = 0u64;
        let mut folders = std::collections::BTreeSet::new();
        for row in &rows {
            let Some(rest) = row.name.strip_prefix(&prefix) else { continue };
            if rest.is_empty() {
                continue;
            }
            if row.is_dir || rest.contains('/') {
                if let Some(child) = rest.split('/').next() {
                    if !child.is_empty() {
                        folders.insert(child.to_string());
                    }
                }
            } else {
                files += 1;
            }
        }
        return Ok(GzStat { name, is_dir: true, size: 0, modified: 0, extension: String::new(), files, folders: folders.len() as u64 });
    }
    Err("Can't find that item in the archive.".into())
}

fn matching(archive: &Path, inner: &str) -> Result<Vec<(String, PathBuf)>, String> {
    let mut files = Vec::new();
    for member in members(archive)? {
        if member.is_dir {
            continue;
        }
        let Some(relative) = output_relative(&member.name, inner) else { continue };
        files.push((member.name, relative));
    }
    if files.is_empty() {
        return Err("Can't find that item in the archive.".into());
    }
    Ok(files)
}

fn copy_member(archive: &Path, inner: &str, dest: &Path) -> Result<(), String> {
    if is_tar_name(archive) || sniff_tar(archive) {
        return copy_tar(archive, inner, dest);
    }
    let (name, _) = member_meta(archive);
    if normalize(&name) != normalize(inner) {
        return Err("Can't find that file in the archive.".into());
    }
    copy_single(archive, inner, dest)
}

fn copy_single(archive: &Path, inner: &str, dest: &Path) -> Result<(), String> {
    let (name, _) = member_meta(archive);
    if normalize(&name) != normalize(inner) {
        return Err("Can't find that file in the archive.".into());
    }
    let mut input = capped(open_gz(archive)?, true)?;
    let mut out = File::create(dest).map_err(|err| format!("Can't copy: {err}"))?;
    io::copy(&mut input, &mut out).map_err(|err| format!("Can't copy: {err}"))?;
    if input.hit {
        let _ = fs::remove_file(dest);
        return Err("That archive is too large to open.".into());
    }
    Ok(())
}

fn copy_tar(archive: &Path, inner: &str, dest: &Path) -> Result<(), String> {
    let mut tar = tar::Archive::new(capped(open_gz(archive)?, true)?);
    let entries = tar.entries().map_err(|err| format!("Can't read that archive: {err}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|err| format!("Can't read that archive: {err}"))?;
        let raw = entry.path().map_err(|err| format!("Can't read that archive: {err}"))?.to_string_lossy().to_string();
        if normalize(&raw) != normalize(inner) {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err("Choose a file.".into());
        }
        let mut out = File::create(dest).map_err(|err| format!("Can't copy: {err}"))?;
        io::copy(&mut entry, &mut out).map_err(|err| format!("Can't copy: {err}"))?;
        return Ok(());
    }
    Err("Can't find that file in the archive.".into())
}

fn read_single(archive: &Path, inner: &str, limit: u64, partial: bool) -> Result<GzPayload, String> {
    let (name, _) = member_meta(archive);
    if normalize(&name) != inner {
        return Err("Can't find that file in the archive.".into());
    }
    let declared = isize_of(archive);
    if declared > limit && !partial {
        return Ok(GzPayload { name, size: declared, bytes: Vec::new(), truncated: true });
    }
    let mut input = capped(open_gz(archive)?, false)?;
    let mut bytes = Vec::new();
    input.by_ref().take(limit).read_to_end(&mut bytes).map_err(|err| format!("Can't read that archive: {err}"))?;
    let mut extra = [0u8; 1];
    let more = input.read(&mut extra).unwrap_or(0) > 0;
    let truncated = more || input.hit;
    let size = if truncated { declared.max(bytes.len() as u64 + 1) } else { bytes.len() as u64 };
    Ok(GzPayload { name, size, bytes, truncated })
}

fn read_tar(archive: &Path, inner: &str, limit: u64, partial: bool) -> Result<GzPayload, String> {
    let mut tar = tar::Archive::new(capped(open_gz(archive)?, false)?);
    let entries = tar.entries().map_err(|err| format!("Can't read that archive: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("Can't read that archive: {err}"))?;
        let raw = entry.path().map_err(|err| format!("Can't read that archive: {err}"))?.to_string_lossy().to_string();
        let name = normalize(&raw);
        if name != inner {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err("Choose a file.".into());
        }
        let size = entry.size();
        let leaf = name.rsplit('/').next().unwrap_or(&name).to_string();
        if size > limit && !partial {
            return Ok(GzPayload { name: leaf, size, bytes: Vec::new(), truncated: true });
        }
        let mut bytes = Vec::new();
        entry.take(limit).read_to_end(&mut bytes).map_err(|err| format!("Can't read that file: {err}"))?;
        return Ok(GzPayload { name: leaf, size, bytes, truncated: size > limit });
    }
    Err("Can't find that file in the archive.".into())
}

fn members(archive: &Path) -> Result<Vec<Member>, String> {
    if is_tar_name(archive) || sniff_tar(archive) {
        return tar_members(archive);
    }
    let (name, modified) = member_meta(archive);
    Ok(vec![Member { name: normalize(&name), is_dir: false, size: isize_of(archive), modified }])
}

fn tar_members(archive: &Path) -> Result<Vec<Member>, String> {
    let mut tar = tar::Archive::new(capped(open_gz(archive)?, true)?);
    let entries = tar.entries().map_err(|err| format!("Can't read that archive: {err}"))?;
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Can't read that archive: {err}"))?;
        let raw = entry.path().map_err(|err| format!("Can't read that archive: {err}"))?.to_string_lossy().to_string();
        let name = normalize(&raw);
        if name.is_empty() {
            continue;
        }
        let kind = entry.header().entry_type();
        let is_dir = kind.is_dir() || raw.ends_with('/');
        if !is_dir && !kind.is_file() {
            continue;
        }
        let modified = entry.header().mtime().unwrap_or(0).saturating_mul(1000);
        rows.push(Member { name, is_dir, size: if is_dir { 0 } else { entry.size() }, modified });
    }
    Ok(rows)
}

fn is_tar_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    let name = name.to_ascii_lowercase();
    name.ends_with(".tar.gz") || name.ends_with(".tar.gzip") || name.ends_with(".tgz")
}

fn sniff_tar(path: &Path) -> bool {
    if is_tar_name(path) {
        return true;
    }
    let Ok(mut decoder) = open_gz(path) else { return false };
    let mut buf = [0u8; 512];
    let mut got = 0;
    while got < buf.len() {
        match decoder.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(read) => got += read,
            Err(_) => return false,
        }
    }
    got >= 262 && &buf[257..262] == b"ustar"
}

fn member_meta(path: &Path) -> (String, u64) {
    let fallback = fallback_name(path);
    let Ok(mut file) = File::open(path) else { return (fallback, 0) };
    let mut head = [0u8; 10];
    if file.read_exact(&mut head).is_err() || head[0] != 0x1f || head[1] != 0x8b {
        return (fallback, 0);
    }
    let mtime = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
    let modified = if mtime == 0 { 0 } else { mtime as u64 * 1000 };
    let flags = head[3];
    if flags & 4 != 0 {
        let mut lenb = [0u8; 2];
        if file.read_exact(&mut lenb).is_err() {
            return (fallback, modified);
        }
        let extra = u16::from_le_bytes(lenb) as u64;
        if io::copy(&mut file.by_ref().take(extra), &mut io::sink()).is_err() {
            return (fallback, modified);
        }
    }
    if flags & 8 != 0 {
        let mut name = Vec::new();
        let mut byte = [0u8; 1];
        while name.len() < 512 && file.read_exact(&mut byte).is_ok() && byte[0] != 0 {
            name.push(byte[0]);
        }
        let text = String::from_utf8_lossy(&name);
        let leaf = text.rsplit(['/', '\\']).next().unwrap_or(text.as_ref()).trim();
        if !leaf.is_empty() {
            return (leaf.to_string(), modified);
        }
    }
    (fallback, modified)
}

fn fallback_name(path: &Path) -> String {
    let name = path.file_name().map(|item| item.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let lower = name.to_ascii_lowercase();
    for suffix in [".gzip", ".tgz", ".gz"] {
        if lower.ends_with(suffix) && name.len() > suffix.len() {
            return name[..name.len() - suffix.len()].to_string();
        }
    }
    name
}

fn isize_of(path: &Path) -> u64 {
    let Ok(mut file) = File::open(path) else { return 0 };
    let Ok(len) = file.metadata().map(|meta| meta.len()) else { return 0 };
    if len < 8 || file.seek(SeekFrom::End(-4)).is_err() {
        return 0;
    }
    let mut buf = [0u8; 4];
    if file.read_exact(&mut buf).is_err() {
        return 0;
    }
    u32::from_le_bytes(buf) as u64
}

fn open_gz(path: &Path) -> Result<GzDecoder<File>, String> {
    let mut file = File::open(path).map_err(|err| format!("Can't open that archive: {err}"))?;
    let mut magic = [0u8; 2];
    file.read_exact(&mut magic).map_err(|_| "Can't read that archive.".to_string())?;
    if magic != [0x1f, 0x8b] {
        return Err("That file is not a gzip archive.".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|err| format!("Can't read that archive: {err}"))?;
    Ok(GzDecoder::new(file))
}

struct Capped<R> {
    inner: R,
    left: u64,
    hit: bool,
    error_on_cap: bool,
}

fn capped<R: Read>(inner: R, error_on_cap: bool) -> Result<Capped<R>, String> {
    Ok(Capped { inner, left: MAX_INFLATE, hit: false, error_on_cap })
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            self.hit = true;
            if self.error_on_cap {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "That archive is too large to open."));
            }
            return Ok(0);
        }
        let max = buf.len().min(self.left as usize);
        let got = self.inner.read(&mut buf[..max])?;
        self.left = self.left.saturating_sub(got as u64);
        Ok(got)
    }
}

fn rest_inside(name: &str, inner: &str) -> Option<String> {
    if inner.is_empty() {
        return Some(name.to_string());
    }
    if name == inner {
        return Some(String::new());
    }
    name.strip_prefix(&format!("{inner}/")).map(|rest| rest.to_string())
}

fn output_relative(name: &str, inner: &str) -> Option<PathBuf> {
    if inner.is_empty() {
        return safe_parts(name);
    }
    if name == inner {
        return safe_parts(inner.rsplit('/').next().unwrap_or(inner));
    }
    let rest = name.strip_prefix(&format!("{inner}/"))?;
    let leaf = inner.rsplit('/').next().unwrap_or(inner);
    safe_parts(&format!("{leaf}/{rest}"))
}

fn safe_parts(name: &str) -> Option<PathBuf> {
    let name = normalize(name);
    if name.is_empty() {
        return None;
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        path.push(safe_leaf(part));
    }
    Some(path)
}

fn safe_leaf(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| if matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || ch.is_control() { '_' } else { ch })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    if cleaned.is_empty() || cleaned == ".." { "file".into() } else { cleaned.to_string() }
}

fn token(archive: &Path, inner: &str) -> String {
    format!("gz:{}|{}", plain(archive), normalize(inner))
}

fn parent_of(archive: &Path, inner: &str) -> Option<String> {
    if inner.is_empty() {
        return archive.parent().map(plain).filter(|parent| !parent.is_empty());
    }
    let up = inner.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
    Some(token(archive, up))
}

fn normalize(name: &str) -> String {
    let replaced = name.replace('\\', "/");
    let mut parts = Vec::new();
    for part in replaced.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return String::new();
        }
        parts.push(part);
    }
    parts.join("/")
}

fn plain(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[cfg(test)]
mod tests {
    use super::{extract, list, read, token};
    use flate2::write::GzEncoder;
    use flate2::{Compression, GzBuilder};
    use std::fs::{self, File};
    use std::io::Write;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("filepad-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_and_reads_a_single_gzip() {
        let dir = scratch("gz");
        let path = dir.join("notes.txt.gz");
        {
            let file = File::create(&path).unwrap();
            let mut enc = GzBuilder::new().filename("notes.txt").write(file, Compression::default());
            enc.write_all(b"hello gzip").unwrap();
            enc.finish().unwrap();
        }
        let listing = list(&path, "").unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "notes.txt");
        assert!(!listing.entries[0].is_dir);
        let payload = read(&path, "notes.txt", 1000, false).unwrap();
        assert_eq!(payload.bytes, b"hello gzip");
        assert!(!payload.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_reads_and_extracts_a_tar_gz() {
        let dir = scratch("tgz");
        let path = dir.join("pack.tar.gz");
        {
            let file = File::create(&path).unwrap();
            let enc = GzEncoder::new(file, Compression::default());
            let mut builder = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, "a/hello.txt", &b"hello"[..]).unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, "b.txt", &b"bye"[..]).unwrap();
            builder.finish().unwrap();
        }
        let root = list(&path, "").unwrap();
        let names: Vec<_> = root.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b.txt"));
        assert!(root.entries.iter().find(|entry| entry.name == "a").unwrap().is_dir);
        let nested = list(&path, "a").unwrap();
        assert_eq!(nested.entries.len(), 1);
        assert_eq!(nested.entries[0].name, "hello.txt");
        let payload = read(&path, "a/hello.txt", 100, false).unwrap();
        assert_eq!(payload.bytes, b"hello");
        let dest = dir.join("out");
        fs::create_dir(&dest).unwrap();
        let copied = extract(&[token(&path, "")], &dest, true, &mut |_, _, _| {}).unwrap();
        assert_eq!(copied.done, 2);
        assert_eq!(fs::read(dest.join("a").join("hello.txt")).unwrap(), b"hello");
        assert_eq!(fs::read(dest.join("b.txt")).unwrap(), b"bye");
        let _ = fs::remove_dir_all(&dir);
    }
}
