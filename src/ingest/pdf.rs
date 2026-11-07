//! PDFs are displayed from the original file by pdf.js. Poppler's layout analysis supplies
//! the text, and every paragraph keeps its page rectangle, so citations and read-along can
//! point at the right place on the rendered page.

use super::{pretty_stem, ParsedBook, RawBlock, RawSection, RawToc};
use anyhow::{anyhow, bail, Result};
use quick_xml::events::{BytesStart, Event};
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;

#[derive(Default, Clone)]
struct Word {
    x0: f64,
    x1: f64,
    text: String,
}

#[derive(Default, Clone)]
struct Line {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    words: Vec<Word>,
}

impl Line {
    fn text(&self) -> String {
        self.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
    }
    fn height(&self) -> f64 {
        (self.y1 - self.y0).max(1.0)
    }
}

#[derive(Default)]
struct Page {
    width: f64,
    height: f64,
    blocks: Vec<Vec<Line>>,
}

fn attr(e: &BytesStart, name: &[u8]) -> f64 {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .and_then(|a| std::str::from_utf8(&a.value).ok().and_then(|s| s.parse().ok()))
        .unwrap_or(0.0)
}

fn entity(name: &str) -> String {
    match name {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        other => other
            .strip_prefix("#x")
            .and_then(|h| u32::from_str_radix(h, 16).ok())
            .or_else(|| other.strip_prefix('#').and_then(|d| d.parse().ok()))
            .and_then(char::from_u32)
            .map(String::from)
            .unwrap_or_default(),
    }
}

fn parse_layout(xml: &str) -> Result<Vec<Page>> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut pages = Vec::new();
    let mut page = Page::default();
    let mut block: Vec<Line> = Vec::new();
    let mut line = Line::default();
    let mut word: Option<Word> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"page" => {
                    page = Page { width: attr(&e, b"width"), height: attr(&e, b"height"), blocks: Vec::new() };
                }
                b"line" => {
                    line = Line { x0: attr(&e, b"xMin"), y0: attr(&e, b"yMin"), x1: attr(&e, b"xMax"), y1: attr(&e, b"yMax"), words: Vec::new() };
                }
                b"word" => {
                    word = Some(Word { x0: attr(&e, b"xMin"), x1: attr(&e, b"xMax"), text: String::new() });
                }
                _ => {}
            },
            Ok(Event::Text(t)) => {
                if let Some(w) = word.as_mut() {
                    w.text.push_str(&String::from_utf8_lossy(&t));
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if let Some(w) = word.as_mut() {
                    w.text.push_str(&entity(&String::from_utf8_lossy(&r)));
                }
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"word" => {
                    if let Some(w) = word.take() {
                        line.words.push(w);
                    }
                }
                b"line" => block.push(std::mem::take(&mut line)),
                b"block" => page.blocks.push(std::mem::take(&mut block)),
                b"page" => pages.push(std::mem::take(&mut page)),
                _ => {}
            },
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => bail!("could not read PDF layout: {e}"),
        }
    }
    Ok(pages)
}

static PAGE_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(page\s*)?[\divxlc]{1,6}(\s*(of|/)\s*\d+)?$").unwrap());
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());

