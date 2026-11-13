use base64::Engine;
use image::ImageEncoder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;

const PICTURE_EDGE: u32 = 1600;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SlidePage {
    width: f64,
    height: f64,
    count: usize,
    index: usize,
    slide: Slide,
}

#[derive(Serialize)]
struct Slide {
    background: String,
    shapes: Vec<Shape>,
}

#[derive(Serialize)]
struct Shape {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    fill: Option<String>,
    kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    paragraphs: Vec<Para>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    columns: Vec<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    rows: Vec<TableRow>,
}

#[derive(Serialize)]
struct Para {
    align: String,
    runs: Vec<Run>,
}

#[derive(Serialize)]
struct Run {
    text: String,
    size: f64,
    bold: bool,
    color: String,
}

#[derive(Serialize)]
struct TableRow {
    height: f64,
    cells: Vec<Cell>,
}

#[derive(Serialize)]
struct Cell {
    #[serde(skip_serializing_if = "Option::is_none")]
    fill: Option<String>,
    paragraphs: Vec<Para>,
}

pub fn slides_json(bytes: &[u8]) -> Result<String, String> {
    slide_page(bytes, 0)
}

pub fn slide_page(bytes: &[u8], index: usize) -> Result<String, String> {
    slide_page_keyed("", bytes, index)
}

pub fn slide_page_keyed(key: &str, bytes: &[u8], index: usize) -> Result<String, String> {
    if bytes.len() >= 8 && bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        let page = ppt_model(bytes, index)?;
        return serde_json::to_string(&page).map_err(|_| "Can't read that presentation.".to_string());
    }
    crate::deckpaint::raster_page(key, bytes, index)
}

fn picture_url(bytes: &[u8]) -> Option<String> {
    let image = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?.decode().ok()?;
    let long = image.width().max(image.height());
    let image = if long > PICTURE_EDGE {
        let scale = PICTURE_EDGE as f64 / long as f64;
        let width = ((image.width() as f64) * scale).max(1.0) as u32;
        let height = ((image.height() as f64) * scale).max(1.0) as u32;
        image.resize(width, height, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let mut buffer = Cursor::new(Vec::new());
    if image.color().has_alpha() {
        image.write_to(&mut buffer, image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buffer.into_inner())))
    } else {
        let rgb = image.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 80)
            .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .ok()?;
        Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(buffer.into_inner())))
    }
}

const OLE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const CP1252: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

struct Rec<'a> {
    typ: u16,
    version: u8,
    instance: u16,
    body: &'a [u8],
}

struct Located {
    width: f64,
    height: f64,
    count: usize,
    index: usize,
    texts: Vec<String>,
    body: Vec<u8>,
}

fn ppt_model(bytes: &[u8], index: usize) -> Result<SlidePage, String> {
    let document = ole_stream(bytes, "PowerPoint Document")?;
    let located = locate_ppt(&document, index)?;
    let pictures = if slide_wants_picture(&located.body) { ole_stream(bytes, "Pictures").unwrap_or_default() } else { Vec::new() };
    page_from(located, &pictures)
}

fn ppt_from_streams(document: &[u8], pictures: &[u8], index: usize) -> Result<SlidePage, String> {
    page_from(locate_ppt(document, index)?, pictures)
}

fn page_from(located: Located, pictures: &[u8]) -> Result<SlidePage, String> {
    let payloads = blip_payloads(pictures);
    let mut cache = HashMap::new();
    let slide = ppt_slide(&located.body, &located.texts, located.width, located.height, &payloads, &mut cache);
    Ok(SlidePage { width: located.width, height: located.height, count: located.count, index: located.index, slide })
}

