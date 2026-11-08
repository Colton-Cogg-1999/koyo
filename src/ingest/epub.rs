use super::html::{self, CssHints, WalkContext};
use super::{first_heading, image_extension, percent_decode, resolve_zip_path, ParsedBook, RawSection, RawToc};
use anyhow::{anyhow, bail, Context, Result};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

/// Archive entries are attacker-controlled, so a decompression cap guards against zip bombs.
const MAX_ENTRY: u64 = 256 * 1024 * 1024;

struct Book {
    zip: zip::ZipArchive<File>,
}

impl Book {
    fn bytes(&mut self, name: &str) -> Option<Vec<u8>> {
        let entry = self.zip.by_name(name).ok()?;
        let mut out = Vec::new();
        entry.take(MAX_ENTRY).read_to_end(&mut out).ok()?;
        Some(out)
    }

    fn text(&mut self, name: &str) -> Option<String> {
        self.bytes(name).map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').to_string())
    }
}

fn xml(source: &str) -> Result<roxmltree::Document<'_>> {
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    roxmltree::Document::parse_with_options(source, options).map_err(|e| anyhow!("invalid XML: {e}"))
}

fn local<'a>(node: &roxmltree::Node<'a, '_>) -> &'a str {
    node.tag_name().name()
}

fn check_drm(book: &mut Book) -> Result<()> {
    if book.zip.by_name("META-INF/rights.xml").is_ok() {
        bail!("This book is DRM-protected, so it can't be opened.");
    }
    if let Some(enc) = book.text("META-INF/encryption.xml") {
        const FONT_ONLY: &[&str] = &["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];
        if let Ok(doc) = xml(&enc) {
            let locked = doc
                .descendants()
                .filter(|n| local(n) == "EncryptionMethod")
                .filter_map(|n| n.attribute("Algorithm"))
                .any(|alg| !FONT_ONLY.contains(&alg));
            if locked {
                bail!("This book is DRM-protected, so it can't be opened.");
            }
        }
    }
    Ok(())
}

struct NavEntry {
    level: u32,
    title: String,
    href: String,
}

fn parse_nav(source: &str, base: &str) -> Vec<NavEntry> {
    let doc = scraper::Html::parse_document(&html::expand_self_closed(source));
    let Ok(nav) = scraper::Selector::parse("nav") else { return Vec::new() };
    let target = doc
        .select(&nav)
        .find(|n| n.value().attr("epub:type").is_some_and(|t| t.contains("toc")) || n.value().attr("role") == Some("doc-toc"))
        .or_else(|| doc.select(&nav).next());
    let mut entries = Vec::new();
    fn walk(node: ego_tree::NodeRef<'_, scraper::Node>, level: u32, base: &str, out: &mut Vec<NavEntry>) {
        for child in node.children() {
            let Some(el) = scraper::ElementRef::wrap(child) else { continue };
            match el.value().name() {
                "li" => {
                    for part in child.children() {
                        let Some(item) = scraper::ElementRef::wrap(part) else { continue };
                        match item.value().name() {
                            "a" | "span" => {
                                let title = item.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
                                if let (Some(href), false) = (item.value().attr("href"), title.is_empty()) {
                                    out.push(NavEntry { level, title, href: resolve_href(base, href) });
                                }
                            }
                            "ol" | "ul" => walk(part, level + 1, base, out),
                            _ => {}
                        }
                    }
                }
                _ => walk(child, level, base, out),
            }
        }
    }
    if let Some(nav) = target {
        walk(*nav, 1, base, &mut entries);
    }
    entries
}

fn parse_ncx(source: &str, base: &str) -> Vec<NavEntry> {
    let Ok(doc) = xml(source) else { return Vec::new() };
    let mut entries = Vec::new();
    fn walk(node: roxmltree::Node, level: u32, base: &str, out: &mut Vec<NavEntry>) {
        for point in node.children().filter(|n| local(n) == "navPoint") {
            let title = point
                .descendants()
                .find(|n| local(n) == "text")
                .and_then(|n| n.text())
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let src = point.children().find(|n| local(n) == "content").and_then(|n| n.attribute("src"));
            if let (Some(src), false) = (src, title.is_empty()) {
                out.push(NavEntry { level, title, href: resolve_href(base, src) });
            }
            walk(point, level + 1, base, out);
        }
    }
    if let Some(map) = doc.descendants().find(|n| local(n) == "navMap") {
        walk(map, 1, base, &mut entries);
    }
    entries
}

fn resolve_href(base: &str, href: &str) -> String {
    let (path, frag) = href.split_once('#').unwrap_or((href, ""));
    let resolved = if path.is_empty() { base.to_string() } else { resolve_zip_path(base, path) };
    if frag.is_empty() { resolved } else { format!("{resolved}#{}", percent_decode(frag)) }
}

pub fn parse(path: &Path, book_id: &str, book_dir: &Path) -> Result<ParsedBook> {
    let file = File::open(path)?;
    let zip = zip::ZipArchive::new(file).map_err(|_| anyhow!("This EPUB is damaged: it isn't a readable archive."))?;
    let mut book = Book { zip };
    check_drm(&mut book)?;

    let container = book.text("META-INF/container.xml").context("This EPUB is damaged: container.xml is missing.")?;
    let opf_path = {
        let doc = xml(&container)?;
        doc.descendants()
            .find(|n| local(n) == "rootfile")
            .and_then(|n| n.attribute("full-path"))
            .context("This EPUB is damaged: no package file is listed.")?
            .to_string()
    };
    let opf_text = book.text(&opf_path).context("This EPUB is damaged: the package file is missing.")?;
    let opf = xml(&opf_text)?;

    let meta = |name: &str| {
        opf.descendants()
            .find(|n| n.is_element() && local(n) == name && n.tag_name().namespace().is_some_and(|ns| ns.contains("dc/elements")))
            .and_then(|n| n.text())
            .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    };
    let mut parsed = ParsedBook {
        title: tidy_title(&meta("title")),
        author: Some(meta("creator")).filter(|a| !a.is_empty()).unwrap_or_else(|| meta("contributor")),
        language: meta("language"),
        description: html::strip_tags(&meta("description")),
        ..Default::default()
    };

    struct Item {
        href: String,
        media: String,
        properties: String,
    }
    let mut manifest: HashMap<String, Item> = HashMap::new();
    for node in opf.descendants().filter(|n| local(n) == "item") {
        if let (Some(id), Some(href)) = (node.attribute("id"), node.attribute("href")) {
            manifest.insert(
                id.to_string(),
                Item {
                    href: resolve_zip_path(&opf_path, href),
                    media: node.attribute("media-type").unwrap_or("").to_string(),
                    properties: node.attribute("properties").unwrap_or("").to_string(),
                },
            );
        }
    }
    let spine: Vec<String> = opf
        .descendants()
        .filter(|n| local(n) == "itemref")
        .filter_map(|n| n.attribute("idref"))
        .filter_map(|id| manifest.get(id))
        .filter(|item| item.media.contains("html") || item.href.ends_with("html") || item.href.ends_with("htm"))
        .map(|item| item.href.clone())
        .collect();
    if spine.is_empty() {
        bail!("This EPUB is damaged: it has no readable chapters.");
    }

    let cover_id = opf
        .descendants()
        .find(|n| local(n) == "meta" && n.attribute("name") == Some("cover"))
        .and_then(|n| n.attribute("content"));
    let cover_path = manifest
        .values()
        .find(|i| i.properties.split_whitespace().any(|p| p == "cover-image"))
        .or_else(|| cover_id.and_then(|id| manifest.get(id)))
        .or_else(|| manifest.values().find(|i| i.media.starts_with("image/") && i.href.to_ascii_lowercase().contains("cover")))
        .filter(|i| i.media.starts_with("image/") && !i.media.contains("svg"))
        .map(|i| i.href.clone());
    if let Some(cover) = cover_path {
        if let (Some(bytes), Some(ext)) = (book.bytes(&cover), image_extension(&cover)) {
            parsed.cover = Some((bytes, ext.to_string()));
        }
    }

    let mut hints = CssHints::default();
    let stylesheets: Vec<String> = manifest.values().filter(|i| i.media == "text/css").map(|i| i.href.clone()).collect();
    for sheet in stylesheets {
        if let Some(css) = book.text(&sheet) {
            hints.absorb(&css);
        }
    }

    let nav_path = manifest.values().find(|i| i.properties.split_whitespace().any(|p| p == "nav")).map(|i| i.href.clone());
    let ncx_path = manifest.values().find(|i| i.media.contains("dtbncx") || i.href.ends_with(".ncx")).map(|i| i.href.clone());
    let mut nav = nav_path.as_ref().and_then(|p| book.text(p).map(|t| parse_nav(&t, p))).unwrap_or_default();
    if nav.is_empty() {
        nav = ncx_path.as_ref().and_then(|p| book.text(p).map(|t| parse_ncx(&t, p))).unwrap_or_default();
    }

    let book_cell = RefCell::new(&mut book);
    let assets = book_dir.join("assets");
    let mut image_names: HashMap<String, String> = HashMap::new();
    let mut links: Vec<String> = Vec::new();
    let mut anchors: HashMap<String, HashMap<String, u32>> = HashMap::new();
    let mut first_block: HashMap<String, u32> = HashMap::new();
    let mut next_seq = 0u32;

    for doc_path in &spine {
        let Some(source) = book_cell.borrow_mut().text(doc_path) else { continue };
        for style in extract_inline_styles(&source) {
            hints.absorb(&style);
        }
        let mut image = |src: &str| -> Option<String> {
            if src.starts_with("data:") || src.contains("://") {
                return None;
            }
            let target = resolve_zip_path(doc_path, src);
            if let Some(name) = image_names.get(&target) {
                return Some(format!("/api/books/{book_id}/assets/{name}"));
            }
            let ext = image_extension(&target)?;
            let bytes = book_cell.borrow_mut().bytes(&target)?;
            let name = format!("{}.{ext}", image_names.len());
            fs::write(assets.join(&name), bytes).ok()?;
            image_names.insert(target, name.clone());
            Some(format!("/api/books/{book_id}/assets/{name}"))
        };
        let mut link = |href: &str| -> Option<String> {
            let lower = href.to_ascii_lowercase();
            if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
                return Some(href.to_string());
            }
            if lower.contains(':') {
                return None;
            }
            links.push(resolve_href(doc_path, href));
            Some(format!("oma:{}", links.len() - 1))
        };
        let hints_now = hints.clone();
        let mut cx = WalkContext { hints: &hints_now, image: &mut image, link: &mut link };
        let out = html::walk(&source, next_seq, &mut cx);
        if parsed.language.is_empty() {
            parsed.language = out.lang.clone().unwrap_or_default();
        }
        first_block.insert(doc_path.clone(), next_seq);
        let added = out.blocks.len() as u32;
        anchors.insert(doc_path.clone(), out.anchors);
        // Text-free pages are cover wrappers or plates. They can't hold a position,
        // so a plate joins the section before it, and a leading cover wrapper goes.
        if added == 0 {
            if let Some(previous) = parsed.sections.last_mut() {
                previous.html.push_str(&out.html);
            }
            continue;
        }
        let section = parsed.sections.len() as u32;
        let title = first_heading(&out.blocks).unwrap_or_default();
        parsed.sections.push(RawSection {
            title,
            html: out.html,
            first_block: next_seq,
            last_block: (next_seq + added).saturating_sub(1).max(next_seq),
        });
        parsed.blocks.extend(out.blocks.into_iter().map(|mut b| {
            b.section = section;
            b
        }));
        next_seq += added;
    }
    if next_seq == 0 {
        bail!("This EPUB has no text that Kōyō can read.");
    }

    let locate = |href: &str| -> Option<u32> {
        let (path, frag) = href.split_once('#').unwrap_or((href, ""));
        if !frag.is_empty() {
            if let Some(block) = anchors.get(path).and_then(|a| a.get(frag)) {
                return Some(*block);
            }
        }
        first_block.get(path).copied()
    };
    for section in &mut parsed.sections {
        section.html = super::assign_links(&section.html, &|n| links.get(n).and_then(|h| locate(h)));
    }
    let last = next_seq - 1;
    for entry in nav {
        if let Some(block) = locate(&entry.href) {
            parsed.toc.push(RawToc { level: entry.level, title: entry.title, block: block.min(last), page: 0 });
        }
    }
    parsed.toc.sort_by_key(|t| t.block);
    if parsed.toc.len() < 2 {
        parsed.toc = super::outline_from_blocks(&parsed.blocks);
    }
    for section in &mut parsed.sections {
        if let Some(entry) = parsed.toc.iter().rev().find(|t| t.block <= section.first_block) {
            if section.title.is_empty() || parsed.toc.iter().any(|t| t.block == section.first_block) {
                section.title = entry.title.clone();
            }
        }
    }
    if parsed.title.is_empty() {
        parsed.title = super::pretty_stem(&path.file_name().unwrap_or_default().to_string_lossy());
    }
    Ok(parsed)
}

/// Catalog records pack subtitles into the title. A shelf needs the name of the book.
fn tidy_title(title: &str) -> String {
    let main = title.split(" / ").next().unwrap_or(title);
    let main = main.split_once("; Or,").or(main.split_once("; or,")).map(|(head, _)| head).unwrap_or(main);
    main.trim().to_string()
}

fn extract_inline_styles(source: &str) -> Vec<String> {
    let mut styles = Vec::new();
    let mut rest = source;
    while let Some(start) = rest.find("<style") {
        let Some(open) = rest[start..].find('>') else { break };
        let body = &rest[start + open + 1..];
        let Some(end) = body.find("</style") else { break };
        styles.push(body[..end].to_string());
        rest = &body[end..];
    }
    styles
}
