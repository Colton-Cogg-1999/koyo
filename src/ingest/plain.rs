use super::html::{self, escape, CssHints, WalkContext};
use super::{image_extension, outline_from_blocks, pretty_stem, resolve_zip_path, ParsedBook, RawSection};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Some(body) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

fn single_document(source: &str, mut parsed: ParsedBook, hints: &CssHints, book_id: Option<&str>) -> ParsedBook {
    let mut image = |src: &str| -> Option<String> {
        book_id.filter(|_| src.starts_with("asset:")).map(|id| format!("/api/books/{id}/assets/{}", &src[6..]))
    };
    let mut link = |href: &str| -> Option<String> {
        let lower = href.to_ascii_lowercase();
        (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")).then(|| href.to_string())
    };
    let mut cx = WalkContext { hints, image: &mut image, link: &mut link };
    let out = html::walk(source, 0, &mut cx);
    if parsed.language.is_empty() {
        parsed.language = out.lang.unwrap_or_default();
    }
    let last = out.blocks.len().saturating_sub(1) as u32;
    parsed.toc = outline_from_blocks(&out.blocks);
    parsed.sections = vec![RawSection { title: String::new(), html: out.html, first_block: 0, last_block: last }];
    parsed.blocks = out.blocks;
    parsed
}

static GUTENBERG_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*$").unwrap());
static GUTENBERG_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG.*$").unwrap());
static TEXT_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(chapter|book|part|section|canto|act)\s+([\divxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b.{0,60}$|^(prologue|epilogue|introduction|preface|foreword|afterword)\b.{0,40}$").unwrap()
});

pub fn parse_text(path: &Path, file_name: &str) -> Result<ParsedBook> {
    let raw = decode(&fs::read(path)?).replace("\r\n", "\n");
    let mut body = raw.as_str();
    let mut title = pretty_stem(file_name);
    let mut author = String::new();
    if let Some(start) = GUTENBERG_START.find(body) {
        for line in body[..start.start()].lines() {
            if let Some(value) = line.strip_prefix("Title:") {
                title = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("Author:") {
                author = value.trim().to_string();
            }
        }
        body = &body[start.end()..];
    }
    if let Some(end) = GUTENBERG_END.find(body) {
        body = &body[..end.start()];
    }
    let mut html_out = String::from("<body>");
    let blank_separated = body.contains("\n\n");
    let paragraphs: Vec<&str> = if blank_separated { body.split("\n\n").collect() } else { body.lines().collect() };
    for para in paragraphs {
        let line = para.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        let tag = if TEXT_HEADING.is_match(&line) { "h2" } else { "p" };
        html_out.push_str(&format!("<{tag}>{}</{tag}>", escape(&line)));
    }
    html_out.push_str("</body>");
    let parsed = ParsedBook { title, author, ..Default::default() };
    let parsed = single_document(&html_out, parsed, &CssHints::default(), None);
    non_empty(parsed)
}

fn non_empty(parsed: ParsedBook) -> Result<ParsedBook> {
    if parsed.blocks.is_empty() {
        return Err(anyhow!("This file has no readable text."));
    }
    Ok(parsed)
}

pub fn parse_markdown(path: &Path, file_name: &str) -> Result<ParsedBook> {
    let raw = decode(&fs::read(path)?).replace("\r\n", "\n");
    let mut title = pretty_stem(file_name);
    let mut author = String::new();
    let mut body = raw.as_str();
    if let Some(rest) = body.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((key, value)) = line.split_once(':') {
                    let value = value.trim().trim_matches(['"', '\'']).to_string();
                    match key.trim().to_ascii_lowercase().as_str() {
                        "title" if !value.is_empty() => title = value,
                        "author" => author = value,
                        _ => {}
                    }
                }
            }
            body = rest[end + 4..].trim_start_matches(['-', '\n']);
        }
    }
    let parser = pulldown_cmark::Parser::new_ext(body, pulldown_cmark::Options::ENABLE_TABLES | pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
    let mut rendered = String::new();
    pulldown_cmark::html::push_html(&mut rendered, parser);
    let source = format!("<body>{rendered}</body>");
    non_empty(single_document(&source, ParsedBook { title, author, ..Default::default() }, &CssHints::default(), None))
}

