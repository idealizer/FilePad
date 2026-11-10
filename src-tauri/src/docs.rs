use std::io::{Cursor, Read};
use zip::ZipArchive;

pub fn text_of(extension: &str, bytes: &[u8]) -> Result<String, String> {
    let text = match extension {
        "pptx" => pptx_bytes(bytes)?,
        "odt" => odt_bytes(bytes)?,
        "doc" => doc_bytes(bytes)?,
        "ppt" => ppt_bytes(bytes)?,
        _ => return Err("That document can't be previewed.".into()),
    };
    if text.trim().is_empty() {
        return Err("That document has no readable text.".into());
    }
    Ok(text)
}

fn pptx_bytes(bytes: &[u8]) -> Result<String, String> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Can't read that presentation.".to_string())?;
    let mut slides = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| "Can't read that presentation.".to_string())?;
        let name = entry.name().to_string();
        let Some(number) = slide_number(&name) else { continue };
        let mut xml = String::new();
        entry.read_to_string(&mut xml).map_err(|_| "Can't read that presentation.".to_string())?;
        slides.push((number, slide_text(&xml)));
    }
    if slides.is_empty() {
        return Err("That presentation has no slides.".into());
    }
    slides.sort_by_key(|slide| slide.0);
    let mut out = String::new();
    for (number, text) in slides {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("Slide {number}"));
        if text.trim().is_empty() {
            out.push_str("\n(no text)");
        } else {
            out.push('\n');
            out.push_str(text.trim());
        }
    }
    Ok(out)
}

fn slide_number(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
    if rest.is_empty() || !rest.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

fn slide_text(xml: &str) -> String {
    let mut lines = Vec::new();
    for para in xml.split("</a:p>") {
        let line = tagged_text(para, "a:t");
        if !line.is_empty() {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        tagged_text(xml, "a:t")
    } else {
        lines.join("\n")
    }
}

fn odt_bytes(bytes: &[u8]) -> Result<String, String> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Can't read that document.".to_string())?;
    let mut entry = zip.by_name("content.xml").map_err(|_| "Can't read that document.".to_string())?;
    let mut xml = String::new();
    entry.read_to_string(&mut xml).map_err(|_| "Can't read that document.".to_string())?;
    let marked = xml
        .replace("</text:p>", "\n")
        .replace("</text:h>", "\n")
        .replace("<text:line-break/>", "\n")
        .replace("<text:line-break />", "\n");
    let mut plain = String::new();
    let mut in_tag = false;
    for ch in marked.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            plain.push(ch);
        }
    }
    Ok(tidy_lines(&decode_xml(&plain)))
}

fn ppt_bytes(bytes: &[u8]) -> Result<String, String> {
    let mut parts = Vec::new();
    let mut index = 0;
    while index + 8 <= bytes.len() {
        let kind = (bytes[index] == 0 && bytes[index + 1] == 0 && bytes[index + 3] == 0x0F).then_some(bytes[index + 2]);
        let Some(kind) = kind.filter(|kind| *kind == 0xA0 || *kind == 0xA8) else {
            index += 1;
            continue;
        };
        let len = u32::from_le_bytes([bytes[index + 4], bytes[index + 5], bytes[index + 6], bytes[index + 7]]) as usize;
        if len == 0 || len > 64 * 1024 || index + 8 + len > bytes.len() || (kind == 0xA0 && len % 2 != 0) {
            index += 1;
            continue;
        }
        let slice = &bytes[index + 8..index + 8 + len];
        let text = if kind == 0xA0 { utf16_slice(slice) } else { cp1252(slice) };
        let text = text.trim();
        if readable(text) {
            parts.push(text.to_string());
        }
        index += 8 + len;
    }
    let joined = tidy_lines(&parts.join("\n"));
    if joined.trim().is_empty() {
        return doc_bytes(bytes);
    }
    Ok(joined)
}

fn utf16_slice(bytes: &[u8]) -> String {
    bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .map(|unit| match unit {
            0x0A | 0x0D | 0x0B => '\n',
            0x09 => ' ',
            _ => char::from_u32(unit as u32).filter(|ch| !ch.is_control()).unwrap_or(' '),
        })
        .collect()
}

