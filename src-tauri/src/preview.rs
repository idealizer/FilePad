use crate::{docs, gzipnav, slides, zipnav};
use base64::Engine;
use image::{ImageFormat, ImageReader};
use serde::Serialize;
use std::cell::Cell;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

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

static PREVIEW_GEN: AtomicU64 = AtomicU64::new(0);
thread_local! {
    static PREVIEW_TICKET: Cell<u64> = const { Cell::new(0) };
}

struct PreviewScope;

impl PreviewScope {
    fn enter() -> Self {
        let ticket = PREVIEW_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        PREVIEW_TICKET.set(ticket);
        Self
    }
}

impl Drop for PreviewScope {
    fn drop(&mut self) {
        PREVIEW_TICKET.set(0);
    }
}

fn live() -> Result<(), String> {
    let ticket = PREVIEW_TICKET.get();
    if ticket == 0 || PREVIEW_GEN.load(Ordering::Relaxed) == ticket {
        Ok(())
    } else {
        Err("cancelled".into())
    }
}

pub fn preview_file(raw: &str) -> Result<Preview, String> {
    let _scope = PreviewScope::enter();
    if crate::sftpnav::is_remote(raw) {
        live()?;
        let extension = extension_tail(raw);
        let limit = if is_deck(&extension) { u64::MAX } else { MAX_PREVIEW };
        let loaded = crate::sftpnav::read_capped(raw, limit)?;
        if is_deck(&extension) {
            return document_preview(&loaded.name, raw, loaded.size, &extension, &loaded.data);
        }
        return preview_bytes(raw, &loaded.name, loaded.size, loaded.data, loaded.truncated);
    }
    if let Some((archive, inner)) = zipnav::split(raw) {
        live()?;
        return preview_zip(&archive, &inner, raw.trim());
    }
    if let Some((archive, inner)) = gzipnav::split(raw) {
        live()?;
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
        live()?;
        match fast_jpeg(path) {
            Ok((jpeg, width, height)) => {
                live()?;
                return Ok(scaled_image(&name, raw.trim(), size, &extension, jpeg, width, height));
            }
            Err(err) if err == "cancelled" => return Err(err),
            Err(_) => {}
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
        live()?;
        let bytes = fs::read(path).map_err(|err| format!("Can't read that file: {err}"))?;
        live()?;
        return finish(kind, &name, raw.trim(), size, &extension, bytes, false);
    }
    if kind == "document" {
        if document_byte_limit(&extension).is_some_and(|limit| size > limit) {
            return Ok(shell("too-large", &name, raw.trim(), size, &extension));
        }
        live()?;
        let bytes = fs::read(path).map_err(|err| format!("Can't read that file: {err}"))?;
        live()?;
        return document_preview(&name, raw.trim(), size, &extension, &bytes);
    }
    if kind == "image" && size > MAX_PREVIEW {
        live()?;
        let bytes = fs::read(path).map_err(|err| format!("Can't read that file: {err}"))?;
        live()?;
        return Ok(shrunk_image(&name, raw.trim(), size, &extension, &bytes));
    }
    live()?;
    let file = File::open(path).map_err(|err| format!("Can't read that file: {err}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW).read_to_end(&mut bytes).map_err(|err| format!("Can't read that file: {err}"))?;
    let preview = finish(kind, &name, raw.trim(), size, &extension, bytes, size > MAX_PREVIEW)?;
    live()?;
    Ok(preview)
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

pub fn save_image(raw: &str, quarters: i32, flip_h: bool, flip_v: bool, tone: &str, spots: &[crate::convert::BlurSpot], strength: f32) -> Result<String, String> {
    if crate::sftpnav::is_remote(raw) {
        return Err("Copy the picture to this computer before saving a change.".into());
    }
    if zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() {
        return Err("Copy the picture out of the archive before saving a change.".into());
    }
    let plain = tone != "bw" && tone != "sepia";
    if quarters.rem_euclid(4) == 0 && !flip_h && !flip_v && plain && spots.is_empty() {
        return Ok(raw.trim().to_string());
    }
    let path = Path::new(raw.trim());
    let extension = extension_of(path);
    if extension == "svg" {
        return Err("SVG pictures stay as they are.".into());
    }
    let mut image = crate::convert::load_path(path)?;
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
    image = crate::convert::restyle(image, tone, spots, strength);
    crate::convert::save_edit(path, &image)
}

pub fn save_text(raw: &str, text: &str) -> Result<String, String> {
    if crate::sftpnav::is_remote(raw) {
        return Err("Copy the file to this computer before saving a change.".into());
    }
    if zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() {
        return Err("Copy the file out of the archive before saving a change.".into());
    }
    let path = Path::new(raw.trim());
    if !path.is_file() {
        return Err("That file is not on this computer.".into());
    }
    fs::write(path, text.as_bytes()).map_err(|err| format!("Can't save that file. {err}"))?;
    Ok(raw.trim().to_string())
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
    crate::convert::load_image(bytes).map_err(|_| "That picture is too large to preview.".to_string())
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

pub(crate) struct TrackCard {
    pub title: String,
    pub artist: String,
    pub cover: Option<(String, Vec<u8>)>,
}

pub(crate) fn track_card(path: &Path) -> TrackCard {
    let fallback = path.file_stem().and_then(|name| name.to_str()).filter(|name| !name.is_empty()).unwrap_or("Audio").to_string();
    let Some(bytes) = id3_file(path) else {
        return TrackCard { title: fallback, artist: String::new(), cover: None };
    };
    let tags = id3_tags(&bytes);
    TrackCard {
        title: tags.title.filter(|title| !title.is_empty()).unwrap_or(fallback),
        artist: tags.artist.unwrap_or_default(),
        cover: tags.cover.map(|(mime, image)| fit_cover(mime, image)),
    }
}

fn fit_cover(mime: String, image: Vec<u8>) -> (String, Vec<u8>) {
    if image.len() > PREVIEW_ORIGINAL as usize {
        if let Ok((jpeg, _, _)) = shrink_jpeg(&image) {
            return ("image/jpeg".to_string(), jpeg);
        }
    }
    (mime, image)
}

fn id3_file(path: &Path) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 10];
    file.read_exact(&mut header).ok()?;
    if &header[0..3] != b"ID3" {
        return None;
    }
    let size = synchsafe(&header[6..10])? as usize;
    let take = size.min(8 * 1024 * 1024);
    let mut body = vec![0u8; take];
    let read = file.read(&mut body).ok()?;
    body.truncate(read);
    let mut tagged = header.to_vec();
    tagged.extend(body);
    Some(tagged)
}

fn attach_cover_file(item: &mut Preview, path: &Path) {
    let Some(tagged) = id3_file(path) else { return };
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

struct Id3Tags {
    cover: Option<(String, Vec<u8>)>,
    title: Option<String>,
    artist: Option<String>,
}

fn id3_cover(file: &[u8]) -> Option<(String, Vec<u8>)> {
    id3_tags(file).cover
}

fn id3_tags(file: &[u8]) -> Id3Tags {
    let empty = Id3Tags { cover: None, title: None, artist: None };
    if file.len() < 10 || &file[0..3] != b"ID3" {
        return empty;
    }
    let version = file[3];
    if version != 2 && version != 3 && version != 4 {
        return empty;
    }
    let size = match synchsafe(&file[6..10]) {
        Some(size) => size as usize,
        None => return empty,
    };
    let end = 10 + size.min(file.len().saturating_sub(10));
    let mut body = file[10..end].to_vec();
    if file[5] & 0x80 != 0 {
        body = unsync(&body);
    }
    let header = if version == 2 { 6 } else { 10 };
    let mut best: Option<(u8, String, Vec<u8>)> = None;
    let mut title = None;
    let mut artist = None;
    let mut index = 0;
    while index + header <= body.len() {
        if body[index] == 0 {
            break;
        }
        let (id, data_size, format_flag) = if version == 2 {
            let id = std::str::from_utf8(&body[index..index + 3]).unwrap_or("");
            (id, match read_be(&body[index + 3..index + 6]) {
                Some(size) => size,
                None => break,
            }, 0u8)
        } else {
            let id = std::str::from_utf8(&body[index..index + 4]).unwrap_or("");
            let size = if version == 4 {
                match synchsafe(&body[index + 4..index + 8]) {
                    Some(size) => size as usize,
                    None => break,
                }
            } else {
                match read_be(&body[index + 4..index + 8]) {
                    Some(size) => size,
                    None => break,
                }
            };
            (id, size, body[index + 9])
        };
        let start = index + header;
        let Some(frame_end) = start.checked_add(data_size) else { break };
        if frame_end > body.len() {
            break;
        }
        let frame = body[start..frame_end].to_vec();
        index = frame_end;
        let id = id.to_string();
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
        if id == "APIC" || id == "PIC" {
            let Some((rank, mime, bytes)) = parse_picture(version, &data) else { continue };
            if best.as_ref().is_none_or(|(old, _, _)| rank < *old) {
                best = Some((rank, mime, bytes));
            }
        } else if (id == "TIT2" || id == "TT2") && title.is_none() {
            title = frame_text(&data);
        } else if (id == "TPE1" || id == "TP1") && artist.is_none() {
            artist = frame_text(&data);
        }
    }
    Id3Tags { cover: best.map(|(_, mime, bytes)| (mime, bytes)), title, artist }
}

fn frame_text(data: &[u8]) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    let raw = &data[1..];
    let text = match data[0] {
        0 => {
            let end = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
            raw[..end].iter().map(|byte| char::from(*byte)).collect()
        }
        1 => utf16_text(raw, true),
        2 => utf16_text(raw, false),
        3 => {
            let end = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).into_owned()
        }
        _ => return None,
    };
    let text = text.trim_matches(['\0', ' ']).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn utf16_text(raw: &[u8], bom: bool) -> String {
    let (big, body) = if bom && raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
        (false, &raw[2..])
    } else if bom && raw.len() >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
        (true, &raw[2..])
    } else if bom {
        (false, raw)
    } else {
        (true, raw)
    };
    let mut units = Vec::new();
    let mut index = 0;
    while index + 1 < body.len() {
        if body[index] == 0 && body[index + 1] == 0 {
            break;
        }
        let unit = if big { u16::from_be_bytes([body[index], body[index + 1]]) } else { u16::from_le_bytes([body[index], body[index + 1]]) };
        units.push(unit);
        index += 2;
    }
    String::from_utf16_lossy(&units)
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
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "bmp" | "ico" => "image",
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

fn read_orientation(path: &Path) -> image::metadata::Orientation {
    use image::ImageDecoder;
    let Ok(file) = File::open(path) else {
        return image::metadata::Orientation::NoTransforms;
    };
    let Ok(reader) = ImageReader::new(BufReader::new(file)).with_guessed_format() else {
        return image::metadata::Orientation::NoTransforms;
    };
    let Ok(mut decoder) = reader.into_decoder() else {
        return image::metadata::Orientation::NoTransforms;
    };
    decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms)
}

fn orient_preview(rgb: Vec<u8>, width: u32, height: u32, full_w: u32, full_h: u32, orientation: image::metadata::Orientation) -> (Vec<u8>, u32, u32, u32, u32) {
    use image::{DynamicImage, RgbImage};
    if orientation == image::metadata::Orientation::NoTransforms {
        return (rgb, width, height, full_w, full_h);
    }
    let pixels = (width as usize).saturating_mul(height as usize).saturating_mul(3);
    if rgb.len() != pixels {
        return (rgb, width, height, full_w, full_h);
    }
    let Some(buffer) = RgbImage::from_raw(width, height, rgb) else {
        return (Vec::new(), width, height, full_w, full_h);
    };
    let mut image = DynamicImage::ImageRgb8(buffer);
    image.apply_orientation(orientation);
    let swapped = matches!(
        orientation,
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    );
    let turned = image.to_rgb8();
    let tw = turned.width();
    let th = turned.height();
    let (full_w, full_h) = if swapped { (full_h, full_w) } else { (full_w, full_h) };
    (turned.into_raw(), tw, th, full_w, full_h)
}

#[cfg(windows)]
pub fn wic_image(path: &Path) -> Result<image::DynamicImage, String> {
    let (rgb, width, height, _, _) = read_wic(path, 32_000)?;
    let buffer = image::RgbImage::from_raw(width, height, rgb).ok_or_else(|| "Can't read that picture.".to_string())?;
    let mut image = image::DynamicImage::ImageRgb8(buffer);
    image.apply_orientation(read_orientation(path));
    Ok(image)
}

pub(crate) fn icon_jpeg(path: &Path, edge: u32) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use image::ImageEncoder;
        let (rgb, tw, th, width, height) = read_wic(path, edge)?;
        let orientation = read_orientation(path);
        let (rgb, tw, th, _, _) = orient_preview(rgb, tw, th, width, height, orientation);
        let mut out = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 75)
            .write_image(&rgb, tw, th, image::ExtendedColorType::Rgb8)
            .map_err(|_| "No picture for that file.".to_string())?;
        return Ok(out.into_inner());
    }
    #[cfg(not(windows))]
    {
        let _ = (path, edge);
        Err("No picture for that file.".into())
    }
}

