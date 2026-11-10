use crate::zipnav;
use base64::Engine;
use image::{ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_PREVIEW: u64 = 8 * 1024 * 1024;
const MAX_IMAGE: u64 = 80 * 1024 * 1024;
const MAX_MEDIA: u64 = 32 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub kind: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub extension: String,
    pub truncated: bool,
    pub scaled: bool,
    pub mime: Option<String>,
    pub text: Option<String>,
    pub data_base64: Option<String>,
}

pub fn preview_file(raw: &str) -> Result<Preview, String> {
    if let Some((archive, inner)) = zipnav::split(raw) {
        return preview_zip(&archive, &inner, raw.trim());
    }
    let path = Path::new(raw.trim());
    let meta = fs::metadata(path).map_err(|_| "Can't read that file.".to_string())?;
    if meta.is_dir() {
        return Err("Choose a file to preview.".into());
    }
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let extension = extension_of(path);
    let size = meta.len();
    let kind = kind_for(&extension);
    if kind == "audio" || kind == "video" || kind == "zip" {
        return Ok(shell(kind, &name, raw.trim(), size, &extension));
    }
    if kind == "image" && size > MAX_IMAGE {
        return Ok(shell("too-large", &name, raw.trim(), size, &extension));
    }
    if kind == "image" && size > MAX_PREVIEW {
        let bytes = fs::read(path).map_err(|err| format!("Can't read that file: {err}"))?;
        return Ok(shrunk_image(&name, raw.trim(), size, &extension, &bytes));
    }
    let file = File::open(path).map_err(|err| format!("Can't read that file: {err}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW).read_to_end(&mut bytes).map_err(|err| format!("Can't read that file: {err}"))?;
    finish(kind, &name, raw.trim(), size, &extension, bytes, size > MAX_PREVIEW)
}

pub fn save_image(raw: &str, quarters: i32, flip_h: bool, flip_v: bool) -> Result<(), String> {
    if zipnav::split(raw).is_some() {
        return Err("Copy the picture out of the zip before saving a change.".into());
    }
    if quarters.rem_euclid(4) == 0 && !flip_h && !flip_v {
        return Ok(());
    }
    let path = Path::new(raw.trim());
    let extension = extension_of(path);
    if extension == "svg" {
        return Err("SVG pictures stay as they are.".into());
    }
    let bytes = fs::read(path).map_err(|err| format!("Can't read that picture: {err}"))?;
    let mut image = decode_image(&bytes)?;
    image = match quarters.rem_euclid(4) {
        1 => image.rotate90(),
        2 => image.rotate180(),
        3 => image.rotate270(),
        _ => image,
    };
    if flip_h {
        image = image.fliph();
    }
    if flip_v {
        image = image.flipv();
    }
    image.save(path).map_err(|err| format!("Can't save that picture: {err}"))?;
    Ok(())
}

fn preview_zip(archive: &Path, inner: &str, raw: &str) -> Result<Preview, String> {
    let extension = Path::new(inner).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = kind_for(&extension);
    let (limit, partial) = match kind {
        "image" => (MAX_IMAGE, false),
        "audio" | "video" => (MAX_MEDIA, false),
        "text" | "csv" | "auto" => (MAX_PREVIEW, true),
        _ => (MAX_PREVIEW, false),
    };
    let payload = zipnav::read(archive, inner, limit, partial)?;
    if kind == "audio" || kind == "video" {
        if payload.truncated {
            return Ok(shell("too-large", &payload.name, raw, payload.size, &extension));
        }
        return Ok(Preview {
            kind: kind.to_string(),
            name: payload.name,
            path: raw.to_string(),
            size: payload.size,
            extension,
            truncated: false,
            scaled: false,
            mime: None,
            text: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(payload.bytes)),
        });
    }
    if kind == "image" && payload.truncated {
        return Ok(shell("too-large", &payload.name, raw, payload.size, &extension));
    }
    if kind == "image" && payload.size > MAX_PREVIEW {
        return Ok(shrunk_image(&payload.name, raw, payload.size, &extension, &payload.bytes));
    }
    finish(kind, &payload.name, raw, payload.size, &extension, payload.bytes, payload.truncated)
}

fn finish(kind: &str, name: &str, path: &str, size: u64, extension: &str, bytes: Vec<u8>, truncated: bool) -> Result<Preview, String> {
    let mut kind = kind.to_string();
    if kind == "auto" {
        kind = if looks_binary(&bytes) { "binary".into() } else { "text".into() };
    }
    if kind == "binary" || kind == "zip" {
        return Ok(shell(&kind, name, path, size, extension));
    }
    if kind == "text" || kind == "csv" {
        return Ok(Preview {
            kind,
            name: name.to_string(),
            path: path.to_string(),
            size,
            extension: extension.to_string(),
            truncated,
            scaled: false,
            mime: None,
            text: Some(String::from_utf8_lossy(&bytes).to_string()),
            data_base64: None,
        });
    }
    if truncated {
        return Ok(shell("too-large", name, path, size, extension));
    }
    Ok(Preview {
        kind,
        name: name.to_string(),
        path: path.to_string(),
        size,
        extension: extension.to_string(),
        truncated: false,
        scaled: false,
        mime: None,
        text: None,
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
    })
}

fn shrunk_image(name: &str, path: &str, size: u64, extension: &str, bytes: &[u8]) -> Preview {
    match shrink_jpeg(bytes) {
        Ok(jpeg) => Preview {
            kind: "image".into(),
            name: name.to_string(),
            path: path.to_string(),
            size,
            extension: extension.to_string(),
            truncated: false,
            scaled: true,
            mime: Some("image/jpeg".into()),
            text: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(jpeg)),
        },
        Err(_) => shell("too-large", name, path, size, extension),
    }
}

