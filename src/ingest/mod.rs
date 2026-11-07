//! Import pipeline: every format becomes the same `ParsedBook`, so search, notes, AI
//! citations and audiobooks work identically regardless of the source file.

pub mod epub;
pub mod html;
pub mod pdf;
pub mod plain;

use crate::config::Paths;
use crate::db::{now, Db};
use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

#[derive(Default, Clone, Debug)]
pub struct RawBlock {
    pub seq: u32,
    pub section: u32,
    pub kind: String,
    pub text: String,
    pub speech: Option<String>,
    pub page: u32,
    pub rect: Option<[f64; 4]>,
}

#[derive(Default, Clone, Debug)]
pub struct RawSection {
    pub title: String,
    pub html: String,
    pub first_block: u32,
    pub last_block: u32,
}

#[derive(Default, Clone, Debug)]
pub struct RawToc {
    pub level: u32,
    pub title: String,
    pub block: u32,
    pub page: u32,
}

#[derive(Default, Debug)]
pub struct ParsedBook {
    pub title: String,
    pub author: String,
    pub language: String,
    pub description: String,
    pub cover: Option<(Vec<u8>, String)>,
    pub sections: Vec<RawSection>,
    pub blocks: Vec<RawBlock>,
    pub toc: Vec<RawToc>,
    /// Real page count for PDFs, zero for reflowable books.
    pub pages: u32,
}

/// Characters per virtual page in reflowable books, close to a printed page.
pub const CHARS_PER_PAGE: u64 = 1500;

const NATIVE: &[&str] = &["epub", "pdf", "txt", "text", "md", "markdown", "html", "htm", "xhtml", "docx", "fb2"];
const VIA_CALIBRE: &[&str] = &["mobi", "azw", "azw3", "kfx", "prc", "lit", "pdb", "lrf", "odt", "rtf", "snb", "tcr"];

pub fn supported_formats() -> (Vec<&'static str>, Vec<&'static str>) {
    (NATIVE.to_vec(), VIA_CALIBRE.to_vec())
}

fn extension(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn pretty_stem(file_name: &str) -> String {
    let stem = Path::new(file_name).file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let cleaned = stem.replace(['_', '.'], " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() { "Untitled".into() } else { cleaned }
}

pub fn parse_file(path: &Path, file_name: &str, book_id: &str, paths: &Paths) -> Result<ParsedBook> {
    let ext = extension(file_name);
    let book_dir = paths.book_dir(book_id);
    match ext.as_str() {
        "epub" => epub::parse(path, book_id, &book_dir),
        "pdf" => pdf::parse(path, file_name),
        "txt" | "text" => plain::parse_text(path, file_name),
        "md" | "markdown" => plain::parse_markdown(path, file_name),
        "html" | "htm" | "xhtml" => plain::parse_html(path, file_name),
        "docx" => plain::parse_docx(path, file_name, book_id, &book_dir),
        "fb2" => plain::parse_fb2(path, file_name, book_id, &book_dir),
        other if VIA_CALIBRE.contains(&other) => {
            let converted = convert_with_calibre(path, &paths.tmp)?;
            let result = epub::parse(&converted, book_id, &book_dir);
            let _ = fs::remove_file(&converted);
            result
        }
        other => bail!("OmaReader can't open .{other} files yet."),
    }
}

fn convert_with_calibre(path: &Path, tmp: &Path) -> Result<PathBuf> {
    let out = tmp.join(format!("{}.epub", uuid::Uuid::new_v4()));
    let result = std::process::Command::new("ebook-convert").arg(path).arg(&out).output().map_err(|_| {
        anyhow!("This format is converted by Calibre, which isn't installed. Install it with `sudo pacman -S calibre`, then import again.")
    })?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        if stderr.to_ascii_lowercase().contains("drm") {
            bail!("This book is DRM-protected, so it can't be opened.");
        }
        bail!("Calibre could not convert this file.");
    }
    Ok(out)
}

static FRONT_MATTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\W*(cover|title\s*page|half\s*title|copyright|copyright page|imprint|colophon|contents|table of contents|toc|list of (figures|tables|illustrations)|index|also by.*|other books.*|about the (publisher|author)|the full project gutenberg.*|project gutenberg.*|license|licence|bibliography|references|endnotes|footnotes|acknowledge?ments?)\W*$").unwrap()
});

