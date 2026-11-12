use crate::{gzipnav, zipnav};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MISSING_TOOLS: &str = "Video tools are missing from this build.";

static JOB: Mutex<Option<std::process::Child>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static TOOLS: Mutex<Option<Tools>> = Mutex::new(None);

struct Tools {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoProgress {
    path: String,
    ratio: f64,
    done: bool,
}

pub struct VideoEdit {
    pub path: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub preset: String,
    pub crop_x: f64,
    pub crop_y: f64,
    pub quarters: i32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub mute: bool,
    pub sound_path: Option<String>,
    pub sound_start_ms: u64,
    pub sound_end_ms: u64,
    pub sound_volume: f64,
    pub extra_start_ms: u64,
    pub extra_end_ms: u64,
    pub extra_place_ms: u64,
    pub extra_volume: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preset {
    Original,
    Youtube,
    Tiktok,
    Instagram,
    FourThree,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AudioChoice {
    Keep,
    Mute,
    Replace,
}

struct EditSpec {
    preset: Preset,
    crop_x: f64,
    crop_y: f64,
    quarters: i32,
    flip_h: bool,
    flip_v: bool,
    start_ms: u64,
    end_ms: u64,
    sound_start_ms: u64,
    sound_end_ms: u64,
    sound_volume: f64,
    keep_sound: bool,
    extra: bool,
    extra_start_ms: u64,
    extra_end_ms: u64,
    extra_place_ms: u64,
    extra_volume: f64,
}

struct Graph {
    filter: String,
    maps_audio: bool,
    second_input: bool,
    shortest: bool,
    out_width: u32,
    out_height: u32,
}

struct ClearJob;

impl Drop for ClearJob {
    fn drop(&mut self) {
        clear_job();
    }
}

pub fn probe_video(app: &AppHandle, raw: &str) -> Result<VideoInfo, String> {
    let path = video_file(raw)?;
    ensure_tools(app)?;
    probe_file(&path)
}

pub fn edit_video(app: &AppHandle, edit: VideoEdit) -> Result<String, String> {
    if job_lock().is_some() {
        return Err("A video is already saving.".into());
    }
    let label = edit.path.clone();
    let source = video_file(&edit.path)?;
    ensure_tools(app)?;
    CANCELLED.store(false, Ordering::SeqCst);
    let info = probe_file(&source)?;
    let sound = sound_file(edit.sound_path.as_deref())?;
    let spec = spec_from(&edit, &info, sound.is_some())?;
    let graph = build_graph(info.width, info.height, &spec)?;
    let dest = place_edit(&source)?;
    let mut command = tool("ffmpeg");
    command.arg("-hide_banner").arg("-loglevel").arg("error").arg("-y");
    command.arg("-i").arg(&source);
    if graph.second_input {
        let Some(sound) = sound else {
            return Err("Choose a sound file.".into());
        };
        command.arg("-i").arg(sound);
    }
    command.arg("-filter_complex").arg(&graph.filter);
    command.arg("-map").arg("[v]");
    if graph.maps_audio {
        command.arg("-map").arg("[a]");
        command.arg("-c:a").arg("aac").arg("-b:a").arg("160k");
    } else {
        command.arg("-an");
    }
    if graph.shortest {
        command.arg("-shortest");
    }
    command.args([
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
    ]);
    command.arg(&dest);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| MISSING_TOOLS.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut slot = job_lock();
        if slot.is_some() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("A video is already saving.".into());
        }
        *slot = Some(child);
    }
    let _guard = ClearJob;
    if CANCELLED.load(Ordering::SeqCst) {
        clear_job();
        discard(&dest);
        return Err("Save cancelled.".into());
    }
    let errors = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let span = spec.end_ms.saturating_sub(spec.start_ms).max(1);
    if let Some(pipe) = stdout {
        read_progress(app, &label, span, pipe);
    }
    let status = take_status();
    let err_bytes = errors.join().unwrap_or_default();
    if CANCELLED.load(Ordering::SeqCst) {
        discard(&dest);
        return Err("Save cancelled.".into());
    }
    match status {
        Some(status) if status.success() && dest.is_file() => {
            emit(app, &label, 1.0, true);
            Ok(dest.to_string_lossy().to_string())
        }
        _ => {
            discard(&dest);
            Err(fail_message(&err_bytes))
        }
    }
}

pub fn cancel_video() {
    CANCELLED.store(true, Ordering::SeqCst);
    if let Some(child) = job_lock().as_mut() {
        let _ = child.kill();
    }
}

fn spec_from(edit: &VideoEdit, info: &VideoInfo, has_extra: bool) -> Result<EditSpec, String> {
    let preset = preset_of(&edit.preset)?;
    let end_ms = edit.end_ms.min(info.duration_ms);
    let start_ms = edit.start_ms.min(end_ms);
    if end_ms.saturating_sub(start_ms) < 100 {
        return Err("The trim is too short.".into());
    }
    let sound_volume = unit_volume(edit.sound_volume);
    let extra_volume = unit_volume(edit.extra_volume);
    let sound_end_ms = edit.sound_end_ms.min(info.duration_ms);
    let sound_start_ms = edit.sound_start_ms.min(sound_end_ms);
    let extra_end_ms = edit.extra_end_ms;
    let extra_start_ms = edit.extra_start_ms.min(extra_end_ms);
    let extra_place_ms = edit.extra_place_ms.min(info.duration_ms);
    Ok(EditSpec {
        preset,
        crop_x: edit.crop_x,
        crop_y: edit.crop_y,
        quarters: edit.quarters,
        flip_h: edit.flip_h,
        flip_v: edit.flip_v,
        start_ms,
        end_ms,
        sound_start_ms,
        sound_end_ms,
        sound_volume,
        keep_sound: !edit.mute && info.has_audio && sound_volume > 0.004,
        extra: has_extra && extra_volume > 0.004,
        extra_start_ms,
        extra_end_ms,
        extra_place_ms,
        extra_volume,
    })
}

fn unit_volume(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { 1.0 }
}

fn build_graph(width: u32, height: u32, spec: &EditSpec) -> Result<Graph, String> {
    if width < 2 || height < 2 {
        return Err("Can't read that video's size.".into());
    }
    if spec.end_ms <= spec.start_ms {
        return Err("The trim is too short.".into());
    }
    let turned = spec.quarters.rem_euclid(4) % 2 == 1;
    let (frame_w, frame_h) = if turned { (height, width) } else { (width, height) };
    let (crop, out_w, out_h) = frame_of(frame_w, frame_h, spec)?;
    let scale = match cap_of(spec.preset) {
        Some((cap_w, cap_h)) => {
            let (w, h) = scale_down(out_w, out_h, cap_w, cap_h);
            if w == out_w && h == out_h { None } else { Some((w, h)) }
        }
        None => None,
    };
    let (out_width, out_height) = scale.unwrap_or((out_w, out_h));
    let video = video_filters(spec, crop, scale);
    let audio = audio_filter(spec);
    let filter = match &audio {
        Some(chain) => format!("[0:v]{video}[v];{chain}"),
        None => format!("[0:v]{video}[v]"),
    };
    Ok(Graph {
        filter,
        maps_audio: audio.is_some(),
        second_input: added_slice(spec).is_some(),
        shortest: false,
        out_width,
        out_height,
    })
}

fn frame_of(frame_w: u32, frame_h: u32, spec: &EditSpec) -> Result<(Option<(u32, u32, u32, u32)>, u32, u32), String> {
    let Some((aspect_w, aspect_h)) = aspect_of(spec.preset) else {
        let w = even_floor(frame_w);
        let h = even_floor(frame_h);
        if w < 2 || h < 2 {
            return Err("That frame is too small.".into());
        }
        let crop = if w == frame_w && h == frame_h { None } else { Some((w, h, 0, 0)) };
        return Ok((crop, w, h));
    };
    let (w, h) = fit_aspect(frame_w, frame_h, aspect_w, aspect_h)?;
    let x = along(frame_w.saturating_sub(w), spec.crop_x);
    let y = along(frame_h.saturating_sub(h), spec.crop_y);
    Ok((Some((w, h, x, y)), w, h))
}

fn video_filters(spec: &EditSpec, crop: Option<(u32, u32, u32, u32)>, scale: Option<(u32, u32)>) -> String {
    let mut parts = vec![
        format!("trim=start={}:end={}", ms_secs(spec.start_ms), ms_secs(spec.end_ms)),
        "setpts=PTS-STARTPTS".to_string(),
    ];
    match spec.quarters.rem_euclid(4) {
        1 => parts.push("transpose=1".to_string()),
        2 => {
            parts.push("transpose=1".to_string());
            parts.push("transpose=1".to_string());
        }
        3 => parts.push("transpose=2".to_string()),
        _ => {}
    }
    if spec.flip_h {
        parts.push("hflip".to_string());
    }
    if spec.flip_v {
        parts.push("vflip".to_string());
    }
    if let Some((w, h, x, y)) = crop {
        parts.push(format!("crop={w}:{h}:{x}:{y}"));
    }
    if let Some((w, h)) = scale {
        parts.push(format!("scale={w}:{h}"));
    }
    parts.join(",")
}

fn clip_window(start: u64, end: u64, from: u64, to: u64) -> Option<(u64, u64, u64)> {
    let heard_from = from.max(start);
    let heard_to = to.min(end);
    if heard_to.saturating_sub(heard_from) < 50 {
        return None;
    }
    Some((heard_from, heard_to, heard_from.saturating_sub(start)))
}

fn push_volume(chain: &mut String, volume: f64) {
    if (volume - 1.0).abs() > 0.005 {
        chain.push_str(&format!(",volume={volume:.3}"));
    }
}

fn audio_chain(input: &str, from: u64, to: u64, delay: u64, volume: f64, label: &str, stereo: bool) -> String {
    let mut chain = format!("[{input}]atrim=start={}:end={},asetpts=PTS-STARTPTS", ms_secs(from), ms_secs(to));
    if delay > 0 {
        chain.push_str(&format!(",adelay={delay}:all=1"));
    }
    push_volume(&mut chain, volume);
    if stereo {
        chain.push_str(",aformat=channel_layouts=stereo");
    }
    chain.push_str(label);
    chain
}

fn added_slice(spec: &EditSpec) -> Option<(u64, u64, u64)> {
    if !spec.extra {
        return None;
    }
    let len = spec.extra_end_ms.saturating_sub(spec.extra_start_ms);
    if len < 50 {
        return None;
    }
    let clip_from = spec.extra_place_ms;
    let clip_to = clip_from.saturating_add(len);
    let heard_from = clip_from.max(spec.start_ms);
    let heard_to = clip_to.min(spec.end_ms);
    if heard_to.saturating_sub(heard_from) < 50 {
        return None;
    }
    let file_from = spec.extra_start_ms + heard_from.saturating_sub(clip_from);
    let file_to = file_from + (heard_to - heard_from);
    Some((file_from, file_to, heard_from.saturating_sub(spec.start_ms)))
}

fn audio_filter(spec: &EditSpec) -> Option<String> {
    let original = if spec.keep_sound {
        clip_window(spec.start_ms, spec.end_ms, spec.sound_start_ms, spec.sound_end_ms)
    } else {
        None
    };
    let added = added_slice(spec);
    match (original, added) {
        (Some((from, to, delay)), None) => Some(audio_chain("0:a", from, to, delay, spec.sound_volume, "[a]", false)),
        (None, Some((from, to, delay))) => Some(audio_chain("1:a", from, to, delay, spec.extra_volume, "[a]", false)),
        (Some((from, to, delay)), Some((extra_from, extra_to, extra_delay))) => Some(format!(
            "{};{};[orig][extra]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]",
            audio_chain("0:a", from, to, delay, spec.sound_volume, "[orig]", true),
            audio_chain("1:a", extra_from, extra_to, extra_delay, spec.extra_volume, "[extra]", true),
        )),
        (None, None) => None,
    }
}

fn fit_aspect(frame_w: u32, frame_h: u32, aspect_w: u32, aspect_h: u32) -> Result<(u32, u32), String> {
    if frame_w < 2 || frame_h < 2 || aspect_w == 0 || aspect_h == 0 {
        return Err("That frame is too small.".into());
    }
    let by_width_h = (frame_w as u64 * aspect_h as u64) / aspect_w as u64;
    let (w, h) = if by_width_h <= frame_h as u64 {
        let w = even_floor(frame_w);
        let h = even_floor(((w as u64 * aspect_h as u64) / aspect_w as u64) as u32).min(even_floor(frame_h));
        (w, h)
    } else {
        let h = even_floor(frame_h);
        let w = even_floor(((h as u64 * aspect_w as u64) / aspect_h as u64) as u32).min(even_floor(frame_w));
        (w, h)
    };
    if w < 2 || h < 2 {
        return Err("That frame is too small.".into());
    }
    Ok((w, h))
}

fn scale_down(w: u32, h: u32, cap_w: u32, cap_h: u32) -> (u32, u32) {
    if w <= cap_w && h <= cap_h {
        return (w, h);
    }
    let scale = (cap_w as f64 / w as f64).min(cap_h as f64 / h as f64);
    let out_w = even_floor((w as f64 * scale).floor() as u32).max(2).min(even_floor(cap_w));
    let out_h = even_floor((h as f64 * scale).floor() as u32).max(2).min(even_floor(cap_h));
    (out_w, out_h)
}

fn along(slack: u32, fraction: f64) -> u32 {
    if slack == 0 {
        return 0;
    }
    let fraction = if fraction.is_finite() { fraction.clamp(0.0, 1.0) } else { 0.5 };
    let raw = ((slack as f64) * fraction).round() as u32;
    let raw = raw.min(slack);
    raw - (raw % 2)
}

fn even_floor(n: u32) -> u32 {
    n - (n % 2)
}

fn ms_secs(ms: u64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

fn preset_of(raw: &str) -> Result<Preset, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "original" | "" => Ok(Preset::Original),
        "youtube" | "16:9" => Ok(Preset::Youtube),
        "tiktok" | "9:16" => Ok(Preset::Tiktok),
        "instagram" | "1:1" => Ok(Preset::Instagram),
        "fourthree" | "four_three" | "4:3" => Ok(Preset::FourThree),
        _ => Err("Choose a frame size.".into()),
    }
}

