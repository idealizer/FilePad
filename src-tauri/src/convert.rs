use crate::{gzipnav, zipnav};
use image::imageops::{blur, crop_imm, overlay, FilterType};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

fn blur_sigma(strength: f32) -> f32 {
    if strength.is_finite() { strength.clamp(1.0, 64.0) } else { 16.0 }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlurSpot {
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default = "blur_mode")]
    pub mode: String,
}

fn blur_mode() -> String {
    "blur".into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertReport {
    pub written: u32,
    pub skipped: u32,
    pub reason: Option<String>,
}

pub fn convert_images(paths: &[String], format: &str, quality: u8, background: &str, replace: bool) -> Result<ConvertReport, String> {
    let format = normalize_format(format)?;
    if paths.iter().any(|path| zipnav::split(path).is_some() || gzipnav::split(path).is_some() || path.trim().starts_with("sftp:")) {
        return Err("Copy the picture out of the archive before converting it.".into());
    }
    let quality = quality.clamp(1, 100);
    let mut written = 0u32;
    let mut skipped = 0u32;
    let mut reason = None;
    let mut claimed = HashSet::new();
    for raw in paths {
        match convert_one(raw, format, quality, background, replace, &mut claimed) {
            Ok(()) => written += 1,
            Err(skip) => {
                skipped += 1;
                if reason.is_none() {
                    reason = Some(skip);
                }
            }
        }
    }
    Ok(ConvertReport { written, skipped, reason })
}

pub fn trim_image(
    raw: &str,
    format: &str,
    quality: u8,
    background: &str,
    view_x: f64,
    view_y: f64,
    view_width: f64,
    view_height: f64,
    out_width: u32,
    out_height: u32,
    quarters: i32,
    flip_h: bool,
    flip_v: bool,
    tone: &str,
    spots: &[BlurSpot],
    strength: f32,
) -> Result<String, String> {
    let format = normalize_format(format)?;
    if zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() {
        return Err("Copy the picture out of the archive before saving a change.".into());
    }
    let source = PathBuf::from(raw.trim());
    let image = orient(load_path(&source)?, quarters, flip_h, flip_v);
    let image = restyle(image, tone, spots, strength);
    let painted = paint(image, view_x, view_y, view_width, view_height, out_width, out_height, background, format)?;
    let encoded = encode(&painted, format, quality.clamp(1, 100), background)?;
    let dest = place(&source, format, &HashSet::new())?;
    if dest.exists() {
        return Err(format!("{} is already there.", file_name(&dest)));
    }
    write_new(&dest, &encoded)?;
    Ok(dest.to_string_lossy().to_string())
}

fn paint(
    image: DynamicImage,
    view_x: f64,
    view_y: f64,
    view_w: f64,
    view_h: f64,
    out_w: u32,
    out_h: u32,
    background: &str,
    format: &str,
) -> Result<DynamicImage, String> {
    if out_w == 0 || out_h == 0 || view_w <= 0.0 || view_h <= 0.0 {
        return Err("Choose a trim size.".into());
    }
    if out_w > 16_000 || out_h > 16_000 {
        return Err("That trim is too large.".into());
    }
    let img_w = image.width() as f64;
    let img_h = image.height() as f64;
    let near = |left: f64, right: f64| (left - right).abs() < 1e-3;
    if view_x >= -1e-3
        && view_y >= -1e-3
        && view_x + view_w <= img_w + 1e-3
        && view_y + view_h <= img_h + 1e-3
        && near(view_w, out_w as f64)
        && near(view_h, out_h as f64)
        && near(view_x, view_x.round())
        && near(view_y, view_y.round())
    {
        let x = view_x.round().max(0.0) as u32;
        let y = view_y.round().max(0.0) as u32;
        let width = out_w.min(image.width().saturating_sub(x));
        let height = out_h.min(image.height().saturating_sub(y));
        if width == 0 || height == 0 {
            return Err("That trim leaves the picture.".into());
        }
        return Ok(image.crop_imm(x, y, width, height));
    }
    let left = view_x.max(0.0);
    let top = view_y.max(0.0);
    let right = (view_x + view_w).min(img_w);
    let bottom = (view_y + view_h).min(img_h);
    if right - left < 0.5 || bottom - top < 0.5 {
        return Err("That trim leaves the picture.".into());
    }
    let crop_x = left.floor() as u32;
    let crop_y = top.floor() as u32;
    let crop_w = (right.ceil() as u32).saturating_sub(crop_x).min(image.width() - crop_x);
    let crop_h = (bottom.ceil() as u32).saturating_sub(crop_y).min(image.height() - crop_y);
    if crop_w == 0 || crop_h == 0 {
        return Err("That trim leaves the picture.".into());
    }
    let cropped = image.crop_imm(crop_x, crop_y, crop_w, crop_h);
    let dest_x = ((left - view_x) / view_w * out_w as f64).round() as i64;
    let dest_y = ((top - view_y) / view_h * out_h as f64).round() as i64;
    let dest_w = (((right - left) / view_w) * out_w as f64).round().max(1.0) as u32;
    let dest_h = (((bottom - top) / view_h) * out_h as f64).round().max(1.0) as u32;
    let resized = cropped.resize_exact(dest_w, dest_h, FilterType::Lanczos3);
    let fill = if matches!(format, "jpg" | "bmp") {
        if background.eq_ignore_ascii_case("black") { Rgba([0, 0, 0, 255]) } else { Rgba([255, 255, 255, 255]) }
    } else {
        Rgba([0, 0, 0, 0])
    };
    let mut canvas = RgbaImage::from_pixel(out_w, out_h, fill);
    overlay(&mut canvas, &resized.to_rgba8(), dest_x, dest_y);
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn convert_one(raw: &str, format: &str, quality: u8, background: &str, replace: bool, claimed: &mut HashSet<String>) -> Result<(), String> {
    let source = PathBuf::from(raw.trim());
    let meta = fs::metadata(&source).map_err(|_| "Can't read that file.".to_string())?;
    if meta.is_dir() {
        return Err("Skipped a folder.".into());
    }
    let extension = extension_of(&source);
    if !is_still(&extension) {
        return Err("Skipped a file that is not a picture.".into());
    }
    if same_format(&extension, format) {
        return Err("Already that format.".into());
    }
    let dest = place(&source, format, claimed)?;
    if dest.exists() && !replace {
        return Err("A file with that name is already there.".into());
    }
    let image = load_path(&source)?;
    let encoded = encode(&image, format, quality, background)?;
    write_new(&dest, &encoded)?;
    claimed.insert(key(&dest));
    Ok(())
}

fn place(source: &Path, format: &str, claimed: &HashSet<String>) -> Result<PathBuf, String> {
    let parent = source.parent().filter(|path| !path.as_os_str().is_empty()).ok_or_else(|| "Can't save next to that picture.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| "That picture needs a name.".to_string())?;
    let mut candidate = parent.join(format!("{stem}.{format}"));
    if same_file(&candidate, source) {
        candidate = parent.join(format!("{stem}-trim.{format}"));
    }
    let mut n = 2u32;
    while claimed.contains(&key(&candidate)) {
        candidate = parent.join(format!("{stem} ({n}).{format}"));
        if same_file(&candidate, source) {
            candidate = parent.join(format!("{stem}-trim ({n}).{format}"));
        }
        n += 1;
        if n > 10000 {
            return Err("Too many files would share this name.".into());
        }
    }
    Ok(candidate)
}

fn write_new(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let ext = dest.extension().and_then(|ext| ext.to_str()).unwrap_or("img");
    let tmp = dest.with_extension(format!("{ext}.filepad-tmp"));
    fs::write(&tmp, bytes).map_err(|err| format!("Can't save that picture: {err}"))?;
    let swapped = fs::rename(&tmp, dest);
    if swapped.is_err() && dest.exists() {
        if let Err(err) = fs::remove_file(dest) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Can't save that picture: {err}"));
        }
        if let Err(err) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Can't save that picture: {err}"));
        }
    } else if let Err(err) = swapped {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Can't save that picture: {err}"));
    }
    Ok(())
}

fn encode(image: &DynamicImage, format: &str, quality: u8, background: &str) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    let fail = |err: image::ImageError| format!("Can't save that picture: {err}");
    match format {
        "jpg" => {
            let rgb = flatten(image, background).to_rgb8();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality)
                .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                .map_err(fail)?;
        }
        "png" => image.write_to(&mut cursor, ImageFormat::Png).map_err(fail)?,
        "webp" => {
            let rgba = image.to_rgba8();
            image::codecs::webp::WebPEncoder::new_lossless(&mut cursor)
                .write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                .map_err(fail)?;
        }
        "bmp" => {
            let rgb = DynamicImage::ImageRgb8(flatten(image, background).to_rgb8());
            rgb.write_to(&mut cursor, ImageFormat::Bmp).map_err(fail)?;
        }
        "gif" => image.write_to(&mut cursor, ImageFormat::Gif).map_err(fail)?,
        "avif" => return encode_avif(image, quality),
        _ => return Err("Choose JPG, PNG, WebP, BMP, GIF, or AVIF.".into()),
    }
    Ok(cursor.into_inner())
}

