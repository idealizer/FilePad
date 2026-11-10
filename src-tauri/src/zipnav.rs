use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

pub struct ZipEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub extension: String,
    pub hidden: bool,
}

pub struct ZipListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<ZipEntry>,
}

pub struct ZipPayload {
    pub name: String,
    pub size: u64,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

pub struct ZipCopy {
    pub done: u64,
    pub conflicts: Vec<String>,
}

pub struct ZipStat {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub extension: String,
    pub files: u64,
    pub folders: u64,
}

pub fn split(raw: &str) -> Option<(PathBuf, String)> {
    let rest = raw.trim().strip_prefix("zip:")?;
    let (archive, inner) = rest.split_once('|')?;
    if archive.is_empty() {
        return None;
    }
    Some((PathBuf::from(archive), normalize(inner)))
}

pub fn is_zip_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
}

pub fn stat(archive: &Path, inner: &str) -> Result<ZipStat, String> {
    let inner = normalize(inner);
    let mut zip = open_zip(archive)?;
    let mut rows = Vec::new();
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|err| format!("Can't read that zip: {err}"))?;
        let name = normalize(entry.name());
        if name.is_empty() {
            continue;
        }
        let extension = Path::new(&name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
        rows.push((name, entry.is_dir(), entry.size(), entry.last_modified().map(zip_modified_ms).unwrap_or(0), extension));
    }
    if inner.is_empty() {
        let files = rows.iter().filter(|row| !row.1).count() as u64;
        let name = archive.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "archive.zip".into());
        return Ok(ZipStat { name, is_dir: true, size: 0, modified: 0, extension: "zip".into(), files, folders: 0 });
    }
    if let Some(found) = rows.iter().find(|row| row.0 == inner) {
        if !found.1 {
            let name = inner.rsplit('/').next().unwrap_or(&inner).to_string();
            return Ok(ZipStat {
                name,
                is_dir: false,
                size: found.2,
                modified: found.3,
                extension: found.4.clone(),
                files: 0,
                folders: 0,
            });
        }
    }
    let prefix = format!("{inner}/");
    if rows.iter().any(|row| row.0 == inner || row.0.starts_with(&prefix)) {
        let (files, folders) = immediate(&rows, &inner);
        let name = inner.rsplit('/').next().unwrap_or(&inner).to_string();
        return Ok(ZipStat { name, is_dir: true, size: 0, modified: 0, extension: String::new(), files, folders });
    }
    Err("Can't find that item in the zip.".into())
}

fn immediate(rows: &[(String, bool, u64, u64, String)], inner: &str) -> (u64, u64) {
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    let mut folders = BTreeSet::new();
    let mut files = 0u64;
    for (name, is_dir, _, _, _) in rows {
        let Some(rest) = name.strip_prefix(&prefix) else { continue };
        if rest.is_empty() {
            continue;
        }
        if *is_dir || rest.contains('/') {
            if let Some(child) = rest.split('/').next() {
                if !child.is_empty() {
                    folders.insert(child.to_string());
                }
            }
        } else {
            files += 1;
        }
    }
    (files, folders.len() as u64)
}

pub fn list(archive: &Path, inner: &str) -> Result<ZipListing, String> {
    if !archive.is_file() {
        return Err("Can't open that zip.".into());
    }
    let inner = normalize(inner);
    let file = File::open(archive).map_err(|err| format!("Can't open that zip: {err}"))?;
    let mut zip = ZipArchive::new(file).map_err(|err| format!("Can't read that zip: {err}"))?;
    let mut children: BTreeMap<String, ZipEntry> = BTreeMap::new();
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|err| format!("Can't read that zip: {err}"))?;
        let name = normalize(entry.name());
        if name.is_empty() {
            continue;
        }
        let rest = match rest_inside(&name, &inner) {
            Some(rest) => rest,
            None => continue,
        };
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
        let is_dir = nested || entry.is_dir();
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
            ZipEntry {
                name: child.clone(),
                path,
                is_dir,
                size: if is_dir { 0 } else { entry.size() },
                modified: entry.last_modified().map(zip_modified_ms).unwrap_or(0),
                extension,
                hidden: child.starts_with('.'),
            },
        );
    }
    Ok(ZipListing {
        path: token(archive, &inner),
        parent: parent_of(archive, &inner),
        entries: children.into_values().collect(),
    })
}