fn locate_ppt(document: &[u8], index: usize) -> Result<Located, String> {
    let mut width = 720.0;
    let mut height = 540.0;
    let mut persist: HashMap<u32, usize> = HashMap::new();
    let mut lists: Vec<Vec<u8>> = Vec::new();
    walk_records(document, &mut |typ, version, body| {
        if typ == 0x03E9 && version != 0xF && body.len() >= 8 {
            let units_w = i32::from_le_bytes(body[0..4].try_into().unwrap());
            let units_h = i32::from_le_bytes(body[4..8].try_into().unwrap());
            if units_w > 0 && units_h > 0 {
                width = units_w as f64 / 8.0;
                height = units_h as f64 / 8.0;
            }
        }
        if typ == 0x1772 && version != 0xF {
            merge_persist(body, &mut persist);
        }
        if typ == 0x0FF0 && version == 0xF {
            lists.push(body.to_vec());
        }
    });
    let list = lists.iter().max_by_key(|body| records(body).iter().filter(|rec| rec.typ == 0x03F3).count()).ok_or("That presentation has no slides.")?;
    let mut found = Vec::new();
    for (pid, texts) in listed_slides(list) {
        let Some(offset) = persist.get(&pid).copied() else { continue };
        let Some(slide) = record_at(document, offset) else { continue };
        if slide.typ != 0x03EE {
            continue;
        }
        found.push((texts, offset));
    }
    if found.is_empty() {
        return Err("That presentation has no slides.".into());
    }
    let count = found.len();
    let index = index.min(count - 1);
    let (texts, offset) = found.swap_remove(index);
    let body = record_at(document, offset).map(|slide| slide.body.to_vec()).unwrap_or_default();
    Ok(Located { width, height, count, index, texts, body })
}

fn slide_wants_picture(body: &[u8]) -> bool {
    let mut shapes = Vec::new();
    collect_shapes(body, &mut shapes);
    shapes.iter().any(|shape| shape.blip.is_some_and(|index| index >= 1))
}

fn ppt_slide(body: &[u8], texts: &[String], width: f64, height: f64, payloads: &[Option<&[u8]>], cache: &mut HashMap<usize, Option<String>>) -> Slide {
    let mut drawn = Vec::new();
    collect_shapes(body, &mut drawn);
    let mut shapes = Vec::new();
    for shape in drawn {
        let Some((x, y, w, h)) = shape.anchor else { continue };
        if x > width + 40.0 || y > height + 40.0 {
            continue;
        }
        let raw = if !shape.inline.trim().is_empty() {
            shape.inline.clone()
        } else if let Some(index) = shape.reference.filter(|index| *index >= 0) {
            texts.get(index as usize).cloned().unwrap_or_default()
        } else {
            String::new()
        };
        let lines = ppt_lines(&raw);
        let image = shape.blip.filter(|index| *index >= 1).and_then(|index| blip_url(index as usize - 1, payloads, cache));
        if lines.is_empty() && image.is_none() && shape.fill.is_none() {
            continue;
        }
        let size = if lines.is_empty() {
            18.0
        } else {
            ((h * 0.82) / lines.len() as f64 / 1.15).clamp(12.0, 40.0)
        };
        let bold = matches!(shape.header, Some(0 | 6)) || size >= 28.0;
        let color = ink(shape.fill.as_deref());
        let paragraphs = lines
            .into_iter()
            .map(|line| Para {
                align: "left".into(),
                runs: vec![Run { text: line, size, bold, color: color.clone() }],
            })
            .collect::<Vec<_>>();
        let kind = if image.is_some() {
            "picture"
        } else if !paragraphs.is_empty() {
            "text"
        } else {
            "box"
        };
        shapes.push(Shape {
            x,
            y,
            w,
            h,
            fill: shape.fill,
            kind: kind.into(),
            paragraphs,
            image,
            columns: Vec::new(),
            rows: Vec::new(),
        });
    }
    Slide { background: "#ffffff".into(), shapes }
}

struct PptShape {
    anchor: Option<(f64, f64, f64, f64)>,
    inline: String,
    reference: Option<i32>,
    header: Option<i32>,
    blip: Option<u32>,
    fill: Option<String>,
}

fn collect_shapes(body: &[u8], out: &mut Vec<PptShape>) {
    for rec in records(body) {
        if rec.typ == 0xF004 {
            if let Some(shape) = ppt_shape(&rec) {
                out.push(shape);
            }
        } else if rec.version == 0xF {
            collect_shapes(rec.body, out);
        }
    }
}