pub fn is_front_matter(title: &str) -> bool {
    FRONT_MATTER.is_match(title.trim())
}

/// Headings become the outline when a format has no table of contents of its own.
/// Long headingless documents are divided so chapter tools and audio still have units.
pub fn outline_from_blocks(blocks: &[RawBlock]) -> Vec<RawToc> {
    let top = blocks
        .iter()
        .filter_map(|b| b.kind.strip_prefix('h').and_then(|n| n.parse::<u32>().ok()))
        .min();
    let mut toc: Vec<RawToc> = Vec::new();
    if let Some(top) = top {
        for block in blocks {
            let Some(level) = block.kind.strip_prefix('h').and_then(|n| n.parse::<u32>().ok()) else { continue };
            if level <= top + 1 && block.text.chars().count() < 160 {
                toc.push(RawToc { level: level - top + 1, title: block.text.clone(), block: block.seq, page: block.page });
            }
        }
    }
    if toc.len() >= 2 {
        return toc;
    }
    let mut parts = Vec::new();
    let mut words = 0usize;
    for block in blocks {
        if parts.is_empty() || words > 3000 {
            parts.push(RawToc { level: 1, title: format!("Part {}", parts.len() + 1), block: block.seq, page: block.page });
            words = 0;
        }
        words += block.text.split_whitespace().count();
    }
    if parts.len() > 1 || toc.is_empty() { parts } else { toc }
}

fn store(db: &Db, id: &str, parsed: &ParsedBook, paths: &Paths) -> Result<()> {
    let mut has_cover = false;
    if let Some((bytes, ext)) = &parsed.cover {
        fs::write(paths.book_dir(id).join(format!("cover.{ext}")), bytes)?;
        has_cover = true;
    }
    let mut conn = db.conn();
    let tx = conn.transaction()?;
    let mut chars: u64 = 0;
    let mut words: u64 = 0;
    {
        let mut insert = tx.prepare(
            "INSERT INTO blocks(book_id,seq,section,kind,text,speech,start_char,page,x,y,w,h) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        )?;
        for b in &parsed.blocks {
            let [x, y, w, h] = match b.rect {
                Some(r) => [Some(r[0]), Some(r[1]), Some(r[2]), Some(r[3])],
                None => [None; 4],
            };
            insert.execute(params![id, b.seq, b.section, b.kind, b.text, b.speech, chars, b.page, x, y, w, h])?;
            chars += b.text.encode_utf16().count() as u64 + 1;
            words += b.text.split_whitespace().count() as u64;
        }
        let mut insert = tx.prepare("INSERT INTO sections(book_id,idx,title,html,first_block,last_block) VALUES(?1,?2,?3,?4,?5,?6)")?;
        for (i, s) in parsed.sections.iter().enumerate() {
            insert.execute(params![id, i as u32, s.title, s.html, s.first_block, s.last_block])?;
        }
        let mut insert = tx.prepare("INSERT INTO toc(book_id,idx,level,title,block,page,front) VALUES(?1,?2,?3,?4,?5,?6,?7)")?;
        for (i, t) in parsed.toc.iter().enumerate() {
            insert.execute(params![id, i as u32, t.level, t.title, t.block, t.page, is_front_matter(&t.title)])?;
        }
    }
    let pages = if parsed.pages > 0 { parsed.pages as u64 } else { (chars / CHARS_PER_PAGE).max(1) };
    tx.execute(
        "UPDATE books SET title=?2, author=?3, language=?4, description=?5, status='ready', error=NULL, has_cover=?6, pages=?7, words=?8, chars=?9 WHERE id=?1",
        params![id, parsed.title, parsed.author, parsed.language, parsed.description, has_cover, pages, words, chars],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize())[..24].to_string())
}

pub enum Registered {
    /// The file is already in the library and has been parsed.
    Existing(String),
    New(String),
}