pub fn parse_html(path: &Path, file_name: &str) -> Result<ParsedBook> {
    let source = decode(&fs::read(path)?);
    let doc = scraper::Html::parse_document(&html::expand_self_closed(&source));
    let select = |query: &str| scraper::Selector::parse(query).ok();
    let title = select("title")
        .and_then(|s| doc.select(&s).next())
        .map(|t| t.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| pretty_stem(file_name));
    let author = select("meta[name=author]")
        .and_then(|s| doc.select(&s).next())
        .and_then(|m| m.value().attr("content"))
        .unwrap_or("")
        .to_string();
    let mut hints = CssHints::default();
    if let Some(style) = select("style") {
        for sheet in doc.select(&style) {
            hints.absorb(&sheet.text().collect::<String>());
        }
    }
    non_empty(single_document(&source, ParsedBook { title, author, ..Default::default() }, &hints, None))
}

const WORD_NS: &str = "wordprocessingml";

fn word_val<'a>(node: &roxmltree::Node<'a, '_>) -> Option<&'a str> {
    node.attributes().find(|a| a.name() == "val").map(|a| a.value())
}

fn docx_runs(paragraph: roxmltree::Node, images: &HashMap<String, String>) -> String {
    let mut out = String::new();
    for run in paragraph.descendants().filter(|n| n.tag_name().name() == "r" && n.tag_name().namespace().is_some_and(|ns| ns.contains(WORD_NS))) {
        let props = run.children().find(|n| n.tag_name().name() == "rPr");
        let on = |name: &str| {
            props.and_then(|p| p.children().find(|n| n.tag_name().name() == name)).is_some_and(|n| !matches!(word_val(&n), Some("0" | "false")))
        };
        let (bold, italic) = (on("b"), on("i"));
        let mut text = String::new();
        for child in run.children() {
            match child.tag_name().name() {
                "t" => text.push_str(&escape(child.text().unwrap_or(""))),
                "tab" => text.push(' '),
                "br" => text.push_str("<br>"),
                "drawing" | "pict" => {
                    for blip in child.descendants().filter(|n| n.tag_name().name() == "blip") {
                        let rel = blip.attributes().find(|a| a.name() == "embed").map(|a| a.value());
                        if let Some(name) = rel.and_then(|r| images.get(r)) {
                            text.push_str(&format!("<img src=\"asset:{name}\">"));
                        }
                    }
                }
                _ => {}
            }
        }
        if text.is_empty() {
            continue;
        }
        if italic {
            text = format!("<em>{text}</em>");
        }
        if bold {
            text = format!("<strong>{text}</strong>");
        }
        out.push_str(&text);
    }
    out
}