fn aspect_of(preset: Preset) -> Option<(u32, u32)> {
    match preset {
        Preset::Original => None,
        Preset::Youtube => Some((16, 9)),
        Preset::Tiktok => Some((9, 16)),
        Preset::Instagram => Some((1, 1)),
        Preset::FourThree => Some((4, 3)),
    }
}

fn cap_of(preset: Preset) -> Option<(u32, u32)> {
    match preset {
        Preset::Original => None,
        Preset::Youtube => Some((1920, 1080)),
        Preset::Tiktok => Some((1080, 1920)),
        Preset::Instagram => Some((1080, 1080)),
        Preset::FourThree => Some((1440, 1080)),
    }
}

fn place_edit(source: &Path) -> Result<PathBuf, String> {
    let parent = source.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let stem = source.file_stem().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "video".into());
    let mut n = 0u32;
    loop {
        let name = if n == 0 { format!("{stem}-edit.mp4") } else { format!("{stem}-edit-{}.mp4", n + 1) };
        let candidate = parent.join(name);
        if !candidate.exists() && !same_file(&candidate, source) {
            return Ok(candidate);
        }
        n += 1;
        if n > 10000 {
            return Err("Too many files would share this name.".into());
        }
    }
}

fn probe_file(path: &Path) -> Result<VideoInfo, String> {
    let output = tool("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|_| MISSING_TOOLS.to_string())?;
    if !output.status.success() {
        return Err("Can't read that video.".into());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Can't read that video.".to_string())?;
    let streams = value.get("streams").and_then(|item| item.as_array()).ok_or_else(|| "Can't read that video.".to_string())?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(|item| item.as_str()) == Some("video") && !attached_pic(stream))
        .ok_or_else(|| "Can't read that video.".to_string())?;
    let coded_w = video.get("width").and_then(|item| item.as_u64()).unwrap_or(0) as u32;
    let coded_h = video.get("height").and_then(|item| item.as_u64()).unwrap_or(0) as u32;
    if coded_w < 2 || coded_h < 2 {
        return Err("Can't read that video's size.".into());
    }
    let (width, height) = display_size(coded_w, coded_h, stream_rotation(video));
    let duration_ms = duration_of(&value, video).ok_or_else(|| "Can't read that video's length.".to_string())?;
    let has_audio = streams.iter().any(|stream| stream.get("codec_type").and_then(|item| item.as_str()) == Some("audio"));
    Ok(VideoInfo { duration_ms, width, height, has_audio })
}

fn attached_pic(stream: &Value) -> bool {
    stream.get("disposition").and_then(|item| item.get("attached_pic")).and_then(|item| item.as_i64()).unwrap_or(0) == 1
}

fn duration_of(value: &Value, video: &Value) -> Option<u64> {
    value.get("format").and_then(|item| item.get("duration")).and_then(number_ms).or_else(|| video.get("duration").and_then(number_ms))
}

fn number_ms(value: &Value) -> Option<u64> {
    let secs = if let Some(text) = value.as_str() { text.parse::<f64>().ok()? } else { value.as_f64()? };
    if !secs.is_finite() || secs <= 0.0 {
        return None;
    }
    Some((secs * 1000.0).round() as u64)
}

fn stream_rotation(stream: &Value) -> i32 {
    if let Some(tags) = stream.get("tags") {
        if let Some(rotation) = tags.get("rotate").and_then(number_i32) {
            return quarter_turn(rotation);
        }
    }
    if let Some(list) = stream.get("side_data_list").and_then(|item| item.as_array()) {
        for item in list {
            if let Some(rotation) = item.get("rotation").and_then(number_i32) {
                return quarter_turn(rotation);
            }
        }
    }
    0
}

fn number_i32(value: &Value) -> Option<i32> {
    if let Some(text) = value.as_str() {
        return text.trim().parse::<f64>().ok().map(|n| n.round() as i32);
    }
    if let Some(n) = value.as_i64() {
        return Some(n as i32);
    }
    value.as_f64().map(|n| n.round() as i32)
}

fn quarter_turn(rotation: i32) -> i32 {
    match rotation.rem_euclid(360) {
        90 => 90,
        180 => 180,
        270 => 270,
        _ => 0,
    }
}

fn display_size(width: u32, height: u32, rotation: i32) -> (u32, u32) {
    if rotation == 90 || rotation == 270 { (height, width) } else { (width, height) }
}

fn video_file(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() || zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() || raw.starts_with("sftp:") {
        return Err("Copy the video out of the archive before saving a change.".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err("Can't find that video.".into());
    }
    Ok(path)
}

fn sound_file(raw: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    if zipnav::split(raw).is_some() || gzipnav::split(raw).is_some() || raw.starts_with("sftp:") {
        return Err("Choose a sound file on this computer.".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err("Can't find that sound.".into());
    }
    let ext = path.extension().and_then(|item| item.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "mp3" | "m4a" | "aac" | "wav" | "ogg" | "oga" | "flac" | "opus") {
        return Err("Choose a sound file.".into());
    }
    Ok(Some(path))
}

pub fn probe_sound(app: &AppHandle, raw: &str) -> Result<u64, String> {
    let path = sound_file(Some(raw))?.ok_or_else(|| "Choose a sound file.".to_string())?;
    ensure_tools(app)?;
    let output = tool("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_format"])
        .arg(&path)
        .output()
        .map_err(|_| MISSING_TOOLS.to_string())?;
    if !output.status.success() {
        return Err("Can't read that sound.".into());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Can't read that sound.".to_string())?;
    let ms = value.get("format").and_then(|item| item.get("duration")).and_then(number_ms).ok_or_else(|| "Can't read that sound's length.".to_string())?;
    if ms < 100 {
        return Err("That sound is too short.".into());
    }
    Ok(ms)
}

pub fn pick_sound_file(app: &AppHandle) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or_else(|| "Can't find the window.".to_string())?;
    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
    #[cfg(windows)]
    {
        open_sound_dialog(hwnd)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        Err("Choosing a sound file is only available on Windows.".into())
    }
}

#[cfg(windows)]
fn open_sound_dialog(owner: windows::Win32::Foundation::HWND) -> Result<Option<String>, String> {
    use windows::core::w;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
        use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, SIGDN_FILESYSPATH};
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|err| err.to_string())?;
        let options = dialog.GetOptions().map_err(|err| err.to_string())?;
        dialog.SetOptions(options | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM).map_err(|err| err.to_string())?;
        let kinds = [COMDLG_FILTERSPEC { pszName: w!("Sound"), pszSpec: w!("*.mp3;*.m4a;*.aac;*.wav;*.ogg;*.oga;*.flac;*.opus") }];
        dialog.SetFileTypes(&kinds).map_err(|err| err.to_string())?;
        dialog.SetTitle(w!("Add a sound")).map_err(|err| err.to_string())?;
        if let Err(err) = dialog.Show(Some(owner)) {
            if err.code().0 == 0x8007_04C7u32 as i32 {
                return Ok(None);
            }
            return Err(err.to_string());
        }
        let item = dialog.GetResult().map_err(|err| err.to_string())?;
        let wide = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|err| err.to_string())?;
        let text = wide.to_string().map_err(|err| err.to_string())?;
        CoTaskMemFree(Some(wide.0.cast()));
        Ok(Some(text))
    }
}

