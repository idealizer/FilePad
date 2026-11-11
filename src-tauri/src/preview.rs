use crate::{docs, gzipnav, slides, zipnav};
use base64::Engine;
use image::{ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_PREVIEW: u64 = 8 * 1024 * 1024;
const MAX_IMAGE: u64 = 80 * 1024 * 1024;
const MAX_MEDIA: u64 = 32 * 1024 * 1024;
const MAX_PDF: u64 = 64 * 1024 * 1024;
const MAX_DOC: u64 = 80 * 1024 * 1024;
const PREVIEW_EDGE: u32 = 1600;
const PREVIEW_ORIGINAL: u64 = 1536 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub kind: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub extension: String,
    pub truncated: bool,
    pub scaled: bool,
    pub mime: Option<String>,
    pub text: Option<String>,
    pub data_base64: Option<String>,
    pub poster_mime: Option<String>,
    pub poster_base64: Option<String>,
}

pub fn preview_file(raw: &str) -> Result<Preview, String> {
    if crate::sftpnav::is_remote(raw) {
        let extension = extension_tail(raw);
        let limit = if is_deck(&extension) { u64::MAX } else { MAX_PREVIEW };
        let loaded = crate::sftpnav::read_capped(raw, limit)?;
        if is_deck(&extension) {
            return document_preview(&loaded.name, raw, loaded.size, &extension, &loaded.data);
        }
        return preview_bytes(raw, &loaded.name, loaded.size, loaded.data, loaded.truncated);
    }
    if let Some((archive, inner)) = zipnav::split(raw) {
        return preview_zip(&archive, &inner, raw.trim());
    }
    if let Some((archive, inner)) = gzipnav::split(raw) {
        return preview_gz(&archive, &inner, raw.trim());
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
    if kind == "audio" || kind == "video" || kind == "zip" || kind == "gz" {
        let mut item = shell(kind, &name, raw.trim(), size, &extension);
        if kind == "audio" {
            attach_cover_file(&mut item, path);
        }
        return Ok(item);
    }
    if kind == "image" && fast_enough(&extension, size) {
        if let Ok((jpeg, width, height)) = fast_jpeg(path) {
            return Ok(scaled_image(&name, raw.trim(), size, &extension, jpeg, width, height));
        }
        if size > MAX_IMAGE {
            return Ok(shell("too-large", &name, raw.trim(), size, &extension));
        }
    }
    if kind == "image" && size > MAX_IMAGE {
        return Ok(shell("too-large", &name, raw.trim(), size, &extension));
    }
    if kind == "pdf" {
        if size > MAX_PDF {
            return Ok(shell("too-large", &name, raw.trim(), size, &extension));
        }
        if size > MAX_PREVIEW {
            return Ok(shell(kind, &name, raw.trim(), size, &extension));
        }
        let bytes = fs::read(path).map_err(|err| format!("Can't read that file: {err}"))?;
        return finish(kind, &name, raw.trim(), size, &extension, bytes, false);
    }
    if kind == "document" {
        if document_byte_limit(&extension).is_some_and(|limit| size > limit) {
            return Ok(shell("too-large", &name, raw.trim(), size, &extension));
        }
        let bytes = fs::read(path).map_err(|err| format!("Can't read that file: {err}"))?;
        return document_preview(&name, raw.trim(), size, &extension, &bytes);
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

fn preview_bytes(raw: &str, name: &str, size: u64, bytes: Vec<u8>, truncated: bool) -> Result<Preview, String> {
    let extension = extension_of(Path::new(name));
    let kind = kind_for(&extension);
    if kind == "audio" || kind == "video" || kind == "zip" || kind == "gz" || (truncated && kind != "text" && kind != "csv" && kind != "auto") {
        let shown = if truncated { "too-large" } else { kind };
        return Ok(shell(shown, name, raw, size, &extension));
    }
    finish(kind, name, raw, size, &extension, bytes, truncated)
}

pub fn save_image(raw: &str, quarters: i32, flip_h: bool, flip_v: bool) -> Result<(), String> {
    if crate::sftpnav::is_remote(raw) {
        return Err("Copy the picture to this computer before saving a change.".into());
    }
    if zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() {
        return Err("Copy the picture out of the archive before saving a change.".into());
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

fn preview_gz(archive: &Path, inner: &str, raw: &str) -> Result<Preview, String> {
    if inner.is_empty() {
        let name = archive.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let extension = extension_of(archive);
        let size = fs::metadata(archive).map(|meta| meta.len()).unwrap_or(0);
        return Ok(shell("gz", &name, raw, size, &extension));
    }
    let extension = Path::new(inner).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = kind_for(&extension);
    let (limit, partial) = read_limit(&extension, kind);
    let payload = gzipnav::read(archive, inner, limit, partial)?;
    present(kind, &extension, raw, payload.name, payload.size, payload.bytes, payload.truncated)
}

fn preview_zip(archive: &Path, inner: &str, raw: &str) -> Result<Preview, String> {
    let extension = Path::new(inner).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = kind_for(&extension);
    let (limit, partial) = read_limit(&extension, kind);
    let payload = zipnav::read(archive, inner, limit, partial)?;
    present(kind, &extension, raw, payload.name, payload.size, payload.bytes, payload.truncated)
}

fn is_deck(extension: &str) -> bool {
    matches!(extension, "pptx" | "ppt" | "potx" | "pot" | "ppsx" | "pps")
}

/// Slide previews draw one slide, so the package itself is never refused for size.
/// Other documents still stop at `MAX_DOC`.
fn document_byte_limit(extension: &str) -> Option<u64> {
    if is_deck(extension) { None } else { Some(MAX_DOC) }
}

fn extension_tail(raw: &str) -> String {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default()
}

fn read_limit(extension: &str, kind: &str) -> (u64, bool) {
    if kind == "document" {
        return (document_byte_limit(extension).unwrap_or(u64::MAX), false);
    }
    packed_limit(kind)
}

fn packed_limit(kind: &str) -> (u64, bool) {
    match kind {
        "image" => (MAX_IMAGE, false),
        "pdf" => (MAX_PDF, false),
        "document" => (MAX_DOC, false),
        "audio" | "video" => (MAX_MEDIA, false),
        "text" | "csv" | "auto" => (MAX_PREVIEW, true),
        _ => (MAX_PREVIEW, false),
    }
}

fn present(kind: &str, extension: &str, raw: &str, name: String, size: u64, bytes: Vec<u8>, truncated: bool) -> Result<Preview, String> {
    if kind == "document" {
        if truncated {
            return Ok(shell("too-large", &name, raw, size, extension));
        }
        return document_preview(&name, raw, size, extension, &bytes);
    }
    if kind == "zip" || kind == "gz" {
        return Ok(shell(kind, &name, raw, size, extension));
    }
    if kind == "audio" || kind == "video" {
        if truncated {
            return Ok(shell("too-large", &name, raw, size, extension));
        }
        let mut built = Preview {
            kind: kind.to_string(),
            name,
            path: raw.to_string(),
            size,
            extension: extension.to_string(),
            truncated: false,
            scaled: false,
            width: 0,
            height: 0,
            mime: None,
            text: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            poster_mime: None,
            poster_base64: None,
        };
        if kind == "audio" {
            attach_cover_bytes(&mut built, &bytes);
        }
        return Ok(built);
    }
    if kind == "image" && truncated {
        return Ok(shell("too-large", &name, raw, size, extension));
    }
    if kind == "image" && size > MAX_PREVIEW {
        return Ok(shrunk_image(&name, raw, size, extension, &bytes));
    }
    finish(kind, &name, raw, size, extension, bytes, truncated)
}

fn document_preview(name: &str, path: &str, size: u64, extension: &str, bytes: &[u8]) -> Result<Preview, String> {
    if is_deck(extension) {
        let text = slides::slide_page_keyed(&deck_key(path, bytes), bytes, 0)?;
        return Ok(Preview {
            kind: "slides".into(),
            name: name.to_string(),
            path: path.to_string(),
            size,
            width: 0,
            height: 0,
            extension: extension.to_string(),
            truncated: false,
            scaled: false,
            mime: None,
            text: Some(text),
            data_base64: None,
            poster_base64: None,
            poster_mime: None,
        });
    }
    let text = docs::text_of(extension, bytes)?;
    Ok(Preview {
        kind: "document".into(),
        name: name.to_string(),
        path: path.to_string(),
        size,
        width: 0,
        height: 0,
        extension: extension.to_string(),
        truncated: false,
        scaled: false,
        mime: None,
        text: Some(text),
        data_base64: None,
        poster_mime: None,
        poster_base64: None,
    })
}

pub fn preview_slide(raw: &str, index: usize) -> Result<String, String> {
    let bytes = load_document(raw)?;
    slides::slide_page_keyed(&deck_key(raw, &bytes), &bytes, index)
}

fn deck_key(raw: &str, bytes: &[u8]) -> String {
    let modified = fs::metadata(raw.trim())
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut hash = bytes.len() as u64;
    for byte in bytes.iter().take(4096) {
        hash = hash.wrapping_mul(16777619).wrapping_add(*byte as u64);
    }
    if bytes.len() > 4096 {
        for byte in bytes[bytes.len() - 4096..].iter() {
            hash = hash.wrapping_mul(16777619).wrapping_add(*byte as u64);
        }
    }
    format!("{raw}|{modified}|{hash}")
}

fn load_document(raw: &str) -> Result<Vec<u8>, String> {
    if crate::sftpnav::is_remote(raw) {
        let loaded = crate::sftpnav::read_capped(raw, u64::MAX)?;
        return Ok(loaded.data);
    }
    if let Some((archive, inner)) = zipnav::split(raw) {
        let payload = zipnav::read(&archive, &inner, u64::MAX, false)?;
        if payload.truncated {
            return Err("Can't read that presentation.".into());
        }
        return Ok(payload.bytes);
    }
    if let Some((archive, inner)) = gzipnav::split(raw) {
        let payload = gzipnav::read(&archive, &inner, u64::MAX, false)?;
        if payload.truncated {
            return Err("Can't read that presentation.".into());
        }
        return Ok(payload.bytes);
    }
    let path = Path::new(raw.trim());
    fs::read(path).map_err(|err| format!("Can't read that file: {err}"))
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
            width: 0,
            height: 0,
            mime: None,
            text: Some(String::from_utf8_lossy(&bytes).to_string()),
            data_base64: None,
            poster_mime: None,
            poster_base64: None,
        });
    }
    if truncated {
        return Ok(shell("too-large", name, path, size, extension));
    }
    let (width, height) = if kind == "image" { image_size(&bytes) } else { (0, 0) };
    Ok(Preview {
        kind,
        name: name.to_string(),
        path: path.to_string(),
        size,
        width,
        height,
        extension: extension.to_string(),
        truncated: false,
        scaled: false,
        mime: None,
        text: None,
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        poster_mime: None,
        poster_base64: None,
    })
}

fn fast_enough(extension: &str, size: u64) -> bool {
    if extension == "svg" {
        return false;
    }
    if extension == "gif" {
        return size > MAX_PREVIEW;
    }
    size > PREVIEW_ORIGINAL
}

fn scaled_image(name: &str, path: &str, size: u64, extension: &str, jpeg: Vec<u8>, width: u32, height: u32) -> Preview {
    Preview {
        kind: "image".into(),
        name: name.to_string(),
        path: path.to_string(),
        size,
        width,
        height,
        extension: extension.to_string(),
        truncated: false,
        scaled: true,
        mime: Some("image/jpeg".into()),
        text: None,
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(jpeg)),
        poster_mime: None,
        poster_base64: None,
    }
}

fn shrunk_image(name: &str, path: &str, size: u64, extension: &str, bytes: &[u8]) -> Preview {
    match shrink_jpeg(bytes) {
        Ok((jpeg, width, height)) => Preview {
            kind: "image".into(),
            name: name.to_string(),
            path: path.to_string(),
            size,
            width,
            height,
            extension: extension.to_string(),
            truncated: false,
            scaled: true,
            mime: Some("image/jpeg".into()),
            text: None,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(jpeg)),
            poster_mime: None,
            poster_base64: None,
        },
        Err(_) => shell("too-large", name, path, size, extension),
    }
}