pub fn parse_docx(path: &Path, file_name: &str, book_id: &str, book_dir: &Path) -> Result<ParsedBook> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path)?).map_err(|_| anyhow!("This Word file is damaged."))?;
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let entry = zip.by_name(name).ok()?;
        let mut out = Vec::new();
        entry.take(256 * 1024 * 1024).read_to_end(&mut out).ok()?;
        Some(out)
    };
    let document = read("word/document.xml").context("This Word file has no document body.")?;
    let document = String::from_utf8_lossy(&document).into_owned();
    let mut images: HashMap<String, String> = HashMap::new();
    if let Some(rels) = read("word/_rels/document.xml.rels") {
        let rels = String::from_utf8_lossy(&rels).into_owned();
        if let Ok(doc) = roxmltree::Document::parse(&rels) {
            for rel in doc.descendants().filter(|n| n.tag_name().name() == "Relationship") {
                let (Some(id), Some(target)) = (rel.attribute("Id"), rel.attribute("Target")) else { continue };
                let Some(ext) = image_extension(target) else { continue };
                let Some(bytes) = read(&resolve_zip_path("word/document.xml", target)) else { continue };
                let name = format!("{}.{ext}", images.len());
                fs::write(book_dir.join("assets").join(&name), bytes)?;
                images.insert(id.to_string(), name);
            }
        }
    }
    let mut title = pretty_stem(file_name);
    let mut author = String::new();
    if let Some(core) = read("docProps/core.xml") {
        let core = String::from_utf8_lossy(&core).into_owned();
        if let Ok(doc) = roxmltree::Document::parse(&core) {
            let field = |name: &str| doc.descendants().find(|n| n.tag_name().name() == name).and_then(|n| n.text()).map(str::trim).filter(|t| !t.is_empty());
            if let Some(value) = field("title") {
                title = value.to_string();
            }
            if let Some(value) = field("creator") {
                author = value.to_string();
            }
        }
    }
    let doc = roxmltree::Document::parse(&document).map_err(|_| anyhow!("This Word file is damaged."))?;
    let body = doc.descendants().find(|n| n.tag_name().name() == "body").context("This Word file has no document body.")?;
    let mut out = String::from("<body>");
    for child in body.children() {
        match child.tag_name().name() {
            "p" => {
                let inner = docx_runs(child, &images);
                if inner.is_empty() {
                    continue;
                }
                let props = child.children().find(|n| n.tag_name().name() == "pPr");
                let style = props.and_then(|p| p.children().find(|n| n.tag_name().name() == "pStyle")).and_then(|n| word_val(&n)).unwrap_or("").to_ascii_lowercase();
                let list = props.is_some_and(|p| p.children().any(|n| n.tag_name().name() == "numPr"));
                let tag = match style.strip_prefix("heading").and_then(|n| n.trim().parse::<u8>().ok()) {
                    Some(level) if (1..=6).contains(&level) => format!("h{level}"),
                    _ if style == "title" => "h1".to_string(),
                    _ if list => "li".to_string(),
                    _ => "p".to_string(),
                };
                out.push_str(&format!("<{tag}>{inner}</{tag}>"));
            }
            "tbl" => {
                out.push_str("<table>");
                for row in child.children().filter(|n| n.tag_name().name() == "tr") {
                    out.push_str("<tr>");
                    for cell in row.children().filter(|n| n.tag_name().name() == "tc") {
                        out.push_str(&format!("<td>{}</td>", docx_runs(cell, &images)));
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</table>");
            }
            _ => {}
        }
    }
    out.push_str("</body>");
    non_empty(single_document(&out, ParsedBook { title, author, ..Default::default() }, &CssHints::default(), Some(book_id)))
}

fn fb2_inline(node: roxmltree::Node) -> String {
    let mut out = String::new();
    for child in node.children() {
        if child.is_text() {
            out.push_str(&escape(child.text().unwrap_or("")));
        } else if child.is_element() {
            match child.tag_name().name() {
                "emphasis" => out.push_str(&format!("<em>{}</em>", fb2_inline(child))),
                "strong" => out.push_str(&format!("<strong>{}</strong>", fb2_inline(child))),
                "strikethrough" => out.push_str(&format!("<s>{}</s>", fb2_inline(child))),
                "sup" => out.push_str(&format!("<sup>{}</sup>", fb2_inline(child))),
                "sub" => out.push_str(&format!("<sub>{}</sub>", fb2_inline(child))),
                "code" => out.push_str(&format!("<code>{}</code>", fb2_inline(child))),
                _ => out.push_str(&fb2_inline(child)),
            }
        }
    }
    out
}

fn fb2_section(node: roxmltree::Node, depth: u32, images: &HashMap<String, String>, out: &mut String) {
    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "title" => {
                let level = (depth + 1).min(6);
                let text: Vec<String> = child.children().filter(|n| n.is_element()).map(fb2_inline).collect();
                out.push_str(&format!("<h{level}>{}</h{level}>", text.join(" ")));
            }
            "section" => fb2_section(child, depth + 1, images, out),
            "p" => out.push_str(&format!("<p>{}</p>", fb2_inline(child))),
            "subtitle" => out.push_str(&format!("<h{level}>{}</h{level}>", fb2_inline(child), level = (depth + 2).min(6))),
            "empty-line" => {}
            "cite" | "epigraph" => {
                out.push_str("<blockquote>");
                fb2_section(child, depth, images, out);
                out.push_str("</blockquote>");
            }
            "poem" | "stanza" => fb2_section(child, depth, images, out),
            "v" => out.push_str(&format!("<p>{}</p>", fb2_inline(child))),
            "text-author" => out.push_str(&format!("<p data-a=\"r\">{}</p>", fb2_inline(child))),
            "image" => {
                let href = child.attributes().find(|a| a.name() == "href").map(|a| a.value().trim_start_matches('#'));
                if let Some(name) = href.and_then(|h| images.get(h)) {
                    out.push_str(&format!("<p><img src=\"asset:{name}\"></p>"));
                }
            }
            _ => {}
        }
    }
}