/// Moves an uploaded file into the library and creates the placeholder row, so the book
/// appears immediately while parsing continues in the background.
pub fn register(db: &Db, paths: &Paths, temp: &Path, file_name: &str) -> Result<Registered> {
    let ext = extension(file_name);
    if !NATIVE.contains(&ext.as_str()) && !VIA_CALIBRE.contains(&ext.as_str()) {
        bail!("OmaReader can't open .{ext} files yet.");
    }
    let id = hash_file(temp)?;
    let existing: Option<String> = {
        let conn = db.conn();
        conn.query_row("SELECT status FROM books WHERE id=?1", [&id], |r| r.get(0)).ok()
    };
    if let Some(status) = existing {
        if status != "failed" {
            let _ = fs::remove_file(temp);
            return Ok(Registered::Existing(id));
        }
        db.conn().execute("DELETE FROM books WHERE id=?1", [&id])?;
        let _ = fs::remove_dir_all(paths.book_dir(&id));
    }
    let dir = paths.book_dir(&id);
    fs::create_dir_all(dir.join("assets"))?;
    let original = dir.join(format!("original.{ext}"));
    if fs::rename(temp, &original).is_err() {
        fs::copy(temp, &original)?;
        let _ = fs::remove_file(temp);
    }
    let size = fs::metadata(&original)?.len() as i64;
    db.conn().execute(
        "INSERT INTO books(id,title,format,file_name,file_size,status,added_at) VALUES(?1,?2,?3,?4,?5,'processing',?6)",
        params![id, pretty_stem(file_name), normalized_format(&ext), file_name, size, now()],
    )?;
    Ok(Registered::New(id))
}

fn normalized_format(ext: &str) -> &str {
    match ext {
        "htm" | "xhtml" => "html",
        "markdown" => "md",
        "text" => "txt",
        other => other,
    }
}

pub fn original_path(paths: &Paths, id: &str, file_name: &str) -> PathBuf {
    paths.book_dir(id).join(format!("original.{}", extension(file_name)))
}

pub fn process(db: &Db, paths: &Paths, id: &str) -> Result<()> {
    let file_name: String = db.conn().query_row("SELECT file_name FROM books WHERE id=?1", [id], |r| r.get(0))?;
    let original = original_path(paths, id, &file_name);
    let outcome = parse_file(&original, &file_name, id, paths).and_then(|parsed| store(db, id, &parsed, paths));
    if let Err(error) = &outcome {
        tracing::warn!(book = id, "import failed: {error:#}");
        db.conn().execute("UPDATE books SET status='failed', error=?2 WHERE id=?1", params![id, format!("{error:#}")])?;
    }
    outcome.context("import failed")
}

/// Registers and parses a file synchronously. Used by the CLI and tests.
pub fn import_path(db: &Db, paths: &Paths, source: &Path) -> Result<String> {
    let file_name = source.file_name().and_then(|n| n.to_str()).context("file has no name")?.to_string();
    let temp = paths.tmp.join(uuid::Uuid::new_v4().to_string());
    fs::copy(source, &temp)?;
    let registered = register(db, paths, &temp, &file_name);
    if registered.is_err() {
        let _ = fs::remove_file(&temp);
    }
    match registered? {
        Registered::Existing(id) => Ok(id),
        Registered::New(id) => {
            process(db, paths, &id)?;
            Ok(id)
        }
    }
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                let value = (high * 16 + low) as u8;
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Resolves `href` against the directory of `base` inside an archive, without ever
/// escaping the archive root.
pub fn resolve_zip_path(base: &str, href: &str) -> String {
    let href = percent_decode(href);
    let mut parts: Vec<&str> = if href.starts_with('/') {
        Vec::new()
    } else {
        base.rsplit_once('/').map(|(dir, _)| dir.split('/').collect()).unwrap_or_default()
    };
    for piece in href.split('/') {
        match piece {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub fn image_extension(name: &str) -> Option<&'static str> {
    match extension(name).as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "svg" => Some("svg"),
        "avif" => Some("avif"),
        _ => None,
    }
}

pub fn first_heading(blocks: &[RawBlock]) -> Option<String> {
    blocks.iter().find(|b| b.kind.starts_with('h')).map(|b| b.text.clone())
}

pub fn assign_links(html: &str, resolve: &dyn Fn(usize) -> Option<u32>) -> String {
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"href="oma:(\d+)""#).unwrap());
    LINK.replace_all(html, |c: &regex::Captures| {
        let target = c[1].parse::<usize>().ok().and_then(resolve);
        match target {
            Some(block) => format!("href=\"#b{block}\""),
            None => "href=\"#\"".to_string(),
        }
    })
    .into_owned()
}