fn zone_key(text: &str) -> String {
    DIGITS.replace_all(&text.to_lowercase(), "#").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Running heads and page numbers sit in the outer bands and repeat, while real headings
/// do not. Removing them keeps them out of search, prompts and narration.
fn strip_margins(pages: &mut [Page]) {
    let in_zone = |line: &Line, height: f64| {
        let middle = (line.y0 + line.y1) / 2.0;
        middle < height * 0.09 || middle > height * 0.91
    };
    let mut counts: HashMap<String, u32> = HashMap::new();
    for page in pages.iter() {
        for block in &page.blocks {
            for line in block.iter().filter(|l| in_zone(l, page.height)) {
                *counts.entry(zone_key(&line.text())).or_default() += 1;
            }
        }
    }
    let many_pages = pages.len() > 5;
    for page in pages.iter_mut() {
        let height = page.height;
        for block in page.blocks.iter_mut() {
            block.retain(|line| {
                if !in_zone(line, height) {
                    return true;
                }
                let text = line.text();
                let repeated = many_pages && counts.get(&zone_key(&text)).copied().unwrap_or(0) >= 3;
                !(repeated || PAGE_NUMBER.is_match(text.trim()))
            });
        }
    }
}

fn normalize(text: &str) -> String {
    text.replace('\u{fb00}', "ff")
        .replace('\u{fb01}', "fi")
        .replace('\u{fb02}', "fl")
        .replace('\u{fb03}', "ffi")
        .replace('\u{fb04}', "ffl")
        .replace('\u{ad}', "")
}

fn join_line(para: &mut String, next: &str) {
    if para.ends_with('-') && next.chars().next().is_some_and(char::is_lowercase) {
        para.pop();
    } else if !para.is_empty() {
        para.push(' ');
    }
    para.push_str(next);
}

fn is_monospace(lines: &[Line]) -> bool {
    let mut widths: Vec<f64> = Vec::new();
    for line in lines {
        for word in line.words.iter().filter(|w| w.text.chars().count() >= 3) {
            widths.push((word.x1 - word.x0) / word.text.chars().count() as f64);
        }
    }
    if widths.len() < 3 {
        return false;
    }
    let mean = widths.iter().sum::<f64>() / widths.len() as f64;
    let variance = widths.iter().map(|w| (w - mean).powi(2)).sum::<f64>() / widths.len() as f64;
    variance.sqrt() / mean < 0.015
}

struct Para {
    text: String,
    kind: &'static str,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn paragraphs(block: &[Line], body_height: f64) -> Vec<Para> {
    let mut out: Vec<Vec<&Line>> = Vec::new();
    let left = block.iter().map(|l| l.x0).fold(f64::MAX, f64::min);
    let right = block.iter().map(|l| l.x1).fold(0.0, f64::max);
    let width = (right - left).max(1.0);
    for (i, line) in block.iter().enumerate() {
        let h = line.height();
        let starts = if i == 0 {
            true
        } else {
            let prev = &block[i - 1];
            let same_row = (line.y0 - prev.y0).abs() < h * 0.3;
            let gap = line.y0 - prev.y1 > h * 0.75;
            let indented = line.x0 > left + h * 1.0 && prev.x0 <= left + h * 0.5;
            let prev_short = prev.x1 < left + width * 0.72 && prev.text().ends_with(['.', '?', '!', ':', '"', '\u{201d}']);
            !same_row && (gap || indented || prev_short)
        };
        if starts {
            out.push(vec![line]);
        } else if let Some(last) = out.last_mut() {
            last.push(line);
        }
    }
    let code = {
        let owned: Vec<Line> = block.to_vec();
        is_monospace(&owned)
    };
    out.into_iter()
        .filter_map(|lines| {
            let mut text = String::new();
            for line in &lines {
                join_line(&mut text, &normalize(&line.text()));
            }
            let text = text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let height = lines.iter().map(|l| l.height()).sum::<f64>() / lines.len() as f64;
            let kind = if text.matches(". .").count() >= 4 {
                // Dot leaders: a printed table of contents, useless to search or narrate.
                "cell"
            } else if code {
                "code"
            } else if height > body_height * 1.2 && lines.len() <= 3 && text.chars().count() < 140 {
                "h2"
            } else {
                "p"
            };
            Some(Para {
                text,
                kind,
                x0: lines.iter().map(|l| l.x0).fold(f64::MAX, f64::min),
                y0: lines.iter().map(|l| l.y0).fold(f64::MAX, f64::min),
                x1: lines.iter().map(|l| l.x1).fold(0.0, f64::max),
                y1: lines.iter().map(|l| l.y1).fold(0.0, f64::max),
            })
        })
        .collect()
}

fn body_line_height(pages: &[Page]) -> f64 {
    let mut heights: Vec<(i64, usize)> = Vec::new();
    let mut tally: HashMap<i64, usize> = HashMap::new();
    for line in pages.iter().flat_map(|p| p.blocks.iter()).flatten() {
        *tally.entry((line.height() * 2.0).round() as i64).or_default() += line.text().chars().count();
    }
    heights.extend(tally);
    heights.iter().max_by_key(|(_, chars)| *chars).map(|(h, _)| *h as f64 / 2.0).unwrap_or(12.0)
}

fn blocks_from_pages(pages: &[Page]) -> Vec<RawBlock> {
    let body = body_line_height(pages);
    let mut blocks: Vec<RawBlock> = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let number = index as u32 + 1;
        let mut first_on_page = true;
        for block in &page.blocks {
            for para in paragraphs(block, body) {
                let continues = first_on_page
                    && para.kind == "p"
                    && para.text.chars().next().is_some_and(char::is_lowercase)
                    && blocks.last().is_some_and(|b| b.kind == "p" && !b.text.ends_with(['.', '?', '!', ':', ';', '"', '\u{201d}', ')']));
                first_on_page = false;
                if continues {
                    let last = blocks.last_mut().unwrap();
                    join_line(&mut last.text, &para.text);
                    continue;
                }
                let rect = [
                    para.x0 / page.width,
                    para.y0 / page.height,
                    (para.x1 - para.x0) / page.width,
                    (para.y1 - para.y0) / page.height,
                ];
                blocks.push(RawBlock {
                    seq: blocks.len() as u32,
                    section: 0,
                    kind: para.kind.into(),
                    text: para.text,
                    speech: None,
                    page: number,
                    rect: Some(rect),
                });
            }
        }
    }
    blocks
}