pub fn read(archive: &Path, inner: &str, limit: u64, partial: bool) -> Result<ZipPayload, String> {
    let inner = normalize(inner);
    if inner.is_empty() {
        return Err("Choose a file.".into());
    }
    let mut zip = open_zip(archive)?;
    let index = find_entry(&mut zip, &inner)?;
    let entry = zip.by_index(index).map_err(|err| format!("Can't read that file: {err}"))?;
    if entry.is_dir() {
        return Err("Choose a file.".into());
    }
    let size = entry.size();
    let name = entry.name().rsplit(['/', '\\']).next().unwrap_or(inner.as_str()).to_string();
    if size > limit && !partial {
        return Ok(ZipPayload { name, size, bytes: Vec::new(), truncated: true });
    }
    let mut limited = entry.take(limit);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).map_err(|err| format!("Can't read that file: {err}"))?;
    Ok(ZipPayload { name, size, bytes, truncated: size > limit })
}

pub fn export_temp(raw: &str) -> Result<String, String> {
    let (archive, inner) = split(raw).ok_or_else(|| "That is not inside a zip.".to_string())?;
    if inner.is_empty() {
        return Err("Choose a file.".into());
    }
    let leaf = inner.rsplit('/').next().unwrap_or(&inner);
    if leaf.is_empty() {
        return Err("Choose a file.".into());
    }
    let mut zip = open_zip(&archive)?;
    let index = find_entry(&mut zip, &inner)?;
    let mut entry = zip.by_index(index).map_err(|err| format!("Can't read that file: {err}"))?;
    if entry.is_dir() {
        return Err("Choose a file.".into());
    }
    if entry.size() > 4 * 1024 * 1024 * 1024 {
        return Err("That file is too large to open from the zip.".into());
    }
    let dir = std::env::temp_dir().join("FilePadOpen");
    fs::create_dir_all(&dir).map_err(|err| format!("Can't open that file: {err}"))?;
    let dest = dir.join(leaf);
    let mut out = File::create(&dest).map_err(|err| format!("Can't open that file: {err}"))?;
    io::copy(&mut entry, &mut out).map_err(|err| format!("Can't open that file: {err}"))?;
    Ok(plain(&dest))
}

pub fn extract(sources: &[String], dest_dir: &Path, overwrite: bool, progress: &mut dyn FnMut(u64, u64, &str)) -> Result<ZipCopy, String> {
    if sources.is_empty() {
        return Err("Nothing selected.".into());
    }
    let mut jobs = Vec::new();
    for source in sources {
        let (archive, inner) = split(source).ok_or_else(|| "Copy zip contents separately from other files.".to_string())?;
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
        return Ok(ZipCopy { done: 0, conflicts });
    }
    let mut planned = Vec::new();
    for (archive, inner, _) in &jobs {
        planned.push(matching_files(archive, inner)?);
    }
    let total: u64 = planned.iter().map(|files| files.len() as u64).sum();
    if total == 0 {
        return Err("That zip folder is empty.".into());
    }
    progress(0, total, "Starting");
    let mut done = 0u64;
    for files in planned {
        if files.is_empty() {
            continue;
        }
        let archive = files[0].0.clone();
        let mut zip = open_zip(&archive)?;
        for (_, original, relative) in files {
            let dest = dest_dir.join(&relative);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|err| format!("Can't copy: {err}"))?;
            }
            let mut entry = zip.by_name(&original).map_err(|err| format!("Can't copy: {err}"))?;
            let mut out = File::create(&dest).map_err(|err| format!("Can't copy: {err}"))?;
            io::copy(&mut entry, &mut out).map_err(|err| format!("Can't copy: {err}"))?;
            done += 1;
            let label = relative.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
            progress(done, total, &label);
        }
    }
    Ok(ZipCopy { done, conflicts: Vec::new() })
}

fn matching_files(archive: &Path, inner: &str) -> Result<Vec<(PathBuf, String, PathBuf)>, String> {
    let mut zip = open_zip(archive)?;
    let mut files = Vec::new();
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|err| format!("Can't read that zip: {err}"))?;
        let name = normalize(entry.name());
        if name.is_empty() || entry.is_dir() {
            continue;
        }
        let Some(relative) = output_relative(&name, inner) else { continue };
        files.push((archive.to_path_buf(), entry.name().to_string(), relative));
    }
    if files.is_empty() {
        let mut zip = open_zip(archive)?;
        if find_entry(&mut zip, inner).is_err() {
            return Err("Can't find that item in the zip.".into());
        }
    }
    Ok(files)
}