fn ensure_tools(app: &AppHandle) -> Result<(), String> {
    if tools_lock().is_some() {
        return Ok(());
    }
    let tools = locate_tools(app)?;
    *tools_lock() = Some(tools);
    Ok(())
}

fn locate_tools(app: &AppHandle) -> Result<Tools, String> {
    if let Some(tools) = bundled_tools(app) {
        return Ok(tools);
    }
    let ffmpeg = PathBuf::from(bin_name("ffmpeg"));
    let ffprobe = PathBuf::from(bin_name("ffprobe"));
    if runs(&ffmpeg) && runs(&ffprobe) {
        return Ok(Tools { ffmpeg, ffprobe });
    }
    Err(MISSING_TOOLS.into())
}

fn bundled_tools(app: &AppHandle) -> Option<Tools> {
    let mut dirs = Vec::new();
    if let Ok(root) = app.path().resource_dir() {
        dirs.push(root.join("ffmpeg"));
        dirs.push(root.join("resources").join("ffmpeg"));
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        dirs.push(PathBuf::from(manifest).join("resources").join("ffmpeg"));
    }
    for dir in dirs {
        let ffmpeg = dir.join(bin_name("ffmpeg"));
        let ffprobe = dir.join(bin_name("ffprobe"));
        if ffmpeg.is_file() && ffprobe.is_file() {
            return Some(Tools { ffmpeg, ffprobe });
        }
    }
    None
}