fn ppt_shape(rec: &Rec<'_>) -> Option<PptShape> {
    let mut shape = PptShape {
        anchor: None,
        inline: String::new(),
        reference: None,
        header: None,
        blip: None,
        fill: None,
    };
    for child in records(rec.body) {
        match child.typ {
            0xF010 if child.body.len() >= 8 => {
                let left = i16::from_le_bytes(child.body[0..2].try_into().unwrap());
                let top = i16::from_le_bytes(child.body[2..4].try_into().unwrap());
                let right = i16::from_le_bytes(child.body[4..6].try_into().unwrap());
                let bottom = i16::from_le_bytes(child.body[6..8].try_into().unwrap());
                shape.anchor = anchor_box(left, top, right, bottom);
            }
            0xF00B => {
                let (blip, fill) = fopt(&child);
                shape.blip = blip;
                shape.fill = fill;
            }
            0xF00D => read_textbox(&child, &mut shape),
            _ => {}
        }
    }
    if shape.anchor.is_none() {
        return None;
    }
    Some(shape)
}

fn read_textbox(rec: &Rec<'_>, shape: &mut PptShape) {
    for child in records(rec.body) {
        match child.typ {
            0x0F9F if child.body.len() >= 4 => shape.header = Some(i32::from_le_bytes(child.body[0..4].try_into().unwrap())),
            0x0FA0 => shape.inline.push_str(&utf16_text(child.body)),
            0x0FA8 => shape.inline.push_str(&cp1252_text(child.body)),
            0x0F9E if child.body.len() >= 4 => shape.reference = Some(i32::from_le_bytes(child.body[0..4].try_into().unwrap())),
            _ => {}
        }
    }
}

fn anchor_box(left: i16, top: i16, right: i16, bottom: i16) -> Option<(f64, f64, f64, f64)> {
    let x = i16::min(left, right) as f64 / 8.0;
    let y = i16::min(top, bottom) as f64 / 8.0;
    let w = (i16::max(left, right) as f64 / 8.0) - x;
    let h = (i16::max(top, bottom) as f64 / 8.0) - y;
    if w < 2.0 || h < 2.0 {
        return None;
    }
    Some((x, y, w, h))
}

fn fopt(rec: &Rec<'_>) -> (Option<u32>, Option<String>) {
    let count = (rec.instance as usize).min(rec.body.len() / 6);
    let mut blip = None;
    let mut fill = None;
    let mut no_fill = false;
    for index in 0..count {
        let at = index * 6;
        let opid = u16::from_le_bytes(rec.body[at..at + 2].try_into().unwrap());
        let value = u32::from_le_bytes(rec.body[at + 2..at + 6].try_into().unwrap());
        if opid & 0x8000 != 0 {
            continue;
        }
        match opid & 0x3FFF {
            0x0104 => blip = Some(value),
            0x0181 if value >> 24 == 0 => fill = Some(format!("#{:02X}{:02X}{:02X}", value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF)),
            0x01BF => no_fill = value & 0x1_0000 != 0 && value & 1 != 0,
            _ => {}
        }
    }
    if no_fill {
        fill = None;
    }
    (blip, fill)
}

fn listed_slides(body: &[u8]) -> Vec<(u32, Vec<String>)> {
    let mut slides = Vec::new();
    let mut current: Option<(u32, Vec<String>)> = None;
    for rec in records(body) {
        if rec.typ == 0x03F3 && rec.body.len() >= 4 {
            if let Some(slide) = current.take() {
                slides.push(slide);
            }
            let pid = u32::from_le_bytes(rec.body[0..4].try_into().unwrap());
            current = Some((pid, Vec::new()));
        } else if let Some((_, texts)) = current.as_mut() {
            if rec.typ == 0x0FA0 {
                texts.push(utf16_text(rec.body));
            } else if rec.typ == 0x0FA8 {
                texts.push(cp1252_text(rec.body));
            }
        }
    }
    if let Some(slide) = current {
        slides.push(slide);
    }
    slides
}

