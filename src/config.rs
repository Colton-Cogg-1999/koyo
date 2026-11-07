use anyhow::{Context, Result};
use rand::RngCore;
use std::fs;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Everything OmaReader owns lives under one directory, so backing up or syncing
/// that directory is a complete backup of the library, notes and audio.
#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub books: PathBuf,
    pub audio: PathBuf,
    pub models: PathBuf,
    pub notes: PathBuf,
    pub tmp: PathBuf,
    pub ai_cwd: PathBuf,
    pub db: PathBuf,
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let data = match std::env::var_os("OMAREADER_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => {
                let base = std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
                    .context("neither XDG_DATA_HOME nor HOME is set")?;
                base.join("omareader")
            }
        };
        Self::at(data)
    }

    pub fn at(data: PathBuf) -> Result<Self> {
        let paths = Paths {
            books: data.join("books"),
            audio: data.join("audio"),
            models: data.join("models"),
            notes: data.join("notes"),
            tmp: data.join("tmp"),
            ai_cwd: data.join("ai-workspace"),
            db: data.join("omareader.db"),
            data,
        };
        for dir in [&paths.data, &paths.books, &paths.audio, &paths.models, &paths.notes, &paths.tmp, &paths.ai_cwd] {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        fs::set_permissions(&paths.data, fs::Permissions::from_mode(0o700))?;
        Ok(paths)
    }

    pub fn book_dir(&self, id: &str) -> PathBuf {
        self.books.join(id)
    }

    pub fn audio_dir(&self, id: &str) -> PathBuf {
        self.audio.join(id)
    }
}

/// Stable per-install token. The window URL carries it once, and it becomes an
/// HttpOnly cookie, so other local users and web pages cannot reach the API.
pub fn session_token(paths: &Paths) -> Result<String> {
    let file = paths.data.join("session-token");
    if let Ok(existing) = fs::read_to_string(&file) {
        let existing = existing.trim();
        if existing.len() == 64 {
            return Ok(existing.to_string());
        }
    }
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    write_private(&file, token.as_bytes())?;
    Ok(token)
}

fn write_private(path: &Path, content: &[u8]) -> Result<()> {
    let _ = fs::remove_file(path);
    let mut file = fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(path)?;
    file.write_all(content)?;
    Ok(())
}