fn runs(program: &Path) -> bool {
    hidden_command(program).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|status| status.success()).unwrap_or(false)
}

fn tool(name: &str) -> Command {
    let program = {
        let slot = tools_lock();
        match (name, slot.as_ref()) {
            ("ffprobe", Some(tools)) => tools.ffprobe.clone(),
            (_, Some(tools)) => tools.ffmpeg.clone(),
            ("ffprobe", None) => PathBuf::from(bin_name("ffprobe")),
            (_, None) => PathBuf::from(bin_name("ffmpeg")),
        }
    };
    hidden_command(&program)
}

fn hidden_command(program: &Path) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        command.creation_flags(0x0800_0000);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

fn bin_name(name: &str) -> String {
    #[cfg(windows)]
    {
        format!("{name}.exe")
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn tools_lock() -> std::sync::MutexGuard<'static, Option<Tools>> {
    TOOLS.lock().unwrap_or_else(|err| err.into_inner())
}

fn read_progress(app: &AppHandle, path: &str, span_ms: u64, pipe: impl Read) {
    let reader = BufReader::new(pipe);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Some(rest) = line.strip_prefix("out_time=") else { continue };
        let Some(ms) = out_time_ms(rest) else { continue };
        let ratio = (ms as f64 / span_ms as f64).clamp(0.0, 0.99);
        emit(app, path, ratio, false);
    }
}