static OUTLINE_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<item page="(\d+)">(.*?)</item>"#).unwrap());
static CHAPTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(chapter|part|book|appendix)\s+([\divxlc]+|[a-z]+)\b").unwrap());

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#160;", " ").replace("&amp;", "&")
}

fn outline(path: &Path) -> Vec<(u32, String, u32)> {
    let Ok(output) = Command::new("pdftohtml").args(["-xml", "-stdout", "-i", "-q", "-f", "1", "-l", "1"]).arg(path).output() else {
        return Vec::new();
    };
    let xml = String::from_utf8_lossy(&output.stdout);
    let mut depth = 0u32;
    let mut items = Vec::new();
    for line in xml.lines() {
        if line.contains("<outline") {
            depth += 1;
        }
        if let Some(item) = OUTLINE_ITEM.captures(line) {
            let title = unescape(&item[2]);
            let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
            if let (Ok(page), false) = (item[1].parse::<u32>(), title.is_empty()) {
                items.push((depth.max(1), title, page));
            }
        }
        if line.contains("</outline") {
            depth = depth.saturating_sub(1);
        }
    }
    items
}

fn toc_for(path: &Path, blocks: &[RawBlock], page_count: u32) -> Vec<RawToc> {
    let block_at = |page: u32| blocks.iter().find(|b| b.page >= page).map(|b| b.seq);
    // Outlines only name a page, and several headings can share one. Finding the heading
    // text on that page puts chapter boundaries in the right paragraph.
    let heading_at = |page: u32, title: &str, after: u32| {
        let wanted = title.to_lowercase();
        blocks
            .iter()
            .filter(|b| b.seq >= after && (b.page == page || b.page == page + 1))
            .find(|b| {
                let text = b.text.to_lowercase();
                text.contains(&wanted) && text.len() < wanted.len() + 40
            })
            .map(|b| b.seq)
    };
    let mut toc: Vec<RawToc> = Vec::new();
    let mut floor = 0;
    for (level, title, page) in outline(path) {
        if let Some(block) = heading_at(page, &title, floor).or(block_at(page)) {
            floor = floor.max(block);
            toc.push(RawToc { level, title, block, page });
        }
    }
    if toc.len() >= 2 {
        return toc;
    }
    let toc: Vec<RawToc> = blocks
        .iter()
        .filter(|b| b.kind == "h2" && CHAPTER.is_match(&b.text))
        .map(|b| RawToc { level: 1, title: b.text.clone(), block: b.seq, page: b.page })
        .collect();
    if toc.len() >= 2 {
        return toc;
    }
    let step = 20;
    let mut parts = Vec::new();
    let mut start = 1;
    while start <= page_count {
        if let Some(block) = block_at(start) {
            let end = (start + step - 1).min(page_count);
            parts.push(RawToc { level: 1, title: format!("Pages {start}\u{2013}{end}"), block, page: start });
        }
        start += step;
    }
    parts.dedup_by_key(|p| p.block);
    parts
}