fn encode_avif(image: &DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgba = image.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    let pixels = rgba.into_raw();
    let quality = quality.clamp(1, 99);
    let (send, recv) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("filepad-avif".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let encoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut cursor = Cursor::new(Vec::new());
                image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut cursor, 10, quality)
                    .write_image(&pixels, width, height, image::ExtendedColorType::Rgba8)
                    .map_err(|err| err.to_string())?;
                Ok::<Vec<u8>, String>(cursor.into_inner())
            }));
            let message = match encoded {
                Ok(Ok(bytes)) => Ok(bytes),
                Ok(Err(err)) => Err(format!("Can't save that picture: {err}")),
                Err(_) => Err("Can't save that picture as AVIF.".into()),
            };
            let _ = send.send(message);
        })
        .map_err(|err| format!("Can't save that picture: {err}"))?;
    recv.recv().unwrap_or_else(|_| Err("Can't save that picture as AVIF.".into()))
}

fn flatten(image: &DynamicImage, background: &str) -> DynamicImage {
    if !image.color().has_alpha() {
        return image.clone();
    }
    let white = !background.eq_ignore_ascii_case("black");
    let pixel = if white { image::Rgba([255, 255, 255, 255]) } else { image::Rgba([0, 0, 0, 255]) };
    let mut canvas = image::RgbaImage::from_pixel(image.width(), image.height(), pixel);
    image::imageops::overlay(&mut canvas, &image.to_rgba8(), 0, 0);
    DynamicImage::ImageRgba8(canvas)
}

