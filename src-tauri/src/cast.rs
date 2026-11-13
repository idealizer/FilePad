use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Screen {
    pub id: String,
    pub name: String,
    pub audio: bool,
    pub video: bool,
}

#[derive(Clone)]
enum Kind {
    Dlna(String),
    Cast(Ipv4Addr, u16),
}

struct Live {
    stop: Arc<AtomicBool>,
    kind: Kind,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

static SEEN: Mutex<Vec<(Screen, std::time::Instant)>> = Mutex::new(Vec::new());

pub fn screens() -> Result<Vec<Screen>, String> {
    let cast_search = thread::spawn(cast_screens);
    let dlna = dlna_screens();
    let mut found = cast_search.join().unwrap_or_default();
    match dlna {
        Ok(list) => found.extend(list),
        Err(err) if found.is_empty() && recall().is_empty() => return Err(err),
        Err(_) => {}
    }
    let now = std::time::Instant::now();
    let mut seen = SEEN.lock().unwrap_or_else(|err| err.into_inner());
    seen.retain(|(_, at)| now.saturating_duration_since(*at) < Duration::from_secs(15 * 60));
    for screen in &found {
        if let Some(slot) = seen.iter_mut().find(|(have, _)| have.id == screen.id) {
            *slot = (screen.clone(), now);
        } else {
            seen.push((screen.clone(), now));
        }
    }
    for (screen, _) in seen.iter() {
        if !found.iter().any(|have| have.id == screen.id) {
            found.push(screen.clone());
        }
    }
    drop(seen);
    found.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(found)
}

fn recall() -> Vec<Screen> {
    let now = std::time::Instant::now();
    SEEN.lock()
        .unwrap_or_else(|err| err.into_inner())
        .iter()
        .filter(|(_, at)| now.saturating_duration_since(*at) < Duration::from_secs(15 * 60))
        .map(|(screen, _)| screen.clone())
        .collect()
}

fn dlna_screens() -> Result<Vec<Screen>, String> {
    let locations = discover().map_err(|err| format!("Can't look for devices. {err}"))?;
    let agent = http_agent();
    let mut handles = Vec::new();
    for location in locations.into_iter().take(32) {
        let agent = agent.clone();
        handles.push(thread::spawn(move || screen_at(&agent, &location)));
    }
    let mut found = Vec::new();
    for handle in handles {
        let Ok(Some(screen)) = handle.join() else { continue };
        if found.iter().any(|have: &Screen| have.id == screen.id) {
            continue;
        }
        found.push(screen);
    }
    Ok(found)
}

fn screen_at(agent: &ureq::Agent, location: &str) -> Option<Screen> {
    let mut response = agent.get(location).call().ok()?;
    let xml = response.body_mut().read_to_string().ok()?;
    let control = join_url(location, &av_control(&xml)?);
    let name = xml_text(&xml, "friendlyName").filter(|name| !name.is_empty()).unwrap_or_else(|| host_label(location));
    let maker = format!(
        "{name} {} {} {xml}",
        xml_text(&xml, "manufacturer").unwrap_or_default(),
        xml_text(&xml, "modelName").unwrap_or_default()
    )
    .to_lowercase();
    let speaker = maker.contains("sonos") || maker.contains("zoneplayer");
    Some(Screen { id: control, name, audio: true, video: !speaker })
}

pub fn play(path: &str, screen: &str) -> Result<(), String> {
    let file = Path::new(path);
    if !file.is_file() {
        return Err("That file is not on this computer.".into());
    }
    let _ = stop();
    if let Some(spec) = screen.strip_prefix("cast://") {
        let (host, port) = spec.split_once(':').ok_or("That screen could not be used.")?;
        let ip: Ipv4Addr = host.parse().map_err(|_| "That screen is not on an IPv4 network this computer can reach.")?;
        let port: u16 = port.parse().map_err(|_| "That screen could not be used.")?;
        let offer = share(file, ip)?;
        if let Err(err) = cast_load(ip, port, &offer.url, offer.mime, &offer.title, &offer.artist, offer.art.as_deref()) {
            offer.stop.store(true, Ordering::Relaxed);
            return Err(err);
        }
        *lock() = Some(Live { stop: offer.stop, kind: Kind::Cast(ip, port) });
        return Ok(());
    }
    let host = host_v4(screen).ok_or("That screen is not on an IPv4 network this computer can reach.")?;
    let offer = share(file, host)?;
    let name = file.file_name().and_then(|name| name.to_str()).unwrap_or("media").to_string();
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let class = if offer.mime.starts_with("audio/") { "object.item.audioItem.musicTrack" } else { "object.item.videoItem" };
    let meta = didl(&name, &offer.url, offer.mime, class, size, offer.art.as_deref());
    if let Err(err) = soap(screen, "SetAVTransportURI", &format!("<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>", xml_escape(&offer.url), xml_escape(&meta))) {
        offer.stop.store(true, Ordering::Relaxed);
        return Err(err);
    }
    if let Err(err) = soap(screen, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>") {
        offer.stop.store(true, Ordering::Relaxed);
        let _ = soap(screen, "Stop", "<InstanceID>0</InstanceID>");
        return Err(err);
    }
    *lock() = Some(Live { stop: offer.stop, kind: Kind::Dlna(screen.to_string()) });
    Ok(())
}

struct Offer {
    stop: Arc<AtomicBool>,
    url: String,
    mime: &'static str,
    title: String,
    artist: String,
    art: Option<String>,
}

fn share(file: &Path, device: Ipv4Addr) -> Result<Offer, String> {
    let lan = lan_ip(device)?;
    let token = token();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|_| "Can't open a port for the screen.".to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let mime = media_type(file);
    let card = crate::preview::track_card(file);
    let cover = card.cover.map(Arc::new);
    let art = cover.as_ref().map(|image| format!("http://{lan}:{port}/v/{token}/art.{}", art_ext(&image.0)));
    let url = format!("http://{lan}:{port}/v/{token}{}", ext_of(file));
    let serve_path = file.to_path_buf();
    let serve_token = token;
    let serve_stop = stop_flag.clone();
    let serve_cover = cover.clone();
    thread::Builder::new()
        .name("filepad-cast".into())
        .spawn(move || serve(listener, serve_path, serve_token, serve_stop, serve_cover))
        .map_err(|err| err.to_string())?;
    Ok(Offer { stop: stop_flag, url, mime, title: card.title, artist: card.artist, art })
}

fn art_ext(mime: &str) -> &'static str {
    if mime.contains("png") { "png" } else { "jpg" }
}