fn output_relative(name: &str, inner: &str) -> Option<PathBuf> {
    if inner.is_empty() {
        return safe_parts(name);
    }
    if name == inner {
        return safe_parts(inner.rsplit('/').next().unwrap_or(inner));
    }
    let prefix = format!("{inner}/");
    let rest = name.strip_prefix(&prefix)?;
    let leaf = inner.rsplit('/').next().unwrap_or(inner);
    safe_parts(&format!("{leaf}/{rest}"))
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

fn find_entry<R: Read + io::Seek>(zip: &mut ZipArchive<R>, inner: &str) -> Result<usize, String> {
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|err| format!("Can't read that zip: {err}"))?;
        if normalize(entry.name()) == inner {
            return Ok(index);
        }
    }
    Err("Can't find that file in the zip.".into())
}

fn open_zip(archive: &Path) -> Result<ZipArchive<File>, String> {
    let file = File::open(archive).map_err(|err| format!("Can't open that zip: {err}"))?;
    ZipArchive::new(file).map_err(|err| format!("Can't read that zip: {err}"))
}

fn token(archive: &Path, inner: &str) -> String {
    format!("zip:{}|{}", plain(archive), normalize(inner))
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

pub fn create_zip(sources: &[String], dest: &str) -> Result<String, String> {
    if sources.is_empty() {
        return Err("Nothing selected.".into());
    }
    if sources.iter().any(|source| {
        let source = source.trim();
        source.starts_with("zip:") || source.starts_with("gz:") || source.starts_with("sftp:")
    }) {
        return Err("Copy files out of an archive before packing them.".into());
    }
    if dest.trim().starts_with("sftp:") {
        return Err("Create the zip on this computer, then copy it to the server.".into());
    }
    let dest_path = PathBuf::from(dest.trim());
    if dest_path.as_os_str().is_empty() {
        return Err("Enter a name for the zip.".into());
    }
    if dest_path.exists() {
        return Err("That zip already exists.".into());
    }
    if dest_path.parent().is_none_or(|path| !path.is_dir()) {
        return Err("Can't find that folder.".into());
    }
    for source in sources {
        let path = PathBuf::from(source.trim());
        if !path.exists() {
            return Err(format!("Can't find {}", path.display()));
        }
        if same_path(&path, &dest_path) || contains(&path, &dest_path) {
            return Err("Can't put a zip inside itself.".into());
        }
    }
    let file = File::create(&dest_path).map_err(|err| format!("Can't create the zip: {err}"))?;
    if let Err(err) = write_zip(file, sources) {
        let _ = fs::remove_file(&dest_path);
        return Err(err);
    }
    Ok(plain(&dest_path))
}

fn write_zip(file: File, sources: &[String]) -> Result<(), String> {
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default();
    let mut used = BTreeMap::<String, usize>::new();
    for source in sources {
        let path = PathBuf::from(source.trim());
        let base = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "item".into());
        let name = unique_zip_name(&mut used, &base);
        add_zip_path(&mut zip, &path, &name, opts)?;
    }
    zip.finish().map_err(|err| format!("Can't finish the zip: {err}"))?;
    Ok(())
}

fn unique_zip_name(used: &mut BTreeMap<String, usize>, base: &str) -> String {
    let count = used.entry(base.to_ascii_lowercase()).or_insert(0);
    *count += 1;
    if *count == 1 {
        return base.to_string();
    }
    let dot = base.rfind('.').filter(|index| *index > 0);
    match dot {
        Some(index) => format!("{}_{}{}", &base[..index], *count, &base[index..]),
        None => format!("{base}_{}", *count),
    }
}

