//! Portable, offline snapshots. An exclusive lock prevents this version of the
//! reader or importer from modifying a library while its files are copied.
use crate::{config::Paths, db::Db};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, os::{fd::AsRawFd, unix::fs::{OpenOptionsExt, PermissionsExt}}, path::{Component, Path}};

pub fn lock(paths: &Paths, exclusive: bool) -> Result<fs::File> {
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(paths.data.join("library.lock"))?;
    let mode = if exclusive { libc::LOCK_EX } else { libc::LOCK_SH };
    // The descriptor owns the advisory lock for its entire lifetime.
    if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } != 0 {
        bail!("The library is in use. Close Kōyō and finish imports before backing it up.");
    }
    Ok(file)
}

#[derive(Serialize, Deserialize)]
struct Manifest { version: u32, files: BTreeMap<String, String> }

fn hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop { let n = file.read(&mut buffer)?; if n == 0 { break; } hash.update(&buffer[..n]); }
    Ok(hex::encode(hash.finalize()))
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() { bail!("Refusing to follow a symlink in the library: {}", entry.path().display()); }
        let target = destination.join(entry.file_name());
        if kind.is_dir() { copy_tree(&entry.path(), &target)?; }
        else if kind.is_file() { fs::copy(entry.path(), target)?; }
        else { bail!("Unsupported library file: {}", entry.path().display()); }
    }
    Ok(())
}

fn inventory(root: &Path, directory: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() { inventory(root, &entry.path(), files)?; }
        else { files.insert(entry.path().strip_prefix(root)?.to_string_lossy().into_owned(), hash(&entry.path())?); }
    }
    Ok(())
}

fn new_directory(path: &Path) -> Result<()> {
    fs::create_dir(path).context("Choose a new, nonexistent destination directory; existing libraries are never overwritten")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn create(paths: &Paths, db: &Db, destination: &Path) -> Result<()> {
    new_directory(destination)?;
    let result = (|| -> Result<()> {
        let target = fs::canonicalize(destination)?;
        if target.starts_with(fs::canonicalize(&paths.data)?) { bail!("Store backups outside the active library."); }
        db.conn().execute("VACUUM INTO ?1", [destination.join("omareader.db").to_string_lossy().as_ref()])?;
        for name in ["books", "notes", "audio"] { copy_tree(&paths.data.join(name), &destination.join(name))?; }
        let mut files = BTreeMap::new();
        inventory(destination, destination, &mut files)?;
        fs::write(destination.join("backup.json"), serde_json::to_vec_pretty(&Manifest { version: 1, files })?)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(destination); }
    result
}

pub fn restore(source: &Path, destination: &Path) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(source.join("backup.json")).context("Not an Kōyō backup")?)?;
    if manifest.version != 1 || !manifest.files.contains_key("omareader.db") { bail!("Unsupported or incomplete backup."); }
    // Check the entire inventory before creating a destination.
    for (name, digest) in &manifest.files {
        let path = Path::new(name);
        if !path.components().all(|c| matches!(c, Component::Normal(_))) { bail!("Unsafe backup path."); }
        let first = path.components().next().context("Empty backup path")?;
        if !["books", "notes", "audio", "omareader.db"].iter().any(|s| first.as_os_str() == *s) { bail!("Unexpected backup file."); }
        let mut current = source.to_path_buf();
        for component in path.components() {
            current.push(component);
            if fs::symlink_metadata(&current)?.file_type().is_symlink() { bail!("Backup contains a symlink."); }
        }
        if hash(&source.join(path))? != *digest { bail!("Backup checksum failed: {name}"); }
    }
    new_directory(destination)?;
    let result = (|| -> Result<()> {
        for (name, digest) in &manifest.files {
            let target = destination.join(name);
            fs::create_dir_all(target.parent().context("Invalid destination")?)?;
            fs::copy(source.join(name), &target)?;
            if hash(&target)? != *digest { bail!("Backup changed during restore: {name}"); }
        }
        let paths = Paths::at(destination.to_path_buf())?;
        let db = Db::open(&paths.db)?;
        let integrity: String = db.conn().query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" { bail!("Restored database failed integrity check: {integrity}"); }
        // Never send restored notes into an absolute directory on the old machine.
        db.conn().execute("DELETE FROM settings WHERE key='notes_dir'", [])?;
        let ids: Vec<String> = {
            let conn = db.conn();
            let mut stmt = conn.prepare("SELECT id FROM books")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for id in ids { crate::notes::mirror_book(&db, &paths, &id)?; }
        crate::notes::mirror_loose_notes(&db, &paths)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(destination); }
    result
}