pub fn pause() -> Result<(), String> {
    match live_kind() {
        Some(Kind::Dlna(control)) => soap(&control, "Pause", "<InstanceID>0</InstanceID>"),
        Some(Kind::Cast(ip, port)) => cast_control(ip, port, "PAUSE", None),
        None => Ok(()),
    }
}

pub fn resume() -> Result<(), String> {
    match live_kind() {
        Some(Kind::Dlna(control)) => soap(&control, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>"),
        Some(Kind::Cast(ip, port)) => cast_control(ip, port, "PLAY", None),
        None => Ok(()),
    }
}

pub fn seek(ms: u64) -> Result<(), String> {
    match live_kind() {
        Some(Kind::Dlna(control)) => soap(
            &control,
            "Seek",
            &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>", rel_time(ms)),
        ),
        Some(Kind::Cast(ip, port)) => cast_control(ip, port, "SEEK", Some(ms as f64 / 1000.0)),
        None => Ok(()),
    }
}

fn live_kind() -> Option<Kind> {
    lock().as_ref().map(|live| live.kind.clone())
}

fn rel_time(ms: u64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}:{:02}", total / 3600, (total % 3600) / 60, total % 60)
}

pub fn stop() -> Result<(), String> {
    let live = lock().take();
    let Some(live) = live else { return Ok(()) };
    match live.kind {
        Kind::Dlna(control) => {
            let _ = soap(&control, "Stop", "<InstanceID>0</InstanceID>");
        }
        Kind::Cast(ip, port) => {
            let _ = cast_halt(ip, port);
        }
    }
    live.stop.store(true, Ordering::Relaxed);
    Ok(())
}