pub fn restyle(image: DynamicImage, tone: &str, spots: &[BlurSpot], strength: f32) -> DynamicImage {
    let image = apply_tone(image, tone);
    if spots.is_empty() {
        image
    } else {
        blur_spots(image, spots, strength)
    }
}

fn apply_tone(image: DynamicImage, tone: &str) -> DynamicImage {
    match tone {
        "bw" => image.grayscale(),
        "sepia" => sepia(image),
        _ => image,
    }
}

fn sepia(image: DynamicImage) -> DynamicImage {
    let mut rgba = image.to_rgba8();
    for pixel in rgba.pixels_mut() {
        let red = pixel[0] as f32;
        let green = pixel[1] as f32;
        let blue = pixel[2] as f32;
        pixel[0] = (0.393 * red + 0.769 * green + 0.189 * blue).min(255.0) as u8;
        pixel[1] = (0.349 * red + 0.686 * green + 0.168 * blue).min(255.0) as u8;
        pixel[2] = (0.272 * red + 0.534 * green + 0.131 * blue).min(255.0) as u8;
    }
    DynamicImage::ImageRgba8(rgba)
}

fn blur_spots(image: DynamicImage, spots: &[BlurSpot], strength: f32) -> DynamicImage {
    let mut base = image.to_rgba8();
    let sigma = blur_sigma(strength);
    for spot in spots {
        blur_one(&mut base, spot, sigma);
    }
    DynamicImage::ImageRgba8(base)
}