fn out_time_ms(text: &str) -> Option<u64> {
    let mut parts = text.trim().split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let mins: f64 = parts.next()?.parse().ok()?;
    let secs: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !hours.is_finite() || !mins.is_finite() || !secs.is_finite() {
        return None;
    }
    Some(((hours * 3600.0 + mins * 60.0 + secs) * 1000.0).round() as u64)
}

fn emit(app: &AppHandle, path: &str, ratio: f64, done: bool) {
    let _ = app.emit("video-edit", VideoProgress { path: path.to_string(), ratio, done });
}

fn take_status() -> Option<ExitStatus> {
    let child = job_lock().take()?;
    wait_child(child)
}

fn wait_child(mut child: std::process::Child) -> Option<ExitStatus> {
    child.wait().ok()
}

fn clear_job() {
    if let Some(mut child) = job_lock().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn job_lock() -> std::sync::MutexGuard<'static, Option<std::process::Child>> {
    JOB.lock().unwrap_or_else(|err| err.into_inner())
}

fn discard(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn fail_message(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.is_empty() {
        return "Can't save that video.".into();
    }
    let count = text.chars().count();
    let snippet: String = if count <= 280 { text.to_string() } else { text.chars().skip(count - 280).collect() };
    format!("Can't save that video. {snippet}")
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

#[cfg(test)]
mod tests {
    use super::{AudioChoice, EditSpec, Preset, build_graph, display_size, out_time_ms, place_edit, stream_rotation};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn spec(preset: Preset, crop_x: f64, crop_y: f64, quarters: i32, flip_h: bool, flip_v: bool, audio: AudioChoice, start: u64, end: u64) -> EditSpec {
        let extra = audio == AudioChoice::Replace;
        EditSpec {
            preset,
            crop_x,
            crop_y,
            quarters,
            flip_h,
            flip_v,
            start_ms: start,
            end_ms: end,
            sound_start_ms: start,
            sound_end_ms: end,
            sound_volume: 1.0,
            keep_sound: audio == AudioChoice::Keep,
            extra,
            extra_start_ms: start,
            extra_end_ms: end,
            extra_place_ms: start,
            extra_volume: 1.0,
        }
    }

    #[test]
    fn original_frame_only_trims_and_keeps_sound() {
        let graph = build_graph(1920, 1080, &spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 1000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (1920, 1080));
        assert!(!graph.filter.contains("crop"));
        assert!(!graph.filter.contains("scale"));
        assert!(!graph.filter.contains("hflip"));
        assert!(graph.filter.contains("trim=start=0.000:end=1.000"));
        assert!(graph.filter.contains("[0:a]atrim=start=0.000:end=1.000"));
        assert!(graph.maps_audio);
        assert!(!graph.second_input);
    }

    #[test]
    fn portrait_youtube_crops_without_upscale() {
        let graph = build_graph(1080, 1920, &spec(Preset::Youtube, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 10_000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (1080, 606));
        assert!(graph.filter.contains("crop=1080:606:0:656"));
        assert!(!graph.filter.contains("scale"));
    }

    #[test]
    fn landscape_tiktok_centers_the_vertical_crop() {
        let graph = build_graph(1920, 1080, &spec(Preset::Tiktok, 0.5, 0.5, 0, false, false, AudioChoice::Mute, 0, 1000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (606, 1080));
        assert!(graph.filter.contains("crop=606:1080:656:0"));
        assert!(!graph.maps_audio);
        assert!(!graph.filter.contains("[0:a]"));
    }

    #[test]
    fn small_widescreen_is_not_enlarged() {
        let graph = build_graph(640, 480, &spec(Preset::Youtube, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 1000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (640, 360));
        assert!(graph.filter.contains("crop=640:360:0:60"));
        assert!(!graph.filter.contains("scale"));
    }

    #[test]
    fn square_preset_scales_down_to_the_cap() {
        let graph = build_graph(4000, 3000, &spec(Preset::Instagram, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 1000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (1080, 1080));
        assert!(graph.filter.contains("crop=3000:3000:500:0"));
        let crop = graph.filter.find("crop=").unwrap();
        let scale = graph.filter.find("scale=1080:1080").unwrap();
        assert!(crop < scale);
    }

    #[test]
    fn four_by_three_fits_inside_a_widescreen_frame() {
        let graph = build_graph(1920, 1080, &spec(Preset::FourThree, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 1000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (1440, 1080));
        assert!(graph.filter.contains("crop=1440:1080:240:0"));
        assert!(!graph.filter.contains("scale"));
    }

    #[test]
    fn rotate_then_mirror_matches_the_picture_tools() {
        let graph = build_graph(1920, 1080, &spec(Preset::Original, 0.5, 0.5, 1, true, false, AudioChoice::Keep, 1500, 4000)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (1080, 1920));
        let transpose = graph.filter.find("transpose=1").unwrap();
        let flip = graph.filter.find("hflip").unwrap();
        assert!(transpose < flip);
        assert!(graph.filter.contains("trim=start=1.500:end=4.000"));
    }

    #[test]
    fn sound_can_start_later_than_the_picture() {
        let mut item = spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 10_000);
        item.sound_start_ms = 2_000;
        item.sound_end_ms = 6_000;
        let graph = build_graph(1280, 720, &item).unwrap();
        assert!(graph.maps_audio);
        assert!(graph.filter.contains("[0:a]atrim=start=2.000:end=6.000,asetpts=PTS-STARTPTS,adelay=2000:all=1[a]"));
    }

    #[test]
    fn sound_outside_the_trim_is_silent() {
        let mut item = spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 4_000);
        item.sound_start_ms = 5_000;
        item.sound_end_ms = 8_000;
        let graph = build_graph(1280, 720, &item).unwrap();
        assert!(!graph.maps_audio);
        assert!(!graph.filter.contains("[0:a]"));
    }

    #[test]
    fn replace_sound_uses_the_second_input_for_the_trimmed_length() {
        let graph = build_graph(1280, 720, &spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Replace, 1000, 9500)).unwrap();
        assert!(graph.second_input);
        assert!(!graph.shortest);
        assert!(graph.filter.contains("[1:a]atrim=start=1.000:end=9.500"));
        assert!(!graph.filter.contains("[0:a]"));
    }

    #[test]
    fn added_sound_mixes_with_the_original_at_its_own_level() {
        let mut item = spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 10_000);
        item.extra = true;
        item.extra_start_ms = 2_000;
        item.extra_end_ms = 7_000;
        item.sound_volume = 0.5;
        item.extra_volume = 0.8;
        let graph = build_graph(1280, 720, &item).unwrap();
        assert!(graph.second_input);
        assert!(graph.filter.contains("[0:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,volume=0.500,aformat=channel_layouts=stereo[orig]"));
        assert!(graph.filter.contains("[1:a]atrim=start=2.000:end=7.000,asetpts=PTS-STARTPTS,volume=0.800,aformat=channel_layouts=stereo[extra]"));
        assert!(graph.filter.contains("[orig][extra]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]"));
        assert!(!graph.filter.contains("adelay"));
    }

    #[test]
    fn added_sound_placed_later_in_the_clip_is_delayed() {
        let mut item = spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Keep, 0, 10_000);
        item.extra = true;
        item.extra_start_ms = 0;
        item.extra_end_ms = 3_000;
        item.extra_place_ms = 2_000;
        let graph = build_graph(1280, 720, &item).unwrap();
        assert!(graph.second_input);
        assert!(graph.filter.contains("[1:a]atrim=start=0.000:end=3.000,asetpts=PTS-STARTPTS,adelay=2000:all=1,aformat=channel_layouts=stereo[extra]"));
    }

    #[test]
    fn added_sound_longer_than_the_video_keeps_the_overlap() {
        let mut item = spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Replace, 0, 5_000);
        item.extra_start_ms = 0;
        item.extra_end_ms = 20_000;
        item.extra_place_ms = 0;
        let graph = build_graph(1280, 720, &item).unwrap();
        assert!(graph.second_input);
        assert!(graph.filter.contains("[1:a]atrim=start=0.000:end=5.000,asetpts=PTS-STARTPTS[a]"));
        assert!(!graph.filter.contains("adelay"));
    }

    #[test]
    fn odd_frames_become_even() {
        let graph = build_graph(1919, 1080, &spec(Preset::Original, 0.5, 0.5, 0, false, false, AudioChoice::Mute, 0, 500)).unwrap();
        assert_eq!((graph.out_width, graph.out_height), (1918, 1080));
        assert!(graph.filter.contains("crop=1918:1080:0:0"));
    }

    #[test]
    fn phone_rotation_swaps_the_display_size() {
        assert_eq!(display_size(1920, 1080, 90), (1080, 1920));
        assert_eq!(display_size(1920, 1080, 270), (1080, 1920));
        assert_eq!(display_size(1920, 1080, 180), (1920, 1080));
        let stream = json!({ "tags": { "rotate": "-90" } });
        assert_eq!(stream_rotation(&stream), 270);
        let side = json!({ "side_data_list": [ { "rotation": -90.0 } ] });
        assert_eq!(stream_rotation(&side), 270);
    }

    #[test]
    fn progress_clock_is_milliseconds() {
        assert_eq!(out_time_ms("00:00:01.500000"), Some(1500));
        assert_eq!(out_time_ms("00:01:02.250000"), Some(62_250));
        assert_eq!(out_time_ms("nope"), None);
    }

    #[test]
    fn sibling_names_count_up() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("filepad-video-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("clip.mov");
        fs::write(&source, b"x").unwrap();
        let first = place_edit(&source).unwrap();
        assert!(first.ends_with("clip-edit.mp4"));
        fs::write(&first, b"x").unwrap();
        let second = place_edit(&source).unwrap();
        assert!(second.ends_with("clip-edit-2.mp4"));
        fs::write(&second, b"x").unwrap();
        let third = place_edit(&source).unwrap();
        assert!(third.ends_with("clip-edit-3.mp4"));
        let _ = fs::remove_dir_all(&dir);
    }
}