fn shrink_jpeg(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let image = decode_image(bytes)?;
    let width = image.width();
    let height = image.height();
    let thumb = image.thumbnail(1800, 1800);
    let mut out = Cursor::new(Vec::new());
    thumb.write_to(&mut out, ImageFormat::Jpeg).map_err(|_| "That picture is too large to preview.".to_string())?;
    Ok((out.into_inner(), width, height))
}

fn image_size(bytes: &[u8]) -> (u32, u32) {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_dimensions().ok())
        .unwrap_or((0, 0))
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
        width: 0,
        height: 0,
        extension: extension.to_string(),
        truncated: kind == "too-large",
        scaled: false,
        mime: None,
        text: None,
        data_base64: None,
        poster_mime: None,
        poster_base64: None,
    }
}

fn attach_cover_file(item: &mut Preview, path: &Path) {
    let Ok(mut file) = File::open(path) else { return };
    let mut header = [0u8; 10];
    if file.read_exact(&mut header).is_err() || &header[0..3] != b"ID3" {
        return;
    }
    let Some(size) = synchsafe(&header[6..10]) else { return };
    let take = (size as usize).min(8 * 1024 * 1024);
    let mut body = vec![0u8; take];
    let Ok(read) = file.read(&mut body) else { return };
    body.truncate(read);
    let mut tagged = header.to_vec();
    tagged.extend(body);
    attach_cover_bytes(item, &tagged);
}