fn mix_pixel(original: Rgba<u8>, sample: Rgba<u8>, cover: f32) -> Rgba<u8> {
    let cover = cover.clamp(0.0, 1.0);
    let mix = |from: u8, to: u8| (from as f32 + (to as f32 - from as f32) * cover).round() as u8;
    Rgba([mix(original[0], sample[0]), mix(original[1], sample[1]), mix(original[2], sample[2]), mix(original[3], sample[3])])
}

fn blur_one(base: &mut RgbaImage, spot: &BlurSpot, sigma: f32) {
    let width = base.width() as f64;
    let height = base.height() as f64;
    if !spot.x.is_finite() || !spot.y.is_finite() || !spot.w.is_finite() || !spot.h.is_finite() || spot.w < 2.0 || spot.h < 2.0 {
        return;
    }
    let left_f = spot.x.max(0.0);
    let top_f = spot.y.max(0.0);
    let right_f = (spot.x + spot.w).min(width);
    let bottom_f = (spot.y + spot.h).min(height);
    if right_f - left_f < 2.0 || bottom_f - top_f < 2.0 {
        return;
    }
    let left = left_f.floor() as u32;
    let top = top_f.floor() as u32;
    let right = right_f.ceil().min(base.width() as f64) as u32;
    let bottom = bottom_f.ceil().min(base.height() as f64) as u32;
    let oval = spot.shape.eq_ignore_ascii_case("oval");
    let censor = spot.mode.eq_ignore_ascii_case("black") || spot.mode.eq_ignore_ascii_case("censor");
    if censor {
        let radius_x = (right_f - left_f) / 2.0;
        let radius_y = (bottom_f - top_f) / 2.0;
        let center_x = left_f + radius_x;
        let center_y = top_f + radius_y;
        let ink = Rgba([0, 0, 0, 255]);
        for py in top..bottom.min(base.height()) {
            for px in left..right.min(base.width()) {
                if oval {
                    if radius_x < 0.5 || radius_y < 0.5 {
                        continue;
                    }
                    let dx = (px as f64 + 0.5 - center_x) / radius_x;
                    let dy = (py as f64 + 0.5 - center_y) / radius_y;
                    if dx * dx + dy * dy > 1.0 {
                        continue;
                    }
                }
                base.put_pixel(px, py, ink);
            }
        }
        return;
    }
    let feather = (sigma * 0.5).clamp(2.0, 32.0);
    let pad = (sigma * 3.0 + feather).ceil() as u32;
    let crop_x = left.saturating_sub(pad);
    let crop_y = top.saturating_sub(pad);
    let crop_right = right.saturating_add(pad).min(base.width());
    let crop_bottom = bottom.saturating_add(pad).min(base.height());
    let crop_w = crop_right.saturating_sub(crop_x);
    let crop_h = crop_bottom.saturating_sub(crop_y);
    if crop_w == 0 || crop_h == 0 {
        return;
    }
    let cropped = crop_imm(base, crop_x, crop_y, crop_w, crop_h).to_image();
    let blurred = blur(&cropped, sigma);
    let radius_x = (right_f - left_f) / 2.0;
    let radius_y = (bottom_f - top_f) / 2.0;
    let center_x = left_f + radius_x;
    let center_y = top_f + radius_y;
    let spread = feather.ceil() as i32;
    let left_px = (left as i32 - spread).max(0) as u32;
    let top_px = (top as i32 - spread).max(0) as u32;
    let right_px = ((right as i32 + spread).max(0) as u32).min(base.width());
    let bottom_px = ((bottom as i32 + spread).max(0) as u32).min(base.height());
    for py in top_px..bottom_px {
        for px in left_px..right_px {
            let cover = if oval {
                if radius_x < 0.5 || radius_y < 0.5 {
                    continue;
                }
                let dx = (px as f64 + 0.5 - center_x) / radius_x;
                let dy = (py as f64 + 0.5 - center_y) / radius_y;
                let inside = (1.0 - (dx * dx + dy * dy).sqrt()) * radius_x.min(radius_y);
                ((inside + feather as f64) / (feather as f64 * 2.0)).clamp(0.0, 1.0) as f32
            } else {
                let edge_x = (px as i32 - left as i32).min(right as i32 - 1 - px as i32) as f32;
                let edge_y = (py as i32 - top as i32).min(bottom as i32 - 1 - py as i32) as f32;
                ((edge_x.min(edge_y) + feather) / (feather * 2.0)).clamp(0.0, 1.0)
            };
            if cover <= 0.0 {
                continue;
            }
            let sx = px.saturating_sub(crop_x);
            let sy = py.saturating_sub(crop_y);
            if sx >= blurred.width() || sy >= blurred.height() {
                continue;
            }
            let sample = *blurred.get_pixel(sx, sy);
            let original = *base.get_pixel(px, py);
            base.put_pixel(px, py, mix_pixel(original, sample, cover));
        }
    }
}