fn lock() -> std::sync::MutexGuard<'static, Option<Live>> {
    LIVE.lock().unwrap_or_else(|err| err.into_inner())
}

const SEARCH_TARGETS: [&str; 5] = [
    "urn:schemas-upnp-org:device:MediaRenderer:1",
    "urn:schemas-upnp-org:device:MediaRenderer:2",
    "urn:schemas-upnp-org:service:AVTransport:1",
    "urn:schemas-upnp-org:device:ZonePlayer:1",
    "ssdp:all",
];

fn discover() -> std::io::Result<Vec<String>> {
    let mut sockets = Vec::new();
    for ip in local_v4() {
        if let Ok(socket) = UdpSocket::bind((ip, 0)) {
            let _ = socket.set_multicast_ttl_v4(4);
            sockets.push(socket);
        }
    }
    if sockets.is_empty() {
        sockets.push(UdpSocket::bind("0.0.0.0:0")?);
    }
    for socket in &sockets {
        socket.set_read_timeout(Some(Duration::from_millis(200)))?;
    }
    let announce = |sockets: &[UdpSocket]| {
        for socket in sockets {
            for target in SEARCH_TARGETS {
                let packet = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 3\r\nST: {target}\r\n\r\n");
                let _ = socket.send_to(packet.as_bytes(), "239.255.255.250:1900");
            }
        }
    };
    announce(&sockets);
    let started = std::time::Instant::now();
    let deadline = started + Duration::from_millis(3200);
    let mut repeated = false;
    let mut locations = Vec::new();
    let mut buf = [0u8; 4096];
    while std::time::Instant::now() < deadline {
        if !repeated && started.elapsed() >= Duration::from_millis(700) {
            announce(&sockets);
            repeated = true;
        }
        let mut heard = false;
        for socket in &sockets {
            if let Ok((size, _)) = socket.recv_from(&mut buf) {
                heard = true;
                let text = String::from_utf8_lossy(&buf[..size]);
                if let Some(location) = header(&text, "LOCATION") {
                    if host_v4(location).is_some() && !locations.iter().any(|have: &String| have == location) {
                        locations.push(location.to_string());
                    }
                }
            }
        }
        if !heard {
            thread::sleep(Duration::from_millis(40));
        }
    }
    Ok(locations)
}

fn local_v4() -> Vec<Ipv4Addr> {
    #[cfg(windows)]
    {
        local_v4_windows()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn local_v4_windows() -> Vec<Ipv4Addr> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};
    unsafe {
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let family = AF_INET.0 as u32;
        let mut size = 15_000u32;
        let mut words = vec![0u64; (size as usize / 8) + 8];
        let mut code = GetAdaptersAddresses(family, flags, None, Some(words.as_mut_ptr().cast()), &mut size);
        if code == 111 {
            words.resize((size as usize / 8) + 8, 0);
            code = GetAdaptersAddresses(family, flags, None, Some(words.as_mut_ptr().cast()), &mut size);
        }
        if code != 0 {
            return Vec::new();
        }
        let mut ips = Vec::new();
        let mut current = words.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !current.is_null() {
            let adapter = &*current;
            if adapter.OperStatus == IfOperStatusUp {
                let mut address = adapter.FirstUnicastAddress;
                while !address.is_null() {
                    let unicast = &*address;
                    let sockaddr = unicast.Address.lpSockaddr;
                    if !sockaddr.is_null() && (*sockaddr).sa_family == AF_INET {
                        let v4 = &*(sockaddr as *const SOCKADDR_IN);
                        let bytes = v4.sin_addr.S_un.S_un_b;
                        let ip = Ipv4Addr::new(bytes.s_b1, bytes.s_b2, bytes.s_b3, bytes.s_b4);
                        if !ip.is_loopback() && !ip.is_unspecified() && !ips.contains(&ip) {
                            ips.push(ip);
                        }
                    }
                    address = unicast.Next;
                }
            }
            current = adapter.Next;
        }
        ips
    }
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(3))).build().into()
}