fn attach_cover_bytes(item: &mut Preview, bytes: &[u8]) {
    let Some((mime, image)) = id3_cover(bytes) else { return };
    let (mime, image) = if image.len() > PREVIEW_ORIGINAL as usize {
        match shrink_jpeg(&image) {
            Ok((jpeg, _, _)) => ("image/jpeg".to_string(), jpeg),
            Err(_) => (mime, image),
        }
    } else {
        (mime, image)
    };
    item.poster_mime = Some(mime);
    item.poster_base64 = Some(base64::engine::general_purpose::STANDARD.encode(image));
}

fn id3_cover(file: &[u8]) -> Option<(String, Vec<u8>)> {
    if file.len() < 10 || &file[0..3] != b"ID3" {
        return None;
    }
    let version = file[3];
    if version != 2 && version != 3 && version != 4 {
        return None;
    }
    let size = synchsafe(&file[6..10])? as usize;
    let end = 10 + size.min(file.len().saturating_sub(10));
    let mut body = file[10..end].to_vec();
    if file[5] & 0x80 != 0 {
        body = unsync(&body);
    }
    let header = if version == 2 { 6 } else { 10 };
    let mut best: Option<(u8, String, Vec<u8>)> = None;
    let mut index = 0;
    while index + header <= body.len() {
        if body[index] == 0 {
            break;
        }
        let (picture, data_size, format_flag) = if version == 2 {
            (&body[index..index + 3] == b"PIC", read_be(&body[index + 3..index + 6])?, 0u8)
        } else {
            let size = if version == 4 {
                synchsafe(&body[index + 4..index + 8])? as usize
            } else {
                read_be(&body[index + 4..index + 8])?
            };
            (&body[index..index + 4] == b"APIC", size, body[index + 9])
        };
        let start = index + header;
        let Some(frame_end) = start.checked_add(data_size) else { break };
        if frame_end > body.len() {
            break;
        }
        let frame = body[start..frame_end].to_vec();
        index = frame_end;
        if !picture {
            continue;
        }
        let compressed = if version == 4 { format_flag & 0x08 != 0 } else { format_flag & 0x80 != 0 };
        let encrypted = if version == 4 { format_flag & 0x04 != 0 } else { format_flag & 0x40 != 0 };
        if compressed || encrypted {
            continue;
        }
        let mut data = frame;
        if version == 4 && format_flag & 0x02 != 0 {
            data = unsync(&data);
        }
        if version == 4 && format_flag & 0x01 != 0 && data.len() >= 4 {
            data.drain(0..4);
        }
        let Some((rank, mime, bytes)) = parse_picture(version, &data) else { continue };
        if best.as_ref().is_none_or(|(old, _, _)| rank < *old) {
            best = Some((rank, mime, bytes));
        }
        if rank == 0 {
            break;
        }
    }
    best.map(|(_, mime, bytes)| (mime, bytes))
}