fn orient(mut image: DynamicImage, quarters: i32, flip_h: bool, flip_v: bool) -> DynamicImage {
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
    image
}

pub fn load_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    decode_image(bytes)
}

pub fn load_path(path: &Path) -> Result<DynamicImage, String> {
    let bytes = fs::read(path).map_err(|err| format!("Can't read that picture: {err}"))?;
    match decode_image(&bytes) {
        Ok(image) => Ok(image),
        Err(err) => {
            #[cfg(windows)]
            if extension_of(path) == "avif" {
                if let Ok(image) = crate::preview::wic_image(path) {
                    return Ok(image);
                }
            }
            Err(err)
        }
    }
}

fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|err| err.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(32_000);
    limits.max_image_height = Some(32_000);
    limits.max_alloc = Some(1024 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| "Can't read that picture.".to_string())?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| "Can't read that picture.".to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

pub fn save_edit(source: &Path, image: &DynamicImage) -> Result<String, String> {
    let ext = extension_of(source);
    let format = normalize_format(&ext)?;
    let quality = if format == "jpg" || format == "avif" { 90 } else { 100 };
    let encoded = encode(image, format, quality, "white")?;
    let dest = edited_path(source)?;
    write_new(&dest, &encoded)?;
    Ok(dest.to_string_lossy().to_string())
}

fn edited_path(source: &Path) -> Result<PathBuf, String> {
    let parent = source.parent().filter(|path| !path.as_os_str().is_empty()).ok_or_else(|| "Can't save next to that picture.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| "That picture needs a name.".to_string())?;
    let ext = extension_of(source);
    let mut candidate = parent.join(format!("{stem}-edit.{ext}"));
    let mut n = 2u32;
    while candidate.exists() {
        candidate = parent.join(format!("{stem}-edit ({n}).{ext}"));
        n += 1;
        if n > 10000 {
            return Err("Too many files would share this name.".into());
        }
    }
    Ok(candidate)
}

fn normalize_format(format: &str) -> Result<&'static str, String> {
    match format.trim().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        "webp" => Ok("webp"),
        "bmp" => Ok("bmp"),
        "gif" => Ok("gif"),
        "avif" => Ok("avif"),
        _ => Err("Choose JPG, PNG, WebP, BMP, GIF, or AVIF.".into()),
    }
}

fn is_still(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif")
}

fn same_format(extension: &str, format: &str) -> bool {
    if format == "jpg" {
        extension == "jpg" || extension == "jpeg"
    } else {
        extension == format
    }
}

fn extension_of(path: &Path) -> String {
    path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "That file".into())
}