fn serve(listener: TcpListener, path: std::path::PathBuf, token: String, stop: Arc<AtomicBool>, cover: Option<Arc<(String, Vec<u8>)>>) {
    let _ = listener.set_nonblocking(true);
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let path = path.clone();
                let token = token.clone();
                let cover = cover.clone();
                let _ = thread::Builder::new().name("filepad-cast-send".into()).spawn(move || {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_nodelay(true);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
                    let _ = stream.set_write_timeout(None);
                    let _ = answer(stream, &path, &token, cover.as_deref());
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(40)),
            Err(_) => break,
        }
    }
}

fn answer(mut stream: TcpStream, path: &Path, token: &str, cover: Option<&(String, Vec<u8>)>) -> std::io::Result<()> {
    let head = read_head(&mut stream)?;
    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("").split('?').next().unwrap_or("");
    if !target.starts_with(&format!("/v/{token}")) || target.contains("..") {
        return write_status(&mut stream, 404, "Not found");
    }
    if target.starts_with(&format!("/v/{token}/art.")) {
        let Some((mime, bytes)) = cover else { return write_status(&mut stream, 404, "Not found") };
        return write_bytes(&mut stream, mime, bytes, method);
    }
    let file_len = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if file_len == 0 {
        return write_status(&mut stream, 404, "Empty");
    }
    let range = lines.clone().find_map(|line| header(line, "RANGE"));
    let Ok((start, end)) = parse_range(range, file_len) else {
        return write_status(&mut stream, 416, "Range not satisfiable");
    };
    let mime = media_type(path);
    let partial = start > 0 || end + 1 < file_len;
    let status = if partial { 206 } else { 200 };
    let length = end - start + 1;
    let mut headers = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\ntransferMode.dlna.org: Interactive\r\nConnection: close\r\n",
        if partial { "Partial Content" } else { "OK" }
    );
    if partial {
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{file_len}\r\n"));
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;
    if method.eq_ignore_ascii_case("HEAD") {
        return Ok(());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut left = length;
    let mut buf = [0u8; 64 * 1024];
    while left > 0 {
        let take = buf.len().min(left as usize);
        let read = file.read(&mut buf[..take])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buf[..read])?;
        left -= read as u64;
    }
    Ok(())
}

fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while buf.len() < 8192 {
        if stream.read(&mut byte)? == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn write_bytes(stream: &mut TcpStream, mime: &str, bytes: &[u8], method: &str) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
    stream.write_all(head.as_bytes())?;
    if !method.eq_ignore_ascii_case("HEAD") {
        stream.write_all(bytes)?;
    }
    Ok(())
}

fn write_status(stream: &mut TcpStream, status: u16, text: &str) -> std::io::Result<()> {
    let body = text.as_bytes();
    let head = format!("HTTP/1.1 {status} {text}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)
}

fn soap(control: &str, action: &str, body: &str) -> Result<(), String> {
    let envelope = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">{body}</u:{action}></s:Body></s:Envelope>"
    );
    let agent = http_agent();
    let mut response = agent
        .post(control)
        .header("content-type", "text/xml; charset=\"utf-8\"")
        .header("soapaction", &format!("\"urn:schemas-upnp-org:service:AVTransport:1#{action}\""))
        .send(&envelope)
        .map_err(|_| format!("Can't reach {control}."))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let detail = response.body_mut().read_to_string().unwrap_or_default();
    let note = xml_text(&detail, "errorDescription").or_else(|| xml_text(&detail, "faultstring"));
    Err(note.unwrap_or_else(|| format!("The screen refused to play ({status}).")))
}

fn didl(title: &str, url: &str, mime: &str, class: &str, size: u64, art: Option<&str>) -> String {
    let protocol = if mime.starts_with("audio/") {
        format!("http-get:*:{mime}:*")
    } else {
        format!("http-get:*:{mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000")
    };
    let size_attr = if size > 0 { format!(" size=\"{size}\"") } else { String::new() };
    let poster = art.map(|url| format!("<upnp:albumArtURI>{}</upnp:albumArtURI>", xml_escape(url))).unwrap_or_default();
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>{}</dc:title><upnp:class>{}</upnp:class>{poster}<res protocolInfo=\"{protocol}\"{size_attr}>{}</res></item></DIDL-Lite>",
        xml_escape(title),
        class,
        xml_escape(url)
    )
}