fn add_zip_path(zip: &mut ZipWriter<File>, path: &Path, name: &str, opts: SimpleFileOptions) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|err| format!("Can't read {}: {err}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        let mut children = fs::read_dir(path)
            .map_err(|err| format!("Can't read {}: {err}", path.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Can't read {}: {err}", path.display()))?;
        children.sort_by_key(|entry| entry.file_name());
        if children.is_empty() {
            let dir = format!("{}/", name.replace('\\', "/"));
            zip.add_directory(dir, opts).map_err(|err| format!("Can't add a folder: {err}"))?;
            return Ok(());
        }
        for child in children {
            let child_name = format!("{}/{}", name.replace('\\', "/"), child.file_name().to_string_lossy());
            add_zip_path(zip, &child.path(), &child_name, opts)?;
        }
        return Ok(());
    }
    let entry = name.replace('\\', "/");
    zip.start_file(&entry, opts).map_err(|err| format!("Can't add {entry}: {err}"))?;
    let mut input = File::open(path).map_err(|err| format!("Can't read {}: {err}", path.display()))?;
    io::copy(&mut input, zip).map_err(|err| format!("Can't write {entry}: {err}"))?;
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    fold_key(left) == fold_key(right)
}

fn contains(folder: &Path, child: &Path) -> bool {
    let folder = fold_key(folder);
    let child = fold_key(child);
    child.starts_with(&(folder + "\\"))
}

fn fold_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

fn safe_parts(name: &str) -> Option<PathBuf> {
    let name = normalize(name);
    if name.is_empty() {
        return None;
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        path.push(part);
    }
    Some(path)
}

fn plain(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn zip_modified_ms(dt: zip::DateTime) -> u64 {
    let year = dt.year() as i64;
    let month = dt.month() as i64;
    let day = dt.day() as i64;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return 0;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u64;
    let days = era * 146097 + doe as i64 - 719468;
    let secs = days * 86400 + dt.hour() as i64 * 3600 + dt.minute() as i64 * 60 + dt.second() as i64;
    if secs < 0 { 0 } else { (secs as u64).saturating_mul(1000) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn lists_and_extracts_one_level() {
        let dir = std::env::temp_dir().join(format!("filepad-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("sample.zip");
        {
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            let opts = SimpleFileOptions::default();
            zip.start_file("readme.txt", opts).unwrap();
            zip.write_all(b"hello").unwrap();
            zip.start_file("dir/a.txt", opts).unwrap();
            zip.write_all(b"aaa").unwrap();
            zip.finish().unwrap();
        }
        let listing = list(&archive, "").unwrap();
        let readme = listing.entries.iter().find(|entry| entry.name == "readme.txt").unwrap();
        assert!(!readme.is_dir);
        assert!(listing.entries.iter().any(|entry| entry.name == "dir" && entry.is_dir));
        let nested = list(&archive, "dir").unwrap();
        assert_eq!(nested.entries.len(), 1);
        assert_eq!(nested.entries[0].name, "a.txt");
        let dest = dir.join("out");
        fs::create_dir_all(&dest).unwrap();
        let source = token(&archive, "dir");
        let copied = extract(&[source], &dest, false, &mut |_, _, _| {}).unwrap();
        assert_eq!(copied.done, 1);
        assert_eq!(fs::read(dest.join("dir").join("a.txt")).unwrap(), b"aaa");
        let all = dir.join("all");
        fs::create_dir_all(&all).unwrap();
        let whole = extract(&[token(&archive, "")], &all, true, &mut |_, _, _| {}).unwrap();
        assert_eq!(whole.done, 2);
        assert_eq!(fs::read(all.join("readme.txt")).unwrap(), b"hello");
        assert_eq!(stat(&archive, "").unwrap().files, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn packs_a_file_and_a_folder() {
        let dir = std::env::temp_dir().join(format!("filepad-pack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pics")).unwrap();
        fs::write(dir.join("pics").join("a.txt"), b"aaa").unwrap();
        fs::write(dir.join("note.txt"), b"note").unwrap();
        let dest = dir.join("out.zip");
        create_zip(
            &[dir.join("note.txt").display().to_string(), dir.join("pics").display().to_string()],
            &dest.display().to_string(),
        )
        .unwrap();
        let mut archive = ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let mut names = Vec::new();
        for index in 0..archive.len() {
            names.push(archive.by_index(index).unwrap().name().to_string());
        }
        assert!(names.iter().any(|name| name == "note.txt"));
        assert!(names.iter().any(|name| name == "pics/a.txt"));
        let _ = fs::remove_dir_all(&dir);
    }
}