fn cp1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| match byte {
            b'\n' | b'\r' => '\n',
            b'\t' => ' ',
            0x80 => '€',
            0x82 => '‚',
            0x83 => 'ƒ',
            0x84 => '„',
            0x85 => '…',
            0x86 => '†',
            0x87 => '‡',
            0x88 => 'ˆ',
            0x89 => '‰',
            0x8A => 'Š',
            0x8B => '‹',
            0x8C => 'Œ',
            0x8E => 'Ž',
            0x91 => '‘',
            0x92 => '’',
            0x93 => '“',
            0x94 => '”',
            0x95 => '•',
            0x96 => '–',
            0x97 => '—',
            0x98 => '˜',
            0x99 => '™',
            0x9A => 'š',
            0x9B => '›',
            0x9C => 'œ',
            0x9E => 'ž',
            0x9F => 'Ÿ',
            0x20..=0x7E | 0xA0..=0xFF => byte as char,
            _ => ' ',
        })
        .collect()
}

fn readable(text: &str) -> bool {
    let letters = text.chars().filter(|ch| ch.is_alphanumeric()).count();
    letters >= 2 && letters * 2 >= text.chars().filter(|ch| !ch.is_whitespace()).count()
}

fn doc_bytes(bytes: &[u8]) -> Result<String, String> {
    let utf16 = utf16_text(bytes);
    let latin = latin_text(bytes);
    let best = if letters(&latin) > letters(&utf16) { latin } else { utf16 };
    let text = tidy_lines(&best);
    if text.trim().is_empty() {
        return Err("That document has no readable text.".into());
    }
    Ok(text)
}

