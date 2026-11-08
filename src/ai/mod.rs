//! Uses the reader's own subscription by running the official CLIs they are already logged
//! in to. Kōyō never reads or stores a credential. Book text is untrusted input, so
//! both providers run with every tool disabled, in an empty working directory.

pub mod claude;
pub mod codex;

use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

pub struct Turn {
    pub system: String,
    pub prompt: String,
    pub model: Option<String>,
}

pub enum AiEvent {
    Delta(String),
    Failed(String),
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
    pub signed_in: bool,
    pub plan: Option<String>,
    pub models: Vec<ModelOption>,
    pub default_model: Option<String>,
    pub help: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

/// Desktop launchers often get a smaller PATH than a shell, so the usual per-user
/// install locations are checked as well.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.push(home.join(format!(".local/share/mise/installs/{name}/latest")));
    dirs.push(home.join(format!(".local/share/mise/installs/{name}/latest/bin")));
    dirs.push(home.join(".local/share/mise/shims"));
    dirs.push(home.join(".local/bin"));
    dirs.push(home.join(".npm-global/bin"));
    dirs.push(home.join(".claude/local"));
    dirs.push(home.join(".bun/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.into_iter().map(|d| d.join(name)).find(|p| is_executable(p))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub async fn run(provider: &str, cwd: &Path, turn: Turn, tx: mpsc::Sender<AiEvent>) {
    let result = match provider {
        "codex" => codex::run(cwd, turn, &tx).await,
        _ => claude::run(cwd, turn, &tx).await,
    };
    if let Err(error) = result {
        let _ = tx.send(AiEvent::Failed(format!("{error:#}"))).await;
    }
}

pub async fn statuses(cwd: &Path) -> Vec<ProviderStatus> {
    let (claude, codex) = tokio::join!(claude::status(cwd), codex::status(cwd));
    vec![claude, codex]
}