fn merge_persist(body: &[u8], persist: &mut HashMap<u32, usize>) {
    let mut at = 0;
    while at + 4 <= body.len() {
        let word = u32::from_le_bytes(body[at..at + 4].try_into().unwrap());
        at += 4;
        let pid = word & 0xF_FFFF;
        let count = (word >> 20) & 0xFFF;
        for step in 0..count {
            if at + 4 > body.len() {
                return;
            }
            let offset = u32::from_le_bytes(body[at..at + 4].try_into().unwrap()) as usize;
            at += 4;
            persist.insert(pid + step, offset);
        }
    }
}

fn blip_payloads(pictures: &[u8]) -> Vec<Option<&[u8]>> {
    records(pictures)
        .into_iter()
        .map(|rec| match rec.typ {
            0xF01D | 0xF01E => {
                let uid = if rec.instance == 0x6E1 || rec.instance == 0x6E2 { 32 } else { 16 };
                let start = uid + 1;
                if rec.body.len() > start { Some(&rec.body[start..]) } else { None }
            }
            _ => None,
        })
        .collect()
}

fn blip_url(index: usize, payloads: &[Option<&[u8]>], cache: &mut HashMap<usize, Option<String>>) -> Option<String> {
    if let Some(cached) = cache.get(&index) {
        return cached.clone();
    }
    let url = payloads.get(index).and_then(|payload| payload.as_ref()).and_then(|bytes| picture_url(bytes));
    cache.insert(index, url.clone());
    url
}

fn ppt_lines(raw: &str) -> Vec<String> {
    raw.split(['\r', '\n', '\u{000b}'])
        .map(|line| line.replace('\u{0000}', ""))
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn ink(fill: Option<&str>) -> String {
    let Some(hex) = fill.filter(|value| value.len() == 7) else {
        return "#1a1a1a".into();
    };
    let Ok(r) = u8::from_str_radix(&hex[1..3], 16) else { return "#1a1a1a".into() };
    let Ok(g) = u8::from_str_radix(&hex[3..5], 16) else { return "#1a1a1a".into() };
    let Ok(b) = u8::from_str_radix(&hex[5..7], 16) else { return "#1a1a1a".into() };
    let luminance = 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
    if luminance < 140.0 { "#ffffff".into() } else { "#1a1a1a".into() }
}

fn utf16_text(body: &[u8]) -> String {
    let units = body.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn cp1252_text(body: &[u8]) -> String {
    body.iter()
        .map(|byte| match *byte {
            0x00..=0x7F => *byte as char,
            0x80..=0x9F => CP1252[(*byte - 0x80) as usize],
            _ => *byte as char,
        })
        .collect()
}

fn walk_records(buf: &[u8], visit: &mut impl FnMut(u16, u8, &[u8])) {
    for rec in records(buf) {
        visit(rec.typ, rec.version, rec.body);
        if rec.version == 0xF {
            walk_records(rec.body, visit);
        }
    }
}

fn records(buf: &[u8]) -> Vec<Rec<'_>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 8 <= buf.len() {
        let ver_inst = u16::from_le_bytes(buf[at..at + 2].try_into().unwrap());
        let typ = u16::from_le_bytes(buf[at + 2..at + 4].try_into().unwrap());
        let len = u32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()) as usize;
        if len > buf.len() - (at + 8) {
            break;
        }
        out.push(Rec {
            typ,
            version: (ver_inst & 0xF) as u8,
            instance: ver_inst >> 4,
            body: &buf[at + 8..at + 8 + len],
        });
        at += 8 + len;
    }
    out
}

fn record_at(buf: &[u8], offset: usize) -> Option<Rec<'_>> {
    if offset + 8 > buf.len() {
        return None;
    }
    let ver_inst = u16::from_le_bytes(buf[offset..offset + 2].try_into().ok()?);
    let typ = u16::from_le_bytes(buf[offset + 2..offset + 4].try_into().ok()?);
    let len = u32::from_le_bytes(buf[offset + 4..offset + 8].try_into().ok()?) as usize;
    if len > buf.len() - (offset + 8) {
        return None;
    }
    Some(Rec {
        typ,
        version: (ver_inst & 0xF) as u8,
        instance: ver_inst >> 4,
        body: &buf[offset + 8..offset + 8 + len],
    })
}