fn lan_ip(device: Ipv4Addr) -> Result<Ipv4Addr, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|err| err.to_string())?;
    socket.connect((device, 1900)).map_err(|_| "This computer has no address on that screen's network.".to_string())?;
    match socket.local_addr().map_err(|err| err.to_string())?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Ok(ip),
        _ => Err("This computer has no address on that screen's network.".into()),
    }
}

fn token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
    format!("{nanos:x}{:x}", std::process::id())
}

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|ext| ext.to_str()).map(|ext| format!(".{ext}")).unwrap_or_default()
}

fn media_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn host_v4(url: &str) -> Option<Ipv4Addr> {
    host_of(url).and_then(|host| host.parse().ok())
}

fn host_label(url: &str) -> String {
    host_of(url).unwrap_or("Screen").to_string()
}

fn host_of(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let hostport = rest.split(['/', '?', '#']).next()?;
    let host = hostport.rsplit_once(':').map(|(host, _)| host).unwrap_or(hostport);
    let host = host.trim_matches(['[', ']']);
    if host.is_empty() { None } else { Some(host) }
}

fn header<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = xml.find(&open)?;
    let rest = &xml[start + open.len()..];
    let bracket = rest.find('>')?;
    if rest.as_bytes().get(bracket.saturating_sub(1)) == Some(&b'/') {
        return Some(String::new());
    }
    let after = &rest[bracket + 1..];
    let end = after.find(&format!("</{tag}>"))?;
    Some(xml_decode(after[..end].trim()))
}

fn av_control(xml: &str) -> Option<String> {
    let marker = "urn:schemas-upnp-org:service:AVTransport:";
    let at = xml.find(marker)?;
    let window = &xml[at..];
    let end = window.find("</service>").unwrap_or(window.len().min(2500));
    xml_text(&window[..end], "controlURL")
}

fn join_url(base: &str, control: &str) -> String {
    if control.starts_with("http://") || control.starts_with("https://") {
        return control.to_string();
    }
    if control.starts_with('/') {
        if let Some(scheme) = base.find("://") {
            let rest = &base[scheme + 3..];
            if let Some(slash) = rest.find('/') {
                return format!("{}{control}", &base[..scheme + 3 + slash]);
            }
            return format!("{base}{control}");
        }
    }
    let dir = base.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(base);
    format!("{dir}/{control}")
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn xml_decode(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn parse_range(header: Option<&str>, len: u64) -> Result<(u64, u64), ()> {
    if len == 0 {
        return Err(());
    }
    let Some(header) = header else {
        return Ok((0, len - 1));
    };
    let value = header.trim().strip_prefix("bytes=").ok_or(())?;
    let (start_text, end_text) = value.split_once('-').ok_or(())?;
    let start = if start_text.is_empty() { 0 } else { start_text.parse().map_err(|_| ())? };
    if start >= len {
        return Err(());
    }
    let end = if end_text.is_empty() { len - 1 } else { end_text.parse::<u64>().map_err(|_| ())?.min(len - 1) };
    if end < start { Err(()) } else { Ok((start, end)) }
}

fn cast_screens() -> Vec<Screen> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
    let Ok(receiver) = daemon.browse("_googlecast._tcp.local.") else {
        let _ = daemon.shutdown();
        return Vec::new();
    };
    let deadline = std::time::Instant::now() + Duration::from_millis(2200);
    let mut found = Vec::new();
    while std::time::Instant::now() < deadline {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(200)) else { continue };
        let mdns_sd::ServiceEvent::ServiceResolved(info) = event else { continue };
        let Some(ip) = info.get_addresses_v4().into_iter().next() else { continue };
        let port = info.get_port();
        if port == 0 { continue; }
        let name = info.get_property_val_str("fn").filter(|name| !name.is_empty()).unwrap_or("TV").to_string();
        let id = format!("cast://{ip}:{port}");
        if found.iter().any(|screen: &Screen| screen.id == id) { continue; }
        found.push(Screen { id, name, audio: true, video: true });
    }
    let _ = daemon.shutdown();
    found
}

