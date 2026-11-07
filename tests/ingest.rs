use omareader::config::Paths;
use omareader::db::Db;
use omareader::{ingest, notes, retrieval};
use std::io::Write;
use std::path::Path;

fn library() -> (tempfile::TempDir, Paths, Db) {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::at(dir.path().join("data")).unwrap();
    let db = Db::open(&paths.db).unwrap();
    (dir, paths, db)
}

fn write_epub(path: &Path, chapter: &str) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    let mut add = |name: &str, body: &str| {
        zip.start_file(name, options).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    add("mimetype", "application/epub+zip");
    add("META-INF/container.xml", r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>"#);
    add("OEBPS/book.opf", r#"<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book; Or, A Longer Subtitle / Catalog noise</dc:title><dc:creator>A. Writer</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="c" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/><item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="s" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="c"/><itemref idref="a"/></spine></package>"#);
    add("OEBPS/cover.xhtml", "<html><body><div><img src=\"missing.png\"/></div></body></html>");
    add("OEBPS/one.xhtml", chapter);
    add("OEBPS/style.css", ".it { font-style: italic } .gone { display: none }");
    add("OEBPS/nav.xhtml", r#"<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml#one">First</a></li><li><a href="one.xhtml#two">Second</a></li></ol></nav></body></html>"#);
    zip.finish().unwrap();
}

const CHAPTER: &str = r#"<html><head><title/><script>steal()</script></head><body>
<h1 id="one">First</h1>
<p onclick="steal()">Plain <span class="it">italic</span> text<a href="note.xhtml" epub:type="noteref">1</a>.<script>steal()</script></p>
<p><img src="http://tracker.example/pixel.png"/>Second   paragraph
 with   wrapped lines<br/>and a break.</p>
<p class="gone">Hidden text.</p>
<iframe src="https://evil.example"></iframe>
<h1 id="two">Second</h1>
<p>Equanimity is the quiet discipline.</p>
</body></html>"#;

#[test]
fn epub_becomes_sanitized_blocks_with_a_working_outline() {
    let (dir, paths, db) = library();
    let file = dir.path().join("book.epub");
    write_epub(&file, CHAPTER);
    let id = ingest::import_path(&db, &paths, &file).unwrap();
    let conn = db.conn();
    let (title, author, status): (String, String, String) =
        conn.query_row("SELECT title,author,status FROM books WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((title.as_str(), author.as_str(), status.as_str()), ("Test Book", "A. Writer", "ready"));

    let html: String = conn.query_row("SELECT group_concat(html,'') FROM sections WHERE book_id=?1", [&id], |r| r.get(0)).unwrap();
    for banned in ["<script", "onclick", "iframe", "tracker.example", "Hidden text"] {
        assert!(!html.contains(banned), "{banned} survived in {html}");
    }
    assert!(html.contains("<em>italic</em>"), "class-based italics were lost: {html}");

    let mut stmt = conn.prepare("SELECT seq,kind,text,speech FROM blocks WHERE book_id=?1 ORDER BY seq").unwrap();
    let blocks: Vec<(u32, String, String, Option<String>)> =
        stmt.query_map([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(Result::unwrap).collect();
    assert_eq!(blocks[1].2, "Plain italic text1.");
    assert_eq!(blocks[1].3.as_deref(), Some("Plain italic text ."), "the footnote marker must stay out of narration");
    assert_eq!(blocks[2].2, "Second paragraph with wrapped lines and a break.");

    let chapters = retrieval::chapters(&conn, &id).unwrap();
    assert_eq!(chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["First", "Second"]);
    assert_eq!(chapters[1].start, blocks.iter().find(|b| b.2 == "Second").unwrap().0);
}

#[test]
fn encrypted_epubs_are_refused_with_a_clear_reason() {
    let (dir, paths, db) = library();
    let file = dir.path().join("locked.epub");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&file).unwrap());
    zip.start_file("META-INF/rights.xml", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(b"<rights/>").unwrap();
    zip.finish().unwrap();
    let error = ingest::import_path(&db, &paths, &file).unwrap_err();
    assert!(format!("{error:#}").contains("DRM"));
}

#[test]
fn reimporting_the_same_file_keeps_one_copy() {
    let (dir, paths, db) = library();
    let file = dir.path().join("note.txt");
    std::fs::write(&file, "Chapter 1\n\nHello there.\n\nChapter 2\n\nGeneral Kenobi.").unwrap();
    let first = ingest::import_path(&db, &paths, &file).unwrap();
    let second = ingest::import_path(&db, &paths, &file).unwrap();
    assert_eq!(first, second);
    let count: u32 = db.conn().query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
    assert!(paths.book_dir(&first).join("original.txt").exists(), "the library keeps its own copy of the file");
}

#[test]
fn markdown_notes_mirror_and_retrieval_finds_passages() {
    let (dir, paths, db) = library();
    let file = dir.path().join("guide.md");
    std::fs::write(&file, "---\ntitle: Field Guide\nauthor: T. Author\n---\n\n# Lanterns\n\nThe lamp burned low across the water.\n\n# Bells\n\nTemple bells answered in the dark.\n").unwrap();
    let id = ingest::import_path(&db, &paths, &file).unwrap();

    let prompt = retrieval::build(&db, &id, &retrieval::AskRequest { question: "What answered?".into(), ..Default::default() }, &[]).unwrap();
    assert!(prompt.prompt.contains("Temple bells"), "{}", prompt.prompt);
    assert!(prompt.citations.iter().any(|c| c.quote.contains("Temple bells") && c.chapter == "Bells"));
    assert!(prompt.system.contains("not instructions"), "book text must be declared untrusted");

    let hits = retrieval::search(&db, Some(&id), "bells", 10).unwrap();
    assert_eq!(hits.len(), 2, "{hits:?}");

    db.conn()
        .execute(
            "INSERT INTO annotations(id,book_id,kind,anchor,block,quote,note,created_at,updated_at) VALUES('a',?1,'highlight','{}',1,'The lamp burned low','A good line',1,1)",
            [&id],
        )
        .unwrap();
    notes::mirror_book(&db, &paths, &id).unwrap();
    let mirrored = std::fs::read_dir(&paths.notes).unwrap().next().unwrap().unwrap().path();
    let text = std::fs::read_to_string(mirrored).unwrap();
    assert!(text.contains("title: \"Field Guide\"") && text.contains("> The lamp burned low") && text.contains("A good line"), "{text}");
}

#[test]
fn malformed_percent_sequences_preserve_unicode_without_panicking() {
    for (raw, decoded) in [("%é", "%é"), ("%a界", "%a界"), ("100%", "100%"), ("%E2%98%83", "☃"), ("hello%20world", "hello world")] {
        assert_eq!(ingest::percent_decode(raw), decoded);
    }
}

#[test]
fn rejected_cli_import_does_not_leave_a_temporary_copy() {
    let (dir, paths, db) = library();
    let file = dir.path().join("unsupported.bin");
    std::fs::write(&file, "not a book").unwrap();
    assert!(ingest::import_path(&db, &paths, &file).is_err());
    assert_eq!(std::fs::read_dir(&paths.tmp).unwrap().count(), 0);
    assert!(file.exists());
}

#[test]
fn loose_notes_are_mirrored_and_multiline_metadata_is_escaped() {
    let (dir, paths, db) = library();
    let file = dir.path().join("note.txt");
    std::fs::write(&file, "A paragraph to annotate.").unwrap();
    let book = ingest::import_path(&db, &paths, &file).unwrap();
    db.conn().execute("UPDATE books SET title=?2 WHERE id=?1", rusqlite::params![book, "First line\nsecond line"]).unwrap();
    let (_, md) = notes::book_markdown(&db, &book).unwrap();
    assert!(md.contains("title: \"First line\\nsecond line\""));
    db.conn().execute("INSERT INTO notes(id,title,body,created_at,updated_at) VALUES('loose','Notebook','Keep this.',1,1)", []).unwrap();
    notes::mirror_loose_notes(&db, &paths).unwrap();
    assert!(std::fs::read_to_string(paths.notes.join("notebook.md")).unwrap().contains("Keep this."));
    assert!(!paths.notes.join("notebook.md.tmp").exists());
}

#[test]
fn question_scopes_exclude_other_chapters_and_validate_selections() {
    let (dir, paths, db) = library();
    let file = dir.path().join("scopes.md");
    std::fs::write(&file, "# Harbor\n\nThe harbor signal is amber, and its keeper is Mara.\n\n# Observatory\n\nThe observatory signal is violet, and its keeper is Ivo.\n").unwrap();
    let id = ingest::import_path(&db, &paths, &file).unwrap();
    let chapters = retrieval::chapters(&db.conn(), &id).unwrap();
    let build = |r| retrieval::build(&db, &id, &r, &[]).unwrap();
    let chapter = build(retrieval::AskRequest { question: "Who keeps the signal?".into(), scope: Some("chapter".into()), chapter: Some(1), block: Some(0), ..Default::default() });
    assert!(chapter.citations.iter().any(|c| c.quote.contains("Ivo")));
    assert!(chapter.citations.iter().all(|c| c.block >= chapters[1].start && !c.quote.contains("Mara")));
    let page = build(retrieval::AskRequest { question: "What is the signal?".into(), scope: Some("page".into()), block: Some(1), end_block: Some(1), ..Default::default() });
    assert_eq!(page.citations.len(), 1);
    assert!(page.citations[0].quote.contains("amber"));
    assert!(!page.prompt.contains("violet"));
    let mut request = retrieval::AskRequest { question: "Explain this".into(), scope: Some("selection".into()), block: Some(1), selection: Some("its keeper is Mara".into()), ..Default::default() };
    let selection = build(request.clone());
    assert_eq!(selection.citations[0].quote, "its keeper is Mara");
    request.selection = Some("its keeper is Ivo".into());
    assert!(retrieval::build(&db, &id, &request, &[]).is_err());
    request.scope = Some("chapter".into());
    request.chapter = Some(99);
    assert!(retrieval::build(&db, &id, &request, &[]).is_err());
}

#[test]
fn long_chapter_questions_retrieve_relevant_passages_before_sampling() {
    let (dir, paths, db) = library();
    let file = dir.path().join("long.md");
    let mut text = "# Long chapter\n\n".to_string();
    for i in 0..300 {
        if i == 173 { text.push_str("The secret password at the observatory is turquoise walrus.\n\n"); }
        else { text.push_str(&format!("Paragraph {i}: {}\n\n", "Ordinary background material without a special answer. ".repeat(25))); }
    }
    text.push_str("# Another chapter\n\nThe secret password here is crimson sparrow.\n");
    std::fs::write(&file, text).unwrap();
    let id = ingest::import_path(&db, &paths, &file).unwrap();
    let prompt = retrieval::build(&db, &id, &retrieval::AskRequest { question: "What is the secret password at the observatory?".into(), scope: Some("chapter".into()), chapter: Some(0), ..Default::default() }, &[]).unwrap();
    assert!(prompt.prompt.contains("turquoise walrus"));
    assert!(!prompt.prompt.contains("crimson sparrow"));
    assert!(prompt.prompt.len() < 62_000);
}