fn good_metadata(value: &str) -> bool {
    let lower = value.to_lowercase();
    !value.trim().is_empty()
        && !lower.contains("untitled")
        && !lower.starts_with("microsoft word")
        && !lower.ends_with(".pdf")
        && !lower.ends_with(".doc")
        && !lower.ends_with(".indd")
        && !lower.ends_with(".dvi")
}

pub fn parse(path: &Path, file_name: &str) -> Result<ParsedBook> {
    let info = Command::new("pdfinfo").args(["-enc", "UTF-8"]).arg(path).output().map_err(|_| {
        anyhow!("PDF support needs poppler. Install it with `sudo pacman -S poppler`, then import again.")
    })?;
    if !info.status.success() {
        let stderr = String::from_utf8_lossy(&info.stderr).to_lowercase();
        if stderr.contains("password") || stderr.contains("encrypt") {
            bail!("This PDF is password-protected, so it can't be opened.");
        }
        bail!("This PDF is damaged and can't be opened.");
    }
    let mut fields: HashMap<String, String> = HashMap::new();
    for line in String::from_utf8_lossy(&info.stdout).lines() {
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    let layout = Command::new("pdftotext").args(["-bbox-layout", "-enc", "UTF-8"]).arg(path).arg("-").output()?;
    if !layout.status.success() {
        bail!("OmaReader could not read the text of this PDF.");
    }
    let mut pages = parse_layout(&String::from_utf8_lossy(&layout.stdout))?;
    strip_margins(&mut pages);
    let blocks = blocks_from_pages(&pages);
    let page_count = fields.get("Pages").and_then(|p| p.parse().ok()).unwrap_or(pages.len() as u32);
    let toc = toc_for(path, &blocks, page_count);
    let last = blocks.len().saturating_sub(1) as u32;

    let title = fields
        .get("Title")
        .filter(|t| good_metadata(t))
        .cloned()
        .or_else(|| {
            blocks
                .iter()
                .find(|b| b.page == 1 && b.kind == "h2" && b.text.contains(' ') && !b.text.to_lowercase().starts_with("arxiv"))
                .map(|b| b.text.clone())
        })
        .unwrap_or_else(|| pretty_stem(file_name));
    let author = fields.get("Author").filter(|a| good_metadata(a)).cloned().unwrap_or_default();
    Ok(ParsedBook {
        title,
        author,
        cover: render_cover(path).map(|bytes| (bytes, "jpg".to_string())),
        sections: vec![RawSection { title: String::new(), html: String::new(), first_block: 0, last_block: last }],
        blocks,
        toc,
        pages: page_count,
        ..Default::default()
    })
}

fn render_cover(path: &Path) -> Option<Vec<u8>> {
    let output = Command::new("pdftoppm")
        .args(["-f", "1", "-l", "1", "-jpeg", "-jpegopt", "quality=85", "-scale-to", "720", "-singlefile"])
        .arg(path)
        .output()
        .ok()?;
    (output.status.success() && !output.stdout.is_empty()).then_some(output.stdout)
}
