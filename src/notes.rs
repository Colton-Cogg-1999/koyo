//! Notes live in SQLite and are mirrored as Markdown after every change, so they stay
//! readable and portable even without OmaReader.

use crate::config::Paths;
use crate::db::Db;
use crate::retrieval;
use anyhow::Result;
use std::fs;
use std::path::PathBuf;

fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let short: String = trimmed.chars().take(80).collect();
    if short.is_empty() { "untitled".into() } else { short }
}

fn yaml(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn quote_lines(text: &str) -> String {
    text.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
}

pub fn book_markdown(db: &Db, book: &str) -> Result<(String, String)> {
    let conn = db.conn();
    let (title, author): (String, String) =
        conn.query_row("SELECT title,author FROM books WHERE id=?1", [book], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let chapters = retrieval::chapters(&conn, book)?;
    let mut md = format!("---\ntitle: {}\nauthor: {}\nsource: OmaReader\n---\n\n# {title}\n\n", yaml(&title), yaml(&author));

    let mut stmt = conn.prepare(
        "SELECT kind,color,block,page,quote,note FROM annotations WHERE book_id=?1 AND kind!='bookmark' ORDER BY page,block,created_at",
    )?;
    type Row = (String, String, u32, u32, String, String);
    let rows: Vec<Row> = stmt
        .query_map([book], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<Result<_, _>>()?;
    let mut last_chapter = String::new();
    for (_, color, block, page, quote, note) in &rows {
        let chapter = retrieval::chapter_of(&chapters, *block).map(|c| c.title.clone()).unwrap_or_default();
        if chapter != last_chapter && !chapter.is_empty() {
            md.push_str(&format!("## {chapter}\n\n"));
            last_chapter = chapter;
        }
        if !quote.is_empty() {
            md.push_str(&quote_lines(quote));
            md.push('\n');
            let location = if *page > 0 { format!("p. {page}, {color}") } else { color.clone() };
            md.push_str(&format!(">\n> — {location}\n\n"));
        }
        if !note.is_empty() {
            md.push_str(note);
            md.push_str("\n\n");
        }
    }

    let mut stmt = conn.prepare("SELECT title,body FROM notes WHERE book_id=?1 ORDER BY created_at")?;
    let notes: Vec<(String, String)> =
        stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    if !notes.is_empty() {
        md.push_str("## Notebook\n\n");
        for (note_title, body) in notes {
            if !note_title.is_empty() {
                md.push_str(&format!("### {note_title}\n\n"));
            }
            md.push_str(&body);
            md.push_str("\n\n");
        }
    }
    Ok((title, md))
}

pub fn notes_dir(db: &Db, paths: &Paths) -> PathBuf {
    db.setting_str("notes_dir").filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| paths.notes.clone())
}

/// Rewrites the Markdown mirror for one book. Files are written beside a temp name
/// so a crash can't leave a half-written note.
pub fn mirror_book(db: &Db, paths: &Paths, book: &str) -> Result<()> {
    let (title, md) = book_markdown(db, book)?;
    let dir = notes_dir(db, paths);
    fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}-{}.md", slug(&title), &book[..6.min(book.len())]));
    let temp = target.with_extension("md.tmp");
    fs::write(&temp, md)?;
    fs::rename(temp, target)?;
    Ok(())
}

pub fn mirror_loose_notes(db: &Db, paths: &Paths) -> Result<()> {
    let notes: Vec<(String, String)> = {
        let conn = db.conn();
        let mut stmt = conn.prepare("SELECT title,body FROM notes WHERE book_id IS NULL ORDER BY created_at")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        rows
    };
    let mut md = String::from("# Notebook\n\n");
    for (title, body) in notes {
        if !title.is_empty() {
            md.push_str(&format!("## {title}\n\n"));
        }
        md.push_str(&body);
        md.push_str("\n\n");
    }
    let dir = notes_dir(db, paths);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("notebook.md"), md)?;
    Ok(())
}