fn parse_picture(version: u8, data: &[u8]) -> Option<(u8, String, Vec<u8>)> {
    if data.is_empty() {
        return None;
    }
    let encoding = data[0];
    let mut cursor = 1;
    let mime = if version == 2 {
        if data.len() < 5 {
            return None;
        }
        let format = std::str::from_utf8(&data[1..4]).ok()?.to_ascii_uppercase();
        cursor = 4;
        match format.as_str() {
            "JPG" | "JPEG" => "image/jpeg".to_string(),
            "PNG" => "image/png".to_string(),
            _ => return None,
        }
    } else {
        let end = data[cursor..].iter().position(|byte| *byte == 0)?;
        let mime = String::from_utf8_lossy(&data[cursor..cursor + end]).to_ascii_lowercase();
        cursor += end + 1;
        if mime.is_empty() || mime == "-->" {
            return None;
        }
        mime
    };
    if cursor >= data.len() {
        return None;
    }
    let kind = data[cursor];
    cursor += 1;
    cursor += skip_text(&data[cursor..], encoding);
    if cursor >= data.len() || data.len() - cursor > 8 * 1024 * 1024 {
        return None;
    }
    let bytes = data[cursor..].to_vec();
    let mime = image_mime(&mime, &bytes)?;
    let rank = match kind {
        3 => 0,
        0 => 1,
        _ => 2,
    };
    Some((rank, mime, bytes))
}