fn tagged_text(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let boundary = after.as_bytes().first().copied().unwrap_or(b' ');
        if !matches!(boundary, b'>' | b'/' | b' ' | b'\n' | b'\r' | b'\t') {
            rest = after;
            continue;
        }
        let Some(end_tag) = after.find('>') else { break };
        if after.as_bytes().get(end_tag.saturating_sub(1)) == Some(&b'/') {
            rest = &after[end_tag + 1..];
            continue;
        }
        let body = &after[end_tag + 1..];
        let Some(close_at) = body.find(&close) else { break };
        let piece = decode_xml(&body[..close_at]);
        if !piece.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&piece);
        }
        rest = &body[close_at + close.len()..];
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find(';') {
            if let Some(ch) = entity(&after[..end]) {
                out.push(ch);
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    out
}

fn entity(token: &str) -> Option<char> {
    match token {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "amp" => Some('&'),
        _ => {
            let code = token.strip_prefix("#x").and_then(|hex| u32::from_str_radix(hex, 16).ok()).or_else(|| {
                token.strip_prefix('#').and_then(|digits| digits.parse().ok())
            })?;
            char::from_u32(code).filter(|ch| !ch.is_control() || *ch == '\n' || *ch == '\t')
        }
    }
}

fn tidy_lines(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.chars().filter(|ch| ch.is_alphanumeric()).count() < 2 && !line.is_empty() {
            continue;
        }
        if lines.last().is_some_and(|prev: &String| prev == &line) {
            continue;
        }
        lines.push(line);
        if lines.iter().map(|line| line.len()).sum::<usize>() > 100_000 {
            lines.push("…".into());
            break;
        }
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

fn letters(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_alphanumeric()).count()
}

fn utf16_text(bytes: &[u8]) -> String {
    let even = utf16_at(bytes, 0);
    let odd = utf16_at(bytes, 1);
    if letters(&odd) > letters(&even) { odd } else { even }
}

fn utf16_at(bytes: &[u8], start: usize) -> String {
    let mut out = String::new();
    let mut run = String::new();
    let mut words = 0usize;
    let mut index = start;
    while index + 1 < bytes.len() {
        let unit = u16::from_le_bytes([bytes[index], bytes[index + 1]]);
        if printable(unit) {
            if unit > 127 || char::from_u32(unit as u32).is_some_and(|ch| ch.is_ascii_alphanumeric()) {
                words += 1;
            }
            if let Some(ch) = char::from_u32(unit as u32) {
                run.push(ch);
            }
            index += 2;
            continue;
        }
        if matches!(unit, 0x0A | 0x0D | 0x0B | 0x0C) {
            run.push('\n');
            index += 2;
            continue;
        }
        keep_run(&mut out, &mut run, &mut words);
        index += 2;
    }
    keep_run(&mut out, &mut run, &mut words);
    out
}

fn keep_run(out: &mut String, run: &mut String, words: &mut usize) {
    if *words >= 6 {
        out.push_str(run);
        out.push('\n');
    }
    run.clear();
    *words = 0;
}

fn printable(unit: u16) -> bool {
    matches!(unit, 0x09 | 0x20..=0x7E | 0xA0..=0x24F | 0x2010..=0x2027 | 0x20AC)
}

fn latin_text(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut run = String::new();
    let mut words = 0usize;
    for &byte in bytes {
        if (0x20..=0x7E).contains(&byte) || byte == b'\t' {
            if byte.is_ascii_alphanumeric() {
                words += 1;
            }
            run.push(byte as char);
            continue;
        }
        if byte == b'\n' || byte == b'\r' {
            run.push('\n');
            continue;
        }
        if words >= 12 {
            out.push_str(&run);
            out.push('\n');
        }
        run.clear();
        words = 0;
    }
    if words >= 12 {
        out.push_str(&run);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::text_of;
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

    #[test]
    fn reads_pptx_slide_text_in_order() {
        let bytes = zip_with(&[
            ("ppt/slides/slide2.xml", "<a:p><a:t>Second</a:t></a:p>"),
            ("ppt/slides/slide1.xml", "<a:p><a:t>Hello</a:t><a:t>there</a:t></a:p>"),
            ("ppt/slides/slide10.xml", "<a:p></a:p>"),
        ]);
        let text = text_of("pptx", &bytes).unwrap();
        let first = text.find("Slide 1").unwrap();
        let second = text.find("Slide 2").unwrap();
        assert!(first < second);
        assert!(text.contains("Hello there"));
        assert!(text.contains("Second"));
        assert!(text.contains("Slide 10\n(no text)"));
    }

    #[test]
    fn ignores_tab_stops_when_reading_slide_text() {
        let xml = r#"<a:p><a:pPr><a:tabLst><a:tab pos="0" algn="l"/><a:tab pos="447675" algn="l"/></a:tabLst></a:pPr><a:r><a:t>Revenue Ziel</a:t></a:r></a:p>"#;
        let bytes = zip_with(&[("ppt/slides/slide1.xml", xml)]);
        let text = text_of("pptx", &bytes).unwrap();
        assert!(text.contains("Revenue Ziel"));
        assert!(!text.contains("a:tab"));
        assert!(!text.contains("447675"));
    }

    #[test]
    fn reads_odt_paragraphs() {
        let bytes = zip_with(&[("content.xml", "<office:body><text:p>Hello <text:span>world</text:span></text:p><text:h>Title</text:h></office:body>")]);
        let text = text_of("odt", &bytes).unwrap();
        assert!(text.contains("Hello world"));
        assert!(text.contains("Title"));
    }

    #[test]
    fn reads_ppt_slide_text() {
        let mut bytes = vec![0u8; 12];
        let wide: Vec<u8> = "Business Plan".encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
        bytes.extend([0, 0, 0xA0, 0x0F]);
        bytes.extend((wide.len() as u32).to_le_bytes());
        bytes.extend(&wide);
        bytes.extend([0, 0, 0xA8, 0x0F]);
        bytes.extend((b"Inhaltsverzeichnis".len() as u32).to_le_bytes());
        bytes.extend(b"Inhaltsverzeichnis");
        let text = text_of("ppt", &bytes).unwrap();
        assert!(text.contains("Business Plan"));
        assert!(text.contains("Inhaltsverzeichnis"));
    }

    #[test]
    fn reads_doc_utf16_text() {
        let mut bytes = vec![0u8; 80];
        for unit in "Operating instructions".encode_utf16() {
            bytes.extend(unit.to_le_bytes());
        }
        let text = text_of("doc", &bytes).unwrap();
        assert!(text.contains("Operating instructions"));
    }
}
