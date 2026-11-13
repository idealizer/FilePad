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
            b'\n' | b'\r' | 0x0B => '\n',
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
    let word = crate::slides::ole_stream(bytes, "WordDocument").map_err(|_| "Can't read that document.".to_string())?;
    let flags = word.get(0x0A..0x0C).map(|bytes| u16::from_le_bytes(bytes.try_into().unwrap())).unwrap_or(0);
    let table_name = if flags & 0x0200 != 0 { "1Table" } else { "0Table" };
    let table = crate::slides::ole_stream(bytes, table_name).map_err(|_| "Can't read that document.".to_string())?;
    let text = tidy_lines(&piece_text(&word, &table)?);
    if text.trim().is_empty() {
        return Err("That document has no readable text.".into());
    }
    Ok(text)
}

/// Word 97 piece table. Compressed pieces are Windows-1252; the rest are UTF-16LE.
fn piece_text(word: &[u8], table: &[u8]) -> Result<String, String> {
    let (fc, lcb) = clx_at(word)?;
    let end = fc.checked_add(lcb).ok_or("That document can't be previewed.")?;
    let clx = table.get(fc..end).ok_or("That document can't be previewed.")?;
    let plc = pcdt(clx)?;
    if plc.len() < 4 || (plc.len() - 4) % 12 != 0 {
        return Err("That document can't be previewed.".into());
    }
    let count = (plc.len() - 4) / 12;
    if count > 100_000 {
        return Err("That document can't be previewed.".into());
    }
    let mut cps = Vec::with_capacity(count + 1);
    for index in 0..=count {
        let at = index * 4;
        let cp = u32::from_le_bytes(plc[at..at + 4].try_into().unwrap());
        cps.push(cp.max(cps.last().copied().unwrap_or(0)));
    }
    let mut out = String::new();
    for index in 0..count {
        if out.len() > 200_000 {
            break;
        }
        let at = (count + 1) * 4 + index * 8 + 2;
        let fc_raw = u32::from_le_bytes(plc[at..at + 4].try_into().unwrap());
        let chars = cps[index + 1].saturating_sub(cps[index]) as usize;
        let compressed = fc_raw & 0x4000_0000 != 0;
        let start = (fc_raw & 0x3FFF_FFFF) as usize;
        if compressed {
            out.push_str(&cp1252(slice_at(word, start / 2, chars)));
        } else {
            out.push_str(&utf16_slice(slice_at(word, start, chars.saturating_mul(2))));
        }
    }
    Ok(out)
}

fn slice_at(bytes: &[u8], at: usize, len: usize) -> &[u8] {
    bytes.get(at..).map(|rest| &rest[..len.min(rest.len())]).unwrap_or_default()
}

fn clx_at(word: &[u8]) -> Result<(usize, usize), String> {
    let ident = word.get(..2).map(|bytes| u16::from_le_bytes(bytes.try_into().unwrap())).unwrap_or(0);
    if ident != 0xA5EC || word.len() < 0x9A {
        return Err("That document can't be previewed.".into());
    }
    let csw = u16::from_le_bytes(word[0x20..0x22].try_into().unwrap());
    let cslw = u16::from_le_bytes(word[0x3E..0x40].try_into().unwrap());
    if csw != 0x000E || cslw != 0x0016 {
        return Err("That document can't be previewed.".into());
    }
    let pairs = u16::from_le_bytes(word[0x98..0x9A].try_into().unwrap()) as usize;
    if pairs <= 33 {
        return Err("That document can't be previewed.".into());
    }
    let at = 0x9A + 33 * 8;
    let spot = word.get(at..at + 8).ok_or("That document can't be previewed.")?;
    let fc = u32::from_le_bytes(spot[..4].try_into().unwrap()) as usize;
    let lcb = u32::from_le_bytes(spot[4..].try_into().unwrap()) as usize;
    if lcb == 0 {
        return Err("That document can't be previewed.".into());
    }
    Ok((fc, lcb))
}