fn image_mime(mime: &str, bytes: &[u8]) -> Option<String> {
    let magic = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if mime.contains("png") {
        "image/png"
    } else if mime.contains("gif") {
        "image/gif"
    } else if mime.contains("webp") {
        "image/webp"
    } else if mime.contains("jpeg") || mime.contains("jpg") {
        "image/jpeg"
    } else {
        return None;
    };
    Some(magic.to_string())
}

fn skip_text(data: &[u8], encoding: u8) -> usize {
    if encoding == 1 || encoding == 2 {
        let mut index = 0;
        while index + 1 < data.len() {
            if data[index] == 0 && data[index + 1] == 0 {
                return index + 2;
            }
            index += 2;
        }
        return data.len();
    }
    data.iter().position(|byte| *byte == 0).map(|index| index + 1).unwrap_or(data.len())
}

fn synchsafe(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 4 || bytes.iter().any(|byte| byte & 0x80 != 0) {
        return None;
    }
    Some(((bytes[0] as u32) << 21) | ((bytes[1] as u32) << 14) | ((bytes[2] as u32) << 7) | bytes[3] as u32)
}

fn read_be(bytes: &[u8]) -> Option<usize> {
    let mut value = 0usize;
    for byte in bytes {
        value = value.checked_shl(8)?.checked_add(*byte as usize)?;
    }
    Some(value)
}

fn unsync(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        out.push(data[index]);
        if data[index] == 0xFF && index + 1 < data.len() && data[index + 1] == 0 {
            index += 2;
        } else {
            index += 1;
        }
    }
    out
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
        "xlsx" | "xls" => "xlsx",
        "pptx" | "ppt" | "potx" | "pot" | "ppsx" | "pps" | "odt" | "doc" => "document",
        "zip" => "zip",
        "gz" | "gzip" | "tgz" => "gz",
        "mp3" | "wav" | "ogg" | "oga" | "flac" | "m4a" | "aac" | "opus" | "wma" => "audio",
        "mp4" | "m4v" | "webm" | "ogv" | "mov" | "mkv" | "vob" => "video",
        "7z" | "rar" | "exe" | "dll" => "binary",
        "txt" | "md" | "markdown" | "json" | "jsonl" | "log" | "xml" | "html" | "htm" | "css" | "js" | "jsx" | "ts" | "tsx" | "rs" | "py" | "toml" | "yaml" | "yml" | "ini" | "php" | "sh" | "ps1" | "bat" | "cmd" | "sql" | "c" | "h" | "cpp" | "cs" | "go" | "java" | "rb" => "text",
        _ => "auto",
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