fn shrink_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let image = decode_image(bytes)?;
    let thumb = image.thumbnail(1800, 1800);
    let mut out = Cursor::new(Vec::new());
    thumb.write_to(&mut out, ImageFormat::Jpeg).map_err(|_| "That picture is too large to preview.".to_string())?;
    Ok(out.into_inner())
}

fn decode_image(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|err| err.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(32_000);
    limits.max_image_height = Some(32_000);
    limits.max_alloc = Some(1024 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| "That picture is too large to preview.".to_string())
}

fn shell(kind: &str, name: &str, path: &str, size: u64, extension: &str) -> Preview {
    Preview {
        kind: kind.to_string(),
        name: name.to_string(),
        path: path.to_string(),
        size,
        extension: extension.to_string(),
        truncated: kind == "too-large",
        scaled: false,
        mime: None,
        text: None,
        data_base64: None,
    }
}

fn extension_of(path: &Path) -> String {
    path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn kind_for(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" => "image",
        "pdf" => "pdf",
        "csv" | "tsv" => "csv",
        "docx" => "docx",
        "xlsx" => "xlsx",
        "zip" => "zip",
        "mp3" | "wav" | "ogg" | "oga" | "flac" | "m4a" | "aac" | "opus" | "wma" => "audio",
        "mp4" | "m4v" | "webm" | "ogv" | "mov" | "mkv" => "video",
        "doc" | "xls" | "ppt" | "pptx" | "gz" | "7z" | "rar" | "exe" | "dll" => "binary",
        "txt" | "md" | "markdown" | "json" | "jsonl" | "log" | "xml" | "html" | "htm" | "css" | "js" | "jsx" | "ts" | "tsx" | "rs" | "py" | "toml" | "yaml" | "yml" | "ini" | "php" | "sh" | "ps1" | "bat" | "cmd" | "sql" | "c" | "h" | "cpp" | "cs" | "go" | "java" | "rb" => "text",
        _ => "auto",
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}
