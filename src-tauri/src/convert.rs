use crate::{gzipnav, zipnav};
use image::imageops::{overlay, FilterType};
use image::{DynamicImage, ImageEncoder, ImageFormat, ImageReader, Limits, Rgba, RgbaImage};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

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
) -> Result<String, String> {
    let format = normalize_format(format)?;
    if zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() {
        return Err("Copy the picture out of the archive before saving a change.".into());
    }
    let source = PathBuf::from(raw.trim());
    let bytes = fs::read(&source).map_err(|err| format!("Can't read that picture: {err}"))?;
    let image = orient(decode_image(&bytes)?, quarters, flip_h, flip_v);
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
    let bytes = fs::read(&source).map_err(|err| format!("Can't read that picture: {err}"))?;
    let image = decode_image(&bytes)?;
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
        _ => return Err("Choose JPG, PNG, WebP, BMP, or GIF.".into()),
    }
    Ok(cursor.into_inner())
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

fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|err| err.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(32_000);
    limits.max_image_height = Some(32_000);
    limits.max_alloc = Some(1024 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| "Can't read that picture.".to_string())
}

fn normalize_format(format: &str) -> Result<&'static str, String> {
    match format.trim().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        "webp" => Ok("webp"),
        "bmp" => Ok("bmp"),
        "gif" => Ok("gif"),
        _ => Err("Choose JPG, PNG, WebP, BMP, or GIF.".into()),
    }
}

fn is_still(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
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
    use super::{convert_images, trim_image};
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

        let out = trim_image(&src.to_string_lossy(), "png", 85, "white", 2.0, 1.0, 3.0, 2.0, 3, 2, 0, false, false).unwrap();
        let cropped = image::open(&out).unwrap();
        assert_eq!((cropped.width(), cropped.height()), (3, 2));
        assert!(out.ends_with("dot-trim.png"));
        assert_eq!(image::open(&src).unwrap().height(), 6);

        let wide = dir.0.join("wide.png");
        image.save(&wide).unwrap();
        let scaled = trim_image(&wide.to_string_lossy(), "jpg", 85, "white", 0.0, 0.0, 8.0, 6.0, 4, 3, 0, false, false).unwrap();
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
}
