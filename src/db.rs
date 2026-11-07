use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE books(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  has_cover INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  opened_at INTEGER
);
CREATE TABLE sections(
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  first_block INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  PRIMARY KEY(book_id, idx)
) WITHOUT ROWID;
CREATE TABLE blocks(
  id INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  section INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  speech TEXT,
  start_char INTEGER NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  x REAL, y REAL, w REAL, h REAL,
  UNIQUE(book_id, seq)
);
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  text, content='blocks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER blocks_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE toc(
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  block INTEGER NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  front INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(book_id, idx)
) WITHOUT ROWID;
CREATE TABLE annotations(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  anchor TEXT NOT NULL,
  block INTEGER NOT NULL DEFAULT 0,
  page INTEGER NOT NULL DEFAULT 0,
  quote TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX annotations_book ON annotations(book_id, block);
CREATE TABLE notes(
  id TEXT PRIMARY KEY,
  book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE positions(
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  block INTEGER NOT NULL DEFAULT 0,
  fraction REAL NOT NULL DEFAULT 0,
  page INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collections(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);
CREATE TABLE collection_books(
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  PRIMARY KEY(collection_id, book_id)
) WITHOUT ROWID;
CREATE TABLE chats(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audiobooks(
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  voice TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  listen_seq INTEGER NOT NULL DEFAULT 0,
  listen_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audio_tracks(
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  chapter INTEGER NOT NULL,
  first_block INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  marks TEXT NOT NULL DEFAULT '[]',
  peaks TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(book_id, seq)
) WITHOUT ROWID;
"#, "ALTER TABLE messages ADD COLUMN context TEXT NOT NULL DEFAULT '{}';"];

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, migration) in MIGRATIONS.iter().enumerate().skip(version) {
            let tx = conn.transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", i + 1)?;
            tx.commit()?;
        }
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn setting(&self, key: &str) -> Option<Value> {
        let conn = self.conn();
        let text: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        text.and_then(|t| serde_json::from_str(&t).ok())
    }

    pub fn setting_str(&self, key: &str) -> Option<String> {
        self.setting(key).and_then(|v| v.as_str().map(str::to_string))
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> Result<serde_json::Map<String, Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key,value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (key, value) = row?;
            map.insert(key, serde_json::from_str(&value).unwrap_or(Value::Null));
        }
        Ok(map)
    }
}