fn same_file(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    #[cfg(windows)]
    {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn key(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        text.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::{convert_images, restyle, trim_image, BlurSpot};
    use image::{DynamicImage, Rgba, RgbaImage};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn encodes_jpeg_and_png_and_keeps_the_crop_size() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = TempDir(std::env::temp_dir().join(format!("filepad-convert-{}-{nanos}", std::process::id())));
        fs::create_dir_all(&dir.0).unwrap();
        let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(8, 6, |x, y| Rgba([x as u8 * 20, y as u8 * 30, 40, if x == 0 { 0 } else { 255 }])));
        let src = dir.0.join("dot.png");
        image.save(&src).unwrap();

        let png = image::open(&src).unwrap();
        assert_eq!((png.width(), png.height()), (8, 6));

        let report = convert_images(&[src.to_string_lossy().to_string()], "jpg", 85, "white", false).unwrap();
        assert_eq!(report.written, 1);
        assert_eq!(report.skipped, 0);
        let jpeg = image::open(dir.0.join("dot.jpg")).unwrap();
        assert_eq!((jpeg.width(), jpeg.height()), (8, 6));
        assert_eq!(image::open(&src).unwrap().width(), 8);

        let again = convert_images(&[src.to_string_lossy().to_string()], "png", 85, "white", false).unwrap();
        assert_eq!(again.written, 0);
        assert_eq!(again.reason.as_deref(), Some("Already that format."));

        let out = trim_image(&src.to_string_lossy(), "png", 85, "white", 2.0, 1.0, 3.0, 2.0, 3, 2, 0, false, false, "", &[], 0.0).unwrap();
        let cropped = image::open(&out).unwrap();
        assert_eq!((cropped.width(), cropped.height()), (3, 2));
        assert!(out.ends_with("dot-trim.png"));
        assert_eq!(image::open(&src).unwrap().height(), 6);

        let wide = dir.0.join("wide.png");
        image.save(&wide).unwrap();
        let scaled = trim_image(&wide.to_string_lossy(), "jpg", 85, "white", 0.0, 0.0, 8.0, 6.0, 4, 3, 0, false, false, "", &[], 0.0).unwrap();
        let fitted = image::open(&scaled).unwrap();
        assert_eq!((fitted.width(), fitted.height()), (4, 3));

        let jpg = dir.0.join("dot.jpg");
        for format in ["webp", "bmp", "gif"] {
            let report = convert_images(&[jpg.to_string_lossy().to_string()], format, 85, "white", false).unwrap();
            assert_eq!(report.written, 1, "{format}");
            let saved = image::open(dir.0.join(format!("dot.{format}"))).unwrap();
            assert_eq!((saved.width(), saved.height()), (8, 6), "{format}");
        }
    }

    #[test]
    fn sepia_warms_red_and_blur_hides_only_the_marked_spot() {
        let red = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([255, 0, 0])));
        let warm = restyle(red, "sepia", &[], 14.0).to_rgb8();
        let pixel = warm.get_pixel(0, 0);
        assert!(pixel[0] > pixel[1] && pixel[1] > pixel[2] && pixel[0] < 200);

        let split = DynamicImage::ImageRgb8(image::RgbImage::from_fn(80, 40, |x, _| {
            if x < 40 { image::Rgb([0, 0, 0]) } else { image::Rgb([255, 255, 255]) }
        }));
        let square = [BlurSpot { shape: "square".into(), x: 28.0, y: 12.0, w: 24.0, h: 16.0, mode: "blur".into() }];
        let blurred = restyle(split.clone(), "color", &square, 14.0).to_rgb8();
        assert_eq!(blurred.get_pixel(0, 0).0, [0, 0, 0]);
        let mixed = blurred.get_pixel(40, 20)[0];
        assert!(mixed > 30 && mixed < 225);

        let oval = [BlurSpot { shape: "oval".into(), x: 28.0, y: 12.0, w: 24.0, h: 16.0, mode: "blur".into() }];
        let page = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(12, 8, image::Rgb([255, 255, 255])));
        let blocked = [BlurSpot { shape: "square".into(), x: 2.0, y: 1.0, w: 4.0, h: 3.0, mode: "black".into() }];
        let hidden = restyle(page, "color", &blocked, 14.0).to_rgb8();
        assert_eq!(hidden.get_pixel(3, 2).0, [0, 0, 0]);
        assert_eq!(hidden.get_pixel(0, 0).0, [255, 255, 255]);
        let ovalled = restyle(split, "bw", &oval, 14.0).to_rgb8();
        assert_eq!(ovalled.get_pixel(0, 0).0, [0, 0, 0]);
        assert!(ovalled.get_pixel(40, 20)[0] > 30);
    }

    #[test]
    fn avif_encode_writes_an_avif_file() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(16, 16, image::Rgb([220, 20, 40])));
        let bytes = super::encode(&image, "avif", 60, "white").unwrap();
        assert!(bytes.windows(4).any(|mark| mark == b"ftyp"));
        assert!(bytes.windows(4).any(|mark| mark == b"avif"));
    }
}
