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
