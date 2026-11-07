use super::{find_binary, AiEvent, ModelOption, ProviderStatus, Turn};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Variables that make a nested `claude` behave like a child of the current session.
fn clean(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("CLAUDE") {
            command.env_remove(key);
        }
    }
}

pub async fn run(cwd: &Path, turn: Turn, tx: &mpsc::Sender<AiEvent>) -> Result<()> {
    let binary = find_binary("claude").context("Claude Code isn't installed.")?;
    let mut command = Command::new(binary);
    command
        .args(["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"])
        .args(["--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", ""])
        .arg("--disable-slash-commands")
        .args(["--system-prompt", &turn.system]);
    if let Some(model) = turn.model.as_deref().filter(|m| !m.is_empty()) {
        command.args(["--model", model]);
    }
    clean(&mut command);
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("could not start Claude Code")?;

    let mut stdin = child.stdin.take().context("no stdin")?;
    let prompt = turn.prompt;
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let mut stderr = child.stderr.take().context("no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let mut lines = BufReader::new(child.stdout.take().context("no stdout")?).lines();
    let mut failure: Option<String> = None;
    let mut saw_text = false;
    while let Some(line) = lines.next_line().await? {
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        match event["type"].as_str() {
            Some("stream_event") => {
                let delta = &event["event"]["delta"];
                if delta["type"] == "text_delta" {
                    if let Some(text) = delta["text"].as_str() {
                        saw_text = true;
                        if tx.send(AiEvent::Delta(text.to_string())).await.is_err() {
                            return Ok(());
                        }
                    }
                }
            }
            Some("result") => {
                if event["is_error"].as_bool() == Some(true) {
                    failure = Some(event["result"].as_str().unwrap_or("Claude Code reported an error.").to_string());
                }
            }
            _ => {}
        }
    }
    let status = child.wait().await?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    if let Some(message) = failure {
        return Err(anyhow!(friendly(&message)));
    }
    if !status.success() {
        bail!("{}", friendly(stderr_text.trim()));
    }
    if !saw_text {
        bail!("Claude Code returned an empty answer.");
    }
    Ok(())
}

fn friendly(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("not logged in") || lower.contains("/login") || lower.contains("invalid api key") {
        return "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again.".into();
    }
    if lower.contains("usage limit") || lower.contains("limit reached") || lower.contains("rate limit") {
        return format!("Your Claude subscription hit its usage limit. {message}");
    }
    if message.is_empty() { "Claude Code stopped unexpectedly.".into() } else { message.to_string() }
}

pub async fn status(cwd: &Path) -> ProviderStatus {
    let models = [("", "Default"), ("haiku", "Haiku (fastest)"), ("sonnet", "Sonnet"), ("opus", "Opus (deepest)")]
        .map(|(id, label)| ModelOption { id: id.into(), label: label.into() })
        .to_vec();
    let mut out = ProviderStatus {
        id: "claude",
        name: "Claude Code",
        installed: false,
        signed_in: false,
        plan: None,
        models,
        default_model: None,
        help: "Install Claude Code, then run `claude` once to log in.".into(),
    };
    let Some(binary) = find_binary("claude") else { return out };
    out.installed = true;
    let mut command = Command::new(binary);
    command.args(["auth", "status"]).current_dir(cwd).stdin(Stdio::null());
    clean(&mut command);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output()).await;
    if let Ok(Ok(output)) = output {
        if let Ok(info) = serde_json::from_slice::<Value>(&output.stdout) {
            out.signed_in = info["loggedIn"].as_bool().unwrap_or(false);
            out.plan = info["subscriptionType"].as_str().map(str::to_string);
        }
    }
    if out.signed_in {
        out.help = String::new();
    } else {
        out.help = "Run `claude` in a terminal and log in.".into();
    }
    out
}