pub fn parse_fb2(path: &Path, file_name: &str, book_id: &str, book_dir: &Path) -> Result<ParsedBook> {
    let source = decode(&fs::read(path)?);
    let doc = roxmltree::Document::parse_with_options(
        &source,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    )
    .map_err(|_| anyhow!("This FB2 file is damaged."))?;
    let info = doc.descendants().find(|n| n.tag_name().name() == "title-info");
    let text_of = |parent: Option<roxmltree::Node>, name: &str| {
        parent.and_then(|p| p.children().find(|n| n.tag_name().name() == name)).and_then(|n| n.text()).map(|t| t.trim().to_string()).unwrap_or_default()
    };
    let title = Some(text_of(info, "book-title")).filter(|t| !t.is_empty()).unwrap_or_else(|| pretty_stem(file_name));
    let author_node = info.and_then(|i| i.children().find(|n| n.tag_name().name() == "author"));
    let author = ["first-name", "middle-name", "last-name"].map(|f| text_of(author_node, f)).into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let language = text_of(info, "lang");
    let description = info
        .and_then(|i| i.children().find(|n| n.tag_name().name() == "annotation"))
        .map(|n| n.descendants().filter_map(|d| d.text()).collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();

    let mut images: HashMap<String, String> = HashMap::new();
    let mut cover = None;
    let cover_ref = info
        .and_then(|i| i.descendants().find(|n| n.tag_name().name() == "coverpage"))
        .and_then(|c| c.descendants().find(|n| n.tag_name().name() == "image"))
        .and_then(|i| i.attributes().find(|a| a.name() == "href").map(|a| a.value().trim_start_matches('#').to_string()));
    for binary in doc.descendants().filter(|n| n.tag_name().name() == "binary") {
        let (Some(id), Some(data)) = (binary.attribute("id"), binary.text()) else { continue };
        let Some(ext) = image_extension(id).or(match binary.attribute("content-type") {
            Some("image/png") => Some("png"),
            Some("image/jpeg") => Some("jpg"),
            _ => None,
        }) else { continue };
        let Some(bytes) = base64(data) else { continue };
        let name = format!("{}.{ext}", images.len());
        fs::write(book_dir.join("assets").join(&name), &bytes)?;
        if cover_ref.as_deref() == Some(id) {
            cover = Some((bytes, ext.to_string()));
        }
        images.insert(id.to_string(), name);
    }

    let mut out = String::from("<body>");
    for body in doc.descendants().filter(|n| n.tag_name().name() == "body" && n.attribute("name") != Some("notes")) {
        fb2_section(body, 0, &images, &mut out);
    }
    out.push_str("</body>");
    let parsed = ParsedBook { title, author, language, description, cover, ..Default::default() };
    non_empty(single_document(&out, parsed, &CssHints::default(), Some(book_id)))
}

fn base64(data: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in data.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}