pub(crate) fn ole_stream(bytes: &[u8], wanted: &str) -> Result<Vec<u8>, String> {
    if bytes.len() < 512 || bytes[..8] != OLE_MAGIC {
        return Err("Can't read that presentation.".into());
    }
    let sector = 1usize << u16_at(bytes, 0x1E)?;
    if sector < 512 || sector > bytes.len() {
        return Err("Can't read that presentation.".into());
    }
    let major = u16_at(bytes, 0x1A)?;
    let first_dir = u32_at(bytes, 0x30)?;
    let cutoff = u32_at(bytes, 0x38)? as u64;
    let mut fat_sectors = Vec::new();
    for index in 0..109 {
        let sector_id = u32_at(bytes, 0x4C + index * 4)?;
        if sector_id < 0xFFFF_FFF0 {
            fat_sectors.push(sector_id);
        }
    }
    let mut difat = u32_at(bytes, 0x44)?;
    let difat_count = u32_at(bytes, 0x48)?;
    let mut guard = 0u32;
    while difat < 0xFFFF_FFF0 && guard <= difat_count {
        let offset = (difat as usize + 1) * sector;
        if offset + sector > bytes.len() {
            break;
        }
        let entries = sector / 4 - 1;
        for index in 0..entries {
            let sector_id = u32_at(bytes, offset + index * 4)?;
            if sector_id < 0xFFFF_FFF0 {
                fat_sectors.push(sector_id);
            }
        }
        difat = u32_at(bytes, offset + entries * 4)?;
        guard += 1;
    }
    let mut fat = Vec::new();
    for sector_id in fat_sectors {
        let offset = (sector_id as usize + 1) * sector;
        if offset + sector > bytes.len() {
            break;
        }
        for index in 0..(sector / 4) {
            fat.push(u32_at(bytes, offset + index * 4)?);
        }
    }
    let directory = read_chain(bytes, &fat, first_dir, 2_000_000, sector, true);
    let mut found: Option<(u32, u64)> = None;
    let mut root: Option<(u32, u64)> = None;
    let mut at = 0;
    while at + 128 <= directory.len() {
        let entry = &directory[at..at + 128];
        at += 128;
        let name_len = u16::from_le_bytes(entry[64..66].try_into().unwrap());
        let kind = entry[66];
        if name_len < 2 || name_len > 64 || kind == 0 {
            continue;
        }
        let chars = (name_len as usize / 2).saturating_sub(1);
        let units = entry[..chars * 2].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        let name = String::from_utf16_lossy(&units);
        let start = u32::from_le_bytes(entry[116..120].try_into().unwrap());
        let size = if major >= 4 {
            u64::from_le_bytes(entry[120..128].try_into().unwrap())
        } else {
            u32::from_le_bytes(entry[120..124].try_into().unwrap()) as u64
        };
        if kind == 5 {
            root = Some((start, size));
        } else if kind == 2 && name == wanted {
            found = Some((start, size));
        }
    }
    let Some((start, size)) = found else {
        return Err("Can't read that presentation.".into());
    };
    if size == 0 {
        return Ok(Vec::new());
    }
    if size < cutoff {
        let Some((root_start, root_size)) = root else {
            return Err("Can't read that presentation.".into());
        };
        let mini_shift = u16_at(bytes, 0x20)? as usize;
        let mini_size = 1usize << mini_shift;
        let mini_fat_start = u32_at(bytes, 0x3C)?;
        let mini_fat_bytes = read_chain(bytes, &fat, mini_fat_start, (u32_at(bytes, 0x40)? as usize).saturating_mul(sector).max(mini_size), sector, true);
        let mini_fat = mini_fat_bytes.chunks_exact(4).map(|item| u32::from_le_bytes(item.try_into().unwrap())).collect::<Vec<_>>();
        let mini_stream = read_chain(bytes, &fat, root_start, root_size as usize, sector, true);
        return Ok(read_chain(&mini_stream, &mini_fat, start, size as usize, mini_size, false));
    }
    Ok(read_chain(bytes, &fat, start, size as usize, sector, true))
}

