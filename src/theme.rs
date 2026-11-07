//! Reads the active Omarchy theme, so the app can follow `omarchy theme set` live.

use crate::tts::Events;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

fn state_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(base.join("omarchy/current"))
}

/// Theme files are flat `key = "#rrggbb"` lines, so nested sections are never needed.
fn parse_colors(text: &str) -> Map<String, Value> {
    let mut colors = Map::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim().trim_matches('"');
        let hex = value.strip_prefix('#').is_some_and(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()));
        if hex {
            colors.insert(key.trim().to_string(), json!(value));
        }
    }
    colors
}

pub fn current() -> Value {
    let Some(dir) = state_dir() else { return json!({"name": null, "colors": {}}) };
    let name = std::fs::read_to_string(dir.join("theme.name")).ok().map(|n| n.trim().to_string());
    let colors = std::fs::read_to_string(dir.join("theme/colors.toml")).map(|t| parse_colors(&t)).unwrap_or_default();
    json!({"name": name, "colors": colors})
}

fn stamp() -> Option<SystemTime> {
    std::fs::metadata(state_dir()?.join("theme.name")).and_then(|m| m.modified()).ok()
}

/// Omarchy rewrites `theme.name` on every switch, so its timestamp is the signal.
pub async fn watch(events: Events) {
    let mut last = stamp();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let now = stamp();
        if now != last {
            last = now;
            let _ = events.send(json!({"type": "theme"}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_colors;

    #[test]
    fn reads_flat_hex_keys_and_skips_the_rest() {
        let colors = parse_colors("# note\nmode = \"dark\"\naccent = \"#c9a46a\"\nhyprland_active_border = \"rgba(8b8b7e66)\"\n");
        assert_eq!(colors.len(), 1);
        assert_eq!(colors["accent"], "#c9a46a");
    }
}
