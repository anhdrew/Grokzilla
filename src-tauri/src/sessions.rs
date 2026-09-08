use crate::grok::grok_home;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub model: Option<String>,
    pub updated_at: Option<String>,
    pub created_at: Option<String>,
    pub message_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub cwd: String,
    pub name: String,
    pub thread_count: usize,
}

pub fn sessions_root() -> PathBuf {
    grok_home().join("sessions")
}

pub fn list_threads() -> Result<Vec<ThreadInfo>, String> {
    let root = sessions_root();
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut threads = Vec::new();
    let groups = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for group in groups.flatten() {
        let group_path = group.path();
        if !group_path.is_dir() {
            continue;
        }
        let group_cwd = cwd_for_group(&group_path);
        let sessions = match fs::read_dir(&group_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for entry in sessions.flatten() {
            let session_path = entry.path();
            if !session_path.is_dir() {
                continue;
            }
            let summary_path = session_path.join("summary.json");
            if !summary_path.is_file() {
                continue;
            }
            if let Some(thread) = parse_summary(&summary_path, group_cwd.as_deref()) {
                threads.push(thread);
            }
        }
    }

    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(threads)
}

pub fn projects_from(threads: &[ThreadInfo]) -> Vec<ProjectInfo> {
    let mut map: Vec<ProjectInfo> = Vec::new();
    for thread in threads {
        if let Some(existing) = map.iter_mut().find(|p| p.cwd == thread.cwd) {
            existing.thread_count += 1;
            continue;
        }
        map.push(ProjectInfo {
            name: project_name(&thread.cwd),
            cwd: thread.cwd.clone(),
            thread_count: 1,
        });
    }
    map.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    map
}

pub fn hydrate_updates(session_id: &str, cwd: &str) -> Result<Vec<Value>, String> {
    let path = find_session_dir(cwd, session_id).join("updates.jsonl");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut updates = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(update) = value
            .get("params")
            .and_then(|p| p.get("update"))
            .cloned()
            .or_else(|| value.get("update").cloned())
        {
            updates.push(update);
        }
    }
    Ok(updates)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStats {
    pub context_percent: Option<u64>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub turn_count: Option<u64>,
    pub tool_calls: Option<u64>,
    pub user_messages: Option<u64>,
    pub assistant_messages: Option<u64>,
}

pub fn thread_stats(session_id: &str, cwd: &str) -> Result<ThreadStats, String> {
    if !is_safe_session_id(session_id) {
        return Err("invalid session id".into());
    }
    let path = find_session_dir(cwd, session_id).join("signals.json");
    if !path.is_file() {
        return Ok(ThreadStats::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(stats_from_signals(&value))
}

fn stats_from_signals(value: &Value) -> ThreadStats {
    let num = |key: &str| value.get(key).and_then(Value::as_u64);
    let percent = value
        .get("contextWindowUsage")
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n.round() as u64)));
    ThreadStats {
        context_percent: percent,
        context_tokens: num("contextTokensUsed"),
        context_window: num("contextWindowTokens"),
        turn_count: num("turnCount"),
        tool_calls: num("toolCallCount"),
        user_messages: num("userMessageCount"),
        assistant_messages: num("assistantMessageCount"),
    }
}

pub fn delete_thread(session_id: &str, cwd: &str) -> Result<(), String> {
    if !is_safe_session_id(session_id) {
        return Err("invalid session id".into());
    }
    let path = find_session_dir(cwd, session_id);
    if !path.is_dir() {
        return Err("thread not found".into());
    }
    let root = sessions_root()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let canon = path.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("invalid session path".into());
    }
    if !canon.join("summary.json").is_file() {
        return Err("not a grok session".into());
    }
    fs::remove_dir_all(&canon).map_err(|e| e.to_string())?;
    Ok(())
}

fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn find_session_dir(cwd: &str, session_id: &str) -> PathBuf {
    let encoded = sessions_root().join(encode_cwd(cwd)).join(session_id);
    if encoded.is_dir() {
        return encoded;
    }
    if let Ok(groups) = fs::read_dir(sessions_root()) {
        for group in groups.flatten() {
            let candidate = group.path().join(session_id);
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    encoded
}

fn parse_summary(path: &Path, fallback_cwd: Option<&str>) -> Option<ThreadInfo> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let info = value.get("info");
    let session_id = info
        .and_then(|i| i.get("id"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
        })?;
    let cwd = info
        .and_then(|i| i.get("cwd"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| fallback_cwd.map(|s| s.to_string()))
        .unwrap_or_else(|| String::from("unknown"));
    let cwd = cwd.trim_end_matches('/').to_string();

    let title = value
        .get("generated_title")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let summary = value
        .get("session_summary")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    Some(ThreadInfo {
        session_id,
        cwd,
        title,
        summary,
        model: value
            .get("current_model_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
        updated_at: value
            .get("updated_at")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| {
                value
                    .get("last_active_at")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            }),
        created_at: value
            .get("created_at")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
        message_count: value.get("num_messages").and_then(Value::as_u64),
    })
}

fn cwd_for_group(group: &Path) -> Option<String> {
    let marker = group.join(".cwd");
    if marker.is_file() {
        if let Ok(text) = fs::read_to_string(marker) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    group
        .file_name()
        .map(|n| percent_decode(&n.to_string_lossy()))
}

pub fn encode_cwd(cwd: &str) -> String {
    let mut out = String::new();
    for b in cwd.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &input[i + 1..i + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn project_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd.to_string())
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_encoded_cwd() {
        assert_eq!(
            percent_decode("%2FUsers%2Fanh%2FDesktop%2FGrokBuildGUI"),
            "/Users/anh/Desktop/GrokBuildGUI"
        );
    }

    #[test]
    fn encodes_slash_cwd() {
        assert_eq!(
            super::encode_cwd("/Users/anh/Desktop/GrokBuildGUI"),
            "%2FUsers%2Fanh%2FDesktop%2FGrokBuildGUI"
        );
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(!super::is_safe_session_id("../etc"));
        assert!(!super::is_safe_session_id("a/b"));
        assert!(super::is_safe_session_id("01a07ece-f6f9-7d61-930f-cc789f20cae6"));
    }

    #[test]
    fn reads_context_stats_from_signals() {
        let value = serde_json::json!({
            "contextWindowUsage": 76,
            "contextTokensUsed": 384803,
            "contextWindowTokens": 500000,
            "turnCount": 8,
            "toolCallCount": 378,
            "userMessageCount": 8,
            "assistantMessageCount": 190
        });
        let stats = super::stats_from_signals(&value);
        assert_eq!(stats.context_percent, Some(76));
        assert_eq!(stats.context_tokens, Some(384803));
        assert_eq!(stats.turn_count, Some(8));
        assert_eq!(stats.tool_calls, Some(378));
    }
}
