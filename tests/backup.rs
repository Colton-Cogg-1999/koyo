use omareader::{backup, config::Paths, db::Db, ingest};

#[test]
fn backup_restores_originals_notes_and_positions_without_overwriting() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::at(temp.path().join("library")).unwrap();
    let db = Db::open(&paths.db).unwrap();
    let source = temp.path().join("book.txt");
    std::fs::write(&source, "A book worth keeping.").unwrap();
    let id = ingest::import_path(&db, &paths, &source).unwrap();
    db.conn().execute("INSERT INTO notes(id,book_id,title,body,created_at,updated_at) VALUES('note',?1,'Remember','My own words',1,1)", [&id]).unwrap();
    db.conn().execute("INSERT INTO annotations(id,book_id,kind,anchor,quote,note,created_at,updated_at) VALUES('mark',?1,'highlight','{}','worth keeping','Keep this too',1,1)", [&id]).unwrap();
    db.conn().execute("INSERT INTO positions(book_id,block,fraction,progress,updated_at) VALUES(?1,0,0.4,0.4,1)", [&id]).unwrap();
    db.set_setting("notes_dir", &serde_json::json!("/not-on-this-machine")).unwrap();
    let active = backup::lock(&paths, false).unwrap();
    assert!(backup::lock(&paths, true).is_err());
    drop(active);
    let _exclusive = backup::lock(&paths, true).unwrap();
    assert!(backup::lock(&paths, false).is_err());
    let snapshot = temp.path().join("snapshot");
    backup::create(&paths, &db, &snapshot).unwrap();
    assert!(!snapshot.join("session-token").exists());
    assert!(!snapshot.join("models").exists());
    let restored = temp.path().join("restored");
    backup::restore(&snapshot, &restored).unwrap();
    let recovered = Db::open(&restored.join("omareader.db")).unwrap();
    assert_eq!(recovered.conn().query_row("SELECT body FROM notes WHERE id='note'", [], |r| r.get::<_, String>(0)).unwrap(), "My own words");
    assert_eq!(recovered.conn().query_row("SELECT note FROM annotations WHERE id='mark'", [], |r| r.get::<_, String>(0)).unwrap(), "Keep this too");
    assert_eq!(recovered.conn().query_row("SELECT fraction FROM positions", [], |r| r.get::<_, f64>(0)).unwrap(), 0.4);
    assert!(recovered.setting_str("notes_dir").is_none());
    assert_eq!(std::fs::read(restored.join("books").join(&id).join("original.txt")).unwrap(), std::fs::read(&source).unwrap());
    assert!(backup::restore(&snapshot, &restored).is_err());
    std::fs::write(snapshot.join("books").join(&id).join("original.txt"), "Damaged backup").unwrap();
    let rejected = temp.path().join("rejected");
    assert!(backup::restore(&snapshot, &rejected).unwrap_err().to_string().contains("checksum"));
    assert!(!rejected.exists());
}

#[test]
fn backup_rejects_symlinks_and_nested_destinations() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::at(temp.path().join("library")).unwrap();
    let db = Db::open(&paths.db).unwrap();
    assert!(backup::create(&paths, &db, &paths.data.join("nested")).is_err());
    assert!(!paths.data.join("nested").exists());
    std::os::unix::fs::symlink("/etc", paths.books.join("outside")).unwrap();
    let snapshot = temp.path().join("snapshot");
    assert!(backup::create(&paths, &db, &snapshot).is_err());
    assert!(!snapshot.exists());
}