#[cfg(windows)]
fn fast_jpeg(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    use image::ImageEncoder;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat24bppBGR, IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone,
        WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand, WICRect,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "Can't read that picture.".to_string())?;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let decoder = factory
            .CreateDecoderFromFilename(PCWSTR(wide.as_ptr()), None, windows::Win32::Foundation::GENERIC_READ, WICDecodeMetadataCacheOnDemand)
            .map_err(|_| "Can't read that picture.".to_string())?;
        let frame = decoder.GetFrame(0).map_err(|_| "Can't read that picture.".to_string())?;
        let source: IWICBitmapSource = frame.cast().map_err(|_| "Can't read that picture.".to_string())?;
        let mut width = 0u32;
        let mut height = 0u32;
        source.GetSize(&mut width, &mut height).map_err(|_| "Can't read that picture.".to_string())?;
        if width == 0 || height == 0 {
            return Err("Can't read that picture.".into());
        }
        let long = width.max(height);
        let (tw, th) = if long <= PREVIEW_EDGE {
            (width, height)
        } else {
            (
                ((width as u64 * PREVIEW_EDGE as u64) / long as u64).max(1) as u32,
                ((height as u64 * PREVIEW_EDGE as u64) / long as u64).max(1) as u32,
            )
        };
        let scaler = factory.CreateBitmapScaler().map_err(|_| "Can't read that picture.".to_string())?;
        scaler.Initialize(&source, tw, th, WICBitmapInterpolationModeFant).map_err(|_| "Can't read that picture.".to_string())?;
        let scaled: IWICBitmapSource = scaler.cast().map_err(|_| "Can't read that picture.".to_string())?;
        let converter = factory.CreateFormatConverter().map_err(|_| "Can't read that picture.".to_string())?;
        converter
            .Initialize(&scaled, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
            .map_err(|_| "Can't read that picture.".to_string())?;
        let pixels_source: IWICBitmapSource = converter.cast().map_err(|_| "Can't read that picture.".to_string())?;
        let stride = (tw * 3 + 3) & !3;
        let mut pixels = vec![0u8; stride as usize * th as usize];
        let rect = WICRect { X: 0, Y: 0, Width: tw as i32, Height: th as i32 };
        pixels_source.CopyPixels(&rect, stride, &mut pixels).map_err(|_| "Can't read that picture.".to_string())?;
        let mut rgb = Vec::with_capacity((tw as usize) * (th as usize) * 3);
        for y in 0..th {
            let row = &pixels[(y * stride) as usize..];
            for x in 0..tw {
                let index = (x * 3) as usize;
                rgb.push(row[index + 2]);
                rgb.push(row[index + 1]);
                rgb.push(row[index]);
            }
        }
        let mut out = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
            .write_image(&rgb, tw, th, image::ExtendedColorType::Rgb8)
            .map_err(|_| "That picture is too large to preview.".to_string())?;
        Ok((out.into_inner(), width, height))
    }
}

#[cfg(not(windows))]
fn fast_jpeg(_path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    Err("That picture is too large to preview.".into())
}

#[cfg(test)]
mod tests {
    use super::id3_cover;

    #[test]
    fn slide_decks_are_not_refused_for_size() {
        assert!(super::document_byte_limit("pptx").is_none());
        assert!(super::document_byte_limit("ppt").is_none());
        assert!(super::document_byte_limit("potx").is_none());
        assert!(super::document_byte_limit("ppsx").is_none());
        assert_eq!(super::document_byte_limit("doc"), Some(super::MAX_DOC));
        assert_eq!(super::document_byte_limit("odt"), Some(super::MAX_DOC));
    }

    #[test]
    fn reads_the_front_cover_from_an_id3_tag() {
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 2, image::Rgb([12, 34, 56])))
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        let jpeg = jpeg.into_inner();
        let mut apic = vec![0u8];
        apic.extend(b"image/jpeg\0");
        apic.push(3);
        apic.extend(b"Cover\0");
        apic.extend(&jpeg);
        let mut body = Vec::new();
        body.extend(b"TIT2");
        body.extend(4u32.to_be_bytes());
        body.extend([0, 0]);
        body.extend([0, b'A', 0, 0]);
        body.extend(b"APIC");
        body.extend((apic.len() as u32).to_be_bytes());
        body.extend([0, 0]);
        body.extend(&apic);
        let mut file = b"ID3\x03\x00\x00".to_vec();
        let size = body.len() as u32;
        file.extend([
            ((size >> 21) & 0x7f) as u8,
            ((size >> 14) & 0x7f) as u8,
            ((size >> 7) & 0x7f) as u8,
            (size & 0x7f) as u8,
        ]);
        file.extend(body);
        let (mime, image) = id3_cover(&file).expect("cover");
        assert_eq!(mime, "image/jpeg");
        assert!(image.starts_with(&[0xFF, 0xD8, 0xFF]));
        assert!(image.len() > 32);
    }
}