fn pcdt(clx: &[u8]) -> Result<&[u8], String> {
    let mut index = 0;
    while index < clx.len() {
        match clx[index] {
            0x01 => {
                let cb = clx.get(index + 1..index + 3).map(|bytes| u16::from_le_bytes(bytes.try_into().unwrap()) as usize).ok_or("That document can't be previewed.")?;
                index = index.checked_add(3 + cb).ok_or("That document can't be previewed.")?;
            }
            0x02 => {
                let lcb = clx.get(index + 1..index + 5).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as usize).ok_or("That document can't be previewed.")?;
                let start = index.checked_add(5).ok_or("That document can't be previewed.")?;
                let end = start.checked_add(lcb).ok_or("That document can't be previewed.")?;
                return clx.get(start..end).ok_or("That document can't be previewed.".into());
            }
            _ => return Err("That document can't be previewed.".into()),
        }
    }
    Err("That document can't be previewed.".into())
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
    fn reads_doc_cp1252_umlauts() {
        let text_bytes = b"Gr\xf6\xdfe \xe4\xf6\xfc";
        let (word, table) = word_with_piece(text_bytes, true);
        let plain = super::piece_text(&word, &table).unwrap();
        assert!(plain.contains("Größe"));
        assert!(plain.contains('ä'));
        assert!(plain.contains('ö'));
        assert!(plain.contains('ü'));
        let packed = pack_ole(&word, &table);
        let text = text_of("doc", &packed).unwrap();
        assert!(text.contains("Größe"));
        assert!(text.contains('ä'));
        assert!(text.contains('ö'));
        assert!(text.contains('ü'));
    }

    fn word_with_piece(payload: &[u8], compressed: bool) -> (Vec<u8>, Vec<u8>) {
        let mut word = vec![0u8; 4096];
        word[..2].copy_from_slice(&0xA5ECu16.to_le_bytes());
        word[0x20..0x22].copy_from_slice(&0x000Eu16.to_le_bytes());
        word[0x3E..0x40].copy_from_slice(&0x0016u16.to_le_bytes());
        word[0x98..0x9A].copy_from_slice(&34u16.to_le_bytes());
        let chars = if compressed { payload.len() } else { payload.len() / 2 };
        let mut plc = Vec::new();
        plc.extend(0u32.to_le_bytes());
        plc.extend((chars as u32).to_le_bytes());
        plc.extend(0u16.to_le_bytes());
        let fc = if compressed { (1024u32 * 2) | 0x4000_0000 } else { 1024 };
        plc.extend(fc.to_le_bytes());
        plc.extend(0u16.to_le_bytes());
        let mut table = vec![0x02];
        table.extend((plc.len() as u32).to_le_bytes());
        table.extend(plc);
        let at = 0x9A + 33 * 8;
        word[at..at + 4].copy_from_slice(&0u32.to_le_bytes());
        word[at + 4..at + 8].copy_from_slice(&(table.len() as u32).to_le_bytes());
        word[1024..1024 + payload.len()].copy_from_slice(payload);
        (word, table)
    }

    fn pack_ole(word: &[u8], table: &[u8]) -> Vec<u8> {
        let sector = 512usize;
        let word_sectors = word.len().div_ceil(sector);
        let mini_id = 2 + word_sectors as u32;
        let minifat_id = mini_id + 1;
        let mut file = vec![0u8; sector * (minifat_id as usize + 2)];
        file[..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        file[0x18..0x1A].copy_from_slice(&0x003Eu16.to_le_bytes());
        file[0x1A..0x1C].copy_from_slice(&3u16.to_le_bytes());
        file[0x1C..0x1E].copy_from_slice(&0xFFFEu16.to_le_bytes());
        file[0x1E..0x20].copy_from_slice(&9u16.to_le_bytes());
        file[0x20..0x22].copy_from_slice(&6u16.to_le_bytes());
        file[0x2C..0x30].copy_from_slice(&1u32.to_le_bytes());
        file[0x30..0x34].copy_from_slice(&1u32.to_le_bytes());
        file[0x38..0x3C].copy_from_slice(&4096u32.to_le_bytes());
        file[0x3C..0x40].copy_from_slice(&minifat_id.to_le_bytes());
        file[0x40..0x44].copy_from_slice(&1u32.to_le_bytes());
        file[0x44..0x48].copy_from_slice(&0xFFFFFFFEu32.to_le_bytes());
        file[0x4C..0x50].copy_from_slice(&0u32.to_le_bytes());
        let mut fat = vec![0xFFFFFFFFu32; sector / 4];
        fat[0] = 0xFFFFFFFD;
        fat[1] = 0xFFFFFFFE;
        for index in 0..word_sectors {
            let here = 2 + index;
            fat[here] = if index + 1 == word_sectors { 0xFFFFFFFE } else { (here as u32) + 1 };
        }
        fat[mini_id as usize] = 0xFFFFFFFE;
        fat[minifat_id as usize] = 0xFFFFFFFE;
        for (index, value) in fat.iter().enumerate() {
            file[sector + index * 4..sector + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        let word_at = sector * (1 + 2);
        file[word_at..word_at + word.len()].copy_from_slice(word);
        let mini_at = sector * (1 + mini_id as usize);
        file[mini_at..mini_at + table.len()].copy_from_slice(table);
        let minifat_at = sector * (1 + minifat_id as usize);
        file[minifat_at..minifat_at + 4].copy_from_slice(&0xFFFFFFFEu32.to_le_bytes());
        let dir_at = sector * 2;
        ole_entry(&mut file[dir_at..], 0, "Root Entry", 5, mini_id, 64);
        ole_entry(&mut file[dir_at..], 1, "WordDocument", 2, 2, word.len() as u64);
        ole_entry(&mut file[dir_at..], 2, "0Table", 2, 0, table.len() as u64);
        file
    }

    fn ole_entry(dir: &mut [u8], index: usize, name: &str, kind: u8, start: u32, size: u64) {
        let entry = &mut dir[index * 128..(index + 1) * 128];
        let mut units: Vec<u16> = name.encode_utf16().collect();
        units.push(0);
        for (offset, unit) in units.iter().enumerate() {
            entry[offset * 2..offset * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        entry[64..66].copy_from_slice(&((units.len() * 2) as u16).to_le_bytes());
        entry[66] = kind;
        entry[116..120].copy_from_slice(&start.to_le_bytes());
        entry[120..124].copy_from_slice(&(size as u32).to_le_bytes());
    }
}