const CAST_CONN: &str = "urn:x-cast:com.google.cast.tp.connection";
const CAST_HEART: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const CAST_RECV: &str = "urn:x-cast:com.google.cast.receiver";
const CAST_MEDIA: &str = "urn:x-cast:com.google.cast.media";

fn cast_load(ip: Ipv4Addr, port: u16, url: &str, mime: &str, title: &str, artist: &str, art: Option<&str>) -> Result<(), String> {
    let mut stream = cast_connect(ip, port)?;
    cast_send(&mut stream, "receiver-0", CAST_CONN, r#"{"type":"CONNECT","origin":{}}"#)?;
    cast_send(&mut stream, "receiver-0", CAST_RECV, r#"{"type":"GET_STATUS","requestId":1}"#)?;
    let mut transport = cast_wait_app(&mut stream, Duration::from_secs(3), true)?;
    if transport.is_none() {
        cast_send(&mut stream, "receiver-0", CAST_RECV, r#"{"type":"LAUNCH","appId":"CC1AD845","requestId":2}"#)?;
        transport = cast_wait_app(&mut stream, Duration::from_secs(8), false)?;
    }
    let Some(transport) = transport else { return Err("The screen did not open its player.".into()) };
    cast_send(&mut stream, &transport, CAST_CONN, r#"{"type":"CONNECT","origin":{}}"#)?;
    let load = serde_json::json!({
        "type": "LOAD",
        "requestId": 3,
        "autoplay": true,
        "media": cast_media(url, mime, title, artist, art)
    });
    cast_send(&mut stream, &transport, CAST_MEDIA, &load.to_string())?;
    cast_wait_media(&mut stream, Duration::from_secs(8))
}

fn cast_media(url: &str, mime: &str, title: &str, artist: &str, art: Option<&str>) -> serde_json::Value {
    let mut media = serde_json::json!({
        "contentId": url,
        "contentType": mime,
        "streamType": "BUFFERED"
    });
    if mime.starts_with("audio/") {
        let mut metadata = serde_json::json!({ "metadataType": 3, "title": title });
        if !artist.is_empty() {
            metadata["artist"] = serde_json::Value::String(artist.to_string());
        }
        if let Some(art) = art {
            metadata["images"] = serde_json::json!([{ "url": art }]);
        }
        media["metadata"] = metadata;
    }
    media
}

fn cast_control(ip: Ipv4Addr, port: u16, action: &str, seconds: Option<f64>) -> Result<(), String> {
    let mut stream = cast_connect(ip, port)?;
    cast_send(&mut stream, "receiver-0", CAST_CONN, r#"{"type":"CONNECT","origin":{}}"#)?;
    cast_send(&mut stream, "receiver-0", CAST_RECV, r#"{"type":"GET_STATUS","requestId":1}"#)?;
    let transport = cast_wait_app(&mut stream, Duration::from_secs(4), false)?.ok_or_else(|| "The screen is not playing.".to_string())?;
    cast_send(&mut stream, &transport, CAST_CONN, r#"{"type":"CONNECT","origin":{}}"#)?;
    cast_send(&mut stream, &transport, CAST_MEDIA, r#"{"type":"GET_STATUS","requestId":2}"#)?;
    let status = cast_read_until(&mut stream, Duration::from_secs(4), "MEDIA_STATUS")?;
    let session = media_session(&status).unwrap_or(1);
    let message = match seconds {
        Some(time) => serde_json::json!({ "type": "SEEK", "mediaSessionId": session, "currentTime": time, "requestId": 3 }),
        None => serde_json::json!({ "type": action, "mediaSessionId": session, "requestId": 3 }),
    };
    cast_send(&mut stream, &transport, CAST_MEDIA, &message.to_string())
}

fn cast_read_until(stream: &mut native_tls::TlsStream<TcpStream>, limit: Duration, needle: &str) -> Result<String, String> {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        let payload = cast_read(stream)?;
        if payload.contains(needle) {
            return Ok(payload);
        }
    }
    Err("The screen did not answer.".into())
}

fn media_session(payload: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    value.pointer("/status/0/mediaSessionId").and_then(|item| item.as_u64())
}

fn cast_halt(ip: Ipv4Addr, port: u16) -> Result<(), String> {
    let mut stream = cast_connect(ip, port)?;
    cast_send(&mut stream, "receiver-0", CAST_CONN, r#"{"type":"CONNECT","origin":{}}"#)?;
    cast_send(&mut stream, "receiver-0", CAST_RECV, r#"{"type":"STOP","requestId":1}"#)?;
    Ok(())
}

fn cast_connect(ip: Ipv4Addr, port: u16) -> Result<native_tls::TlsStream<TcpStream>, String> {
    let tcp = TcpStream::connect_timeout(&std::net::SocketAddr::from((ip, port)), Duration::from_secs(5)).map_err(|_| format!("Can't reach the screen at {ip}."))?;
    tcp.set_read_timeout(Some(Duration::from_secs(8))).map_err(|err| err.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(8))).map_err(|err| err.to_string())?;
    let connector = native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true).build().map_err(|err| err.to_string())?;
    connector.connect("chromecast", tcp).map_err(|err| format!("The screen refused the secure connection. {err}"))
}

fn cast_send(stream: &mut native_tls::TlsStream<TcpStream>, dest: &str, namespace: &str, payload: &str) -> Result<(), String> {
    stream.write_all(&cast_frame("sender-0", dest, namespace, payload)).map_err(|_| "Can't talk to the screen.".to_string())
}

fn cast_wait_app(stream: &mut native_tls::TlsStream<TcpStream>, limit: Duration, stop_on_status: bool) -> Result<Option<String>, String> {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        let payload = cast_read(stream)?;
        if let Some(transport) = cast_transport(&payload) {
            return Ok(Some(transport));
        }
        if stop_on_status && payload.contains("RECEIVER_STATUS") {
            return Ok(None);
        }
    }
    Ok(None)
}

fn cast_wait_media(stream: &mut native_tls::TlsStream<TcpStream>, limit: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        let payload = cast_read(stream)?;
        if payload.contains("LOAD_FAILED") || payload.contains("INVALID_REQUEST") {
            return Err("The screen could not play that file.".into());
        }
        if payload.contains("MEDIA_STATUS") {
            return Ok(());
        }
    }
    Err("The screen did not start playback.".into())
}

fn cast_read(stream: &mut native_tls::TlsStream<TcpStream>) -> Result<String, String> {
    loop {
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).map_err(|_| "The screen closed the connection.".to_string())?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > 1024 * 1024 {
            return Err("The screen sent an unexpected reply.".into());
        }
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).map_err(|_| "The screen closed the connection.".to_string())?;
        let payload = payload_of(&body);
        if payload.contains("\"PING\"") {
            cast_send(stream, "receiver-0", CAST_HEART, r#"{"type":"PONG"}"#)?;
            continue;
        }
        return Ok(payload);
    }
}

fn cast_transport(payload: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let apps = value.get("status")?.get("applications")?.as_array()?;
    for app in apps {
        if app.get("appId").and_then(|item| item.as_str()) != Some("CC1AD845") {
            continue;
        }
        let transport = app.get("transportId").and_then(|item| item.as_str()).unwrap_or("");
        if !transport.is_empty() {
            return Some(transport.to_string());
        }
    }
    None
}

fn cast_frame(source: &str, dest: &str, namespace: &str, payload: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend(field_varint(1, 0));
    body.extend(field_bytes(2, source.as_bytes()));
    body.extend(field_bytes(3, dest.as_bytes()));
    body.extend(field_bytes(4, namespace.as_bytes()));
    body.extend(field_varint(5, 0));
    body.extend(field_bytes(6, payload.as_bytes()));
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend(body);
    frame
}

fn field_varint(field: u32, value: u64) -> Vec<u8> {
    let mut out = varint((u64::from(field) << 3) | 0);
    out.extend(varint(value));
    out
}

fn field_bytes(field: u32, value: &[u8]) -> Vec<u8> {
    let mut out = varint((u64::from(field) << 3) | 2);
    out.extend(varint(value.len() as u64));
    out.extend(value);
    out
}

fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
    out
}

fn payload_of(body: &[u8]) -> String {
    let mut index = 0;
    while index < body.len() {
        let Some((key, next)) = take_varint(body, index) else { break };
        index = next;
        let field = key >> 3;
        let wire = key & 7;
        if wire == 0 {
            let Some((_, next)) = take_varint(body, index) else { break };
            index = next;
        } else if wire == 2 {
            let Some((len, next)) = take_varint(body, index) else { break };
            index = next;
            let end = (index + len as usize).min(body.len());
            if field == 6 {
                return String::from_utf8_lossy(&body[index..end]).into_owned();
            }
            index = end;
        } else {
            break;
        }
    }
    String::new()
}

fn take_varint(buf: &[u8], mut index: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    while index < buf.len() && shift < 64 {
        let byte = buf[index];
        index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, index));
        }
        shift += 7;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_yields_the_transport_control() {
        let xml = r#"<root><device><friendlyName>Living Room</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></serviceList></device></root>"#;
        assert_eq!(xml_text(xml, "friendlyName").as_deref(), Some("Living Room"));
        assert_eq!(av_control(xml).as_deref(), Some("/av"));
        assert_eq!(join_url("http://192.168.1.20:1400/desc.xml", "/av"), "http://192.168.1.20:1400/av");
        assert_eq!(join_url("http://192.168.1.20:1400/desc.xml", "http://192.168.1.20:1400/av"), "http://192.168.1.20:1400/av");
    }

    #[test]
    fn range_keeps_a_byte_window() {
        assert_eq!(parse_range(None, 1000), Ok((0, 999)));
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Ok((0, 99)));
        assert_eq!(parse_range(Some("bytes=500-"), 1000), Ok((500, 999)));
        assert!(parse_range(Some("bytes=1000-"), 1000).is_err());
    }

    #[test]
    fn location_header_is_read_from_the_search_reply() {
        let packet = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20:1400/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n";
        assert_eq!(header(packet, "LOCATION"), Some("http://192.168.1.20:1400/desc.xml"));
    }

    #[test]
    fn metadata_escapes_the_title() {
        let meta = didl("A & B", "http://10.0.0.2/v/1.mp4", "video/mp4", "object.item.videoItem", 10, None);
        assert!(meta.contains("A &amp; B"));
        assert!(meta.contains("video/mp4"));
        assert!(meta.contains("DLNA.ORG_OP=01"));
        assert!(!meta.contains("A & B"));
        let song = didl("Song", "http://10.0.0.2/v/1.mp3", "audio/mpeg", "object.item.audioItem.musicTrack", 20, Some("http://10.0.0.2/v/1/art.jpg"));
        assert!(song.contains("http-get:*:audio/mpeg:*"));
        assert!(song.contains("musicTrack"));
        assert!(song.contains("size=\"20\""));
        assert!(song.contains("albumArtURI"));
        assert!(!song.contains("DLNA.ORG_FLAGS"));
        let media = cast_media("http://10.0.0.2/v/1.mp3", "audio/mpeg", "Song", "Band", Some("http://10.0.0.2/v/1/art.jpg"));
        assert_eq!(media["metadata"]["metadataType"], 3);
        assert_eq!(media["metadata"]["title"], "Song");
        assert_eq!(media["metadata"]["images"][0]["url"], "http://10.0.0.2/v/1/art.jpg");
        assert_eq!(rel_time(0), "0:00:00");
        assert_eq!(rel_time(90_000), "0:01:30");
        assert_eq!(rel_time(3_661_000), "1:01:01");
        let status = r#"{"type":"MEDIA_STATUS","status":[{"mediaSessionId":7,"playerState":"PLAYING"}]}"#;
        assert_eq!(media_session(status), Some(7));
    }

    #[test]
    fn cast_message_keeps_the_payload() {
        let frame = cast_frame("sender-0", "receiver-0", CAST_CONN, r#"{"type":"CONNECT"}"#);
        let body = &frame[4..];
        assert_eq!(payload_of(body), r#"{"type":"CONNECT"}"#);
        assert_eq!(u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize, body.len());
    }
}