fn read_chain(file: &[u8], fat: &[u32], start: u32, size: usize, sector: usize, file_sectors: bool) -> Vec<u8> {
    if sector == 0 || size == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut sector_id = start;
    let mut seen = HashSet::new();
    while (sector_id as u64) < 0xFFFF_FFF0 && out.len() < size && seen.insert(sector_id) {
        let offset = if file_sectors {
            (sector_id as usize + 1).saturating_mul(sector)
        } else {
            (sector_id as usize).saturating_mul(sector)
        };
        if offset >= file.len() {
            break;
        }
        let end = (offset + sector).min(file.len());
        out.extend_from_slice(&file[offset..end]);
        sector_id = fat.get(sector_id as usize).copied().unwrap_or(0xFFFF_FFFE);
    }
    out.truncate(size);
    out
}

fn u16_at(buf: &[u8], at: usize) -> Result<u16, String> {
    let bytes = buf.get(at..at + 2).ok_or("Can't read that presentation.")?;
    Ok(u16::from_le_bytes(bytes.try_into().unwrap()))
}

fn u32_at(buf: &[u8], at: usize) -> Result<u32, String> {
    let bytes = buf.get(at..at + 4).ok_or("Can't read that presentation.")?;
    Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::slides_json;
    use image::ImageEncoder;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn zip_with(files: &[(&str, &str)]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            for (name, body) in files {
                zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn filled_slide(color: &str) -> String {
        format!(
            r#"<p:sld><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld></p:sld>"#
        )
    }

    #[test]
    fn paints_one_pptx_slide_as_a_jpeg() {
        let slide = filled_slide("FF0000");
        let bytes = zip_with(&[
            ("[Content_Types].xml", r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#),
            ("ppt/presentation.xml", r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#),
            ("ppt/_rels/presentation.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#),
            ("ppt/slides/slide1.xml", slide.as_str()),
        ]);
        let json = slides_json(&bytes).unwrap();
        let page: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(page["count"], 1);
        assert_eq!(page["index"], 0);
        assert!(page["width"].as_f64().unwrap_or(0.0) > 100.0);
        assert!(page["height"].as_f64().unwrap_or(0.0) > 100.0);
        let image = page["image"].as_str().unwrap();
        assert!(image.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn reads_only_the_requested_slide() {
        let red = filled_slide("FF0000");
        let blue = filled_slide("0000FF");
        let bytes = zip_with(&[
            ("[Content_Types].xml", r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#),
            ("ppt/presentation.xml", r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>"#),
            ("ppt/_rels/presentation.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>"#),
            ("ppt/slides/slide1.xml", red.as_str()),
            ("ppt/slides/slide2.xml", blue.as_str()),
        ]);
        let first = super::slide_page(&bytes, 0).unwrap();
        let second = super::slide_page(&bytes, 1).unwrap();
        let first_page: serde_json::Value = serde_json::from_str(&first).unwrap();
        let second_page: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_eq!(first_page["count"], 2);
        assert_eq!(first_page["index"], 0);
        assert_eq!(second_page["index"], 1);
        let first_image = first_page["image"].as_str().unwrap();
        let second_image = second_page["image"].as_str().unwrap();
        assert!(first_image.starts_with("data:image/jpeg;base64,"));
        assert_ne!(first_image, second_image);
        assert!(!first_image.contains(second_image.trim_start_matches("data:image/jpeg;base64,")));
    }

    fn record(version: u8, instance: u16, typ: u16, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let ver_inst = ((instance & 0x0FFF) << 4) | (version as u16 & 0x0F);
        out.extend_from_slice(&ver_inst.to_le_bytes());
        out.extend_from_slice(&typ.to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn draws_a_binary_ppt_slide() {
        let mut atom = vec![0u8; 16];
        atom[0..4].copy_from_slice(&5760i32.to_le_bytes());
        atom[4..8].copy_from_slice(&4320i32.to_le_bytes());
        let document_atom = record(0, 0, 0x03E9, &atom);
        let mut title = Vec::new();
        for unit in "Hello slide".encode_utf16() {
            title.extend_from_slice(&unit.to_le_bytes());
        }
        let mut list = record(0, 0, 0x03F3, &1u32.to_le_bytes());
        list.extend(record(0, 0, 0x0FA0, &title));
        let slide_list = record(0xF, 0, 0x0FF0, &list);
        let anchor = record(0, 0, 0xF010, &{
            let mut bytes = Vec::new();
            for value in [80i16, 80, 4000, 800] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        });
        let textbox = record(0xF, 0, 0xF00D, &record(0, 0, 0x0F9E, &0i32.to_le_bytes()));
        let text_shape = record(0xF, 0, 0xF004, &[anchor.clone(), textbox].concat());
        let mut label = Vec::new();
        label.extend_from_slice(&[b'G', b'r', 0xFC, 0xDF, b'e']);
        let inline = record(0xF, 0, 0xF00D, &record(0, 0, 0x0FA8, &label));
        let lower = record(0, 0, 0xF010, &{
            let mut bytes = Vec::new();
            for value in [80i16, 1000, 4000, 3000] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        });
        let mut fill = Vec::new();
        fill.extend_from_slice(&0x0181u16.to_le_bytes());
        fill.extend_from_slice(&0x0000_00FFu32.to_le_bytes());
        let filled = record(0xF, 0, 0xF004, &[lower, record(0, 1, 0xF00B, &fill), inline].concat());
        let picture_anchor = record(0, 0, 0xF010, &{
            let mut bytes = Vec::new();
            for value in [4200i16, 80, 5600, 1600] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        });
        let mut blip = Vec::new();
        blip.extend_from_slice(&0x0104u16.to_le_bytes());
        blip.extend_from_slice(&1u32.to_le_bytes());
        let picture = record(0xF, 0, 0xF004, &[picture_anchor, record(0, 1, 0xF00B, &blip)].concat());
        let drawing = record(0xF, 0, 0x040C, &record(0xF, 0, 0xF003, &[text_shape, filled, picture].concat()));
        let slide = record(0xF, 0, 0x03EE, &drawing);
        let mut document = Vec::new();
        document.extend(document_atom);
        document.extend(slide_list);
        let slide_at = document.len() as u32;
        document.extend(slide);
        let mut directory = Vec::new();
        directory.extend_from_slice(&(1u32 | (1 << 20)).to_le_bytes());
        directory.extend_from_slice(&slide_at.to_le_bytes());
        document.extend(record(0, 0, 0x1772, &directory));

        let image = image::RgbImage::from_pixel(2, 2, image::Rgb([200, 10, 10]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
            .write_image(image.as_raw(), 2, 2, image::ExtendedColorType::Rgb8)
            .unwrap();
        let mut payload = vec![0u8; 16];
        payload.push(0xFF);
        payload.extend(jpeg);
        let pictures = record(0, 0x46A, 0xF01D, &payload);

        let json = super::ppt_from_streams(&document, &pictures, 0).map(|page| serde_json::to_string(&page).unwrap()).unwrap();
        let deck: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(deck["count"], 1);
        assert_eq!(deck["index"], 0);
        assert_eq!(deck["width"], 720.0);
        assert_eq!(deck["height"], 540.0);
        let shapes = deck["slide"]["shapes"].as_array().unwrap();
        assert!(shapes.iter().any(|shape| shape["kind"] == "text" && shape["paragraphs"][0]["runs"][0]["text"] == "Hello slide"));
        assert!(shapes.iter().any(|shape| shape["fill"] == "#FF0000" && shape["paragraphs"][0]["runs"][0]["text"] == "Grüße"));
        assert!(shapes.iter().any(|shape| shape["kind"] == "picture" && shape["image"].as_str().unwrap_or("").starts_with("data:image/jpeg")));
    }
}
