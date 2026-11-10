use base64::Engine;
use deckcraft_model::Presentation;
use deckcraft_render::{render_slide, RenderOpts};
use serde::Serialize;
use std::sync::Mutex;

const LONG_EDGE: f64 = 1280.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RasterPage {
    width: f64,
    height: f64,
    count: usize,
    index: usize,
    image: String,
}

struct Slot {
    key: String,
    pres: Presentation,
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);

pub fn raster_page(key: &str, bytes: &[u8], index: usize) -> Result<String, String> {
    let key = if key.is_empty() { fingerprint(bytes) } else { key.to_string() };
    let mut guard = SLOT.lock().unwrap_or_else(|poison| poison.into_inner());
    let stale = guard.as_ref().is_none_or(|slot| slot.key != key);
    if stale {
        let pres = deckcraft_pptx::import(bytes).map_err(|err| err.to_string())?;
        if pres.slides.is_empty() {
            return Err("That presentation has no slides.".into());
        }
        *guard = Some(Slot { key, pres });
    }
    let pres = &guard.as_ref().ok_or("Can't read that presentation.")?.pres;
    let count = pres.slides.len();
    let index = index.min(count - 1);
    let width = points(pres.slide_size.width);
    let height = points(pres.slide_size.height);
    let long = width.max(height).max(1.0);
    let scale = (LONG_EDGE / long).min(1.0);
    let opts = RenderOpts { scale, ..RenderOpts::default() };
    let image = render_slide(pres, index, &opts);
    if image.width == 0 || image.height == 0 {
        return Err("Can't read that presentation.".into());
    }
    let jpeg = image.to_jpeg(80);
    if jpeg.is_empty() {
        return Err("Can't read that presentation.".into());
    }
    let page = RasterPage {
        width,
        height,
        count,
        index,
        image: format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)),
    };
    serde_json::to_string(&page).map_err(|_| "Can't read that presentation.".to_string())
}

fn points(value: f64) -> f64 {
    if value > 10_000.0 { value / 12_700.0 } else { value }
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hash = bytes.len() as u64;
    for byte in bytes.iter().take(4096) {
        hash = hash.wrapping_mul(16777619).wrapping_add(*byte as u64);
    }
    if bytes.len() > 4096 {
        for byte in bytes[bytes.len() - 4096..].iter() {
            hash = hash.wrapping_mul(16777619).wrapping_add(*byte as u64);
        }
    }
    format!("bytes:{hash}")
}