#[cfg(windows)]
fn fast_jpeg(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    use image::ImageEncoder;
    live()?;
    let (rgb, tw, th, width, height) = read_wic(path, PREVIEW_EDGE)?;
    let orientation = read_orientation(path);
    let (rgb, tw, th, width, height) = orient_preview(rgb, tw, th, width, height, orientation);
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
        .write_image(&rgb, tw, th, image::ExtendedColorType::Rgb8)
        .map_err(|_| "That picture is too large to preview.".to_string())?;
    Ok((out.into_inner(), width, height))
}

#[cfg(windows)]
fn read_wic(path: &Path, max_edge: u32) -> Result<(Vec<u8>, u32, u32, u32, u32), String> {
    live()?;
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
        let (tw, th) = if long <= max_edge {
            (width, height)
        } else {
            (
                ((width as u64 * max_edge as u64) / long as u64).max(1) as u32,
                ((height as u64 * max_edge as u64) / long as u64).max(1) as u32,
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
        Ok((rgb, tw, th, width, height))
    }
}

#[cfg(not(windows))]
fn fast_jpeg(_path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    Err("That picture is too large to preview.".into())
}

#[cfg(test)]
mod tests {
    use super::id3_tags;

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
        let tags = id3_tags(&file);
        assert_eq!(tags.title.as_deref(), Some("A"));
        let (mime, image) = tags.cover.expect("cover");
        assert_eq!(mime, "image/jpeg");
        assert!(image.starts_with(&[0xFF, 0xD8, 0xFF]));
        assert!(image.len() > 32);
    }

    #[test]
    fn save_text_writes_the_same_file() {
        let path = std::env::temp_dir().join(format!("filepad-text-{}.txt", std::process::id()));
        std::fs::write(&path, "hello").unwrap();
        let saved = super::save_text(&path.to_string_lossy(), "hello\r\nthere").unwrap();
        assert_eq!(saved, path.to_string_lossy());
        assert_eq!(std::fs::read(&path).unwrap(), b"hello\r\nthere");
        assert!(super::save_text("zip:archive.zip|note.txt", "nope").is_err());
        let _ = std::fs::remove_file(path);
    }
}
