use crate::grok::grok_home;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const TOOL_PREVIEW_LIMIT: usize = 4096;

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
    pub headless: bool,
    pub watch_status: String,
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
    list_threads_in(&sessions_root())
}

fn list_threads_in(root: &Path) -> Result<Vec<ThreadInfo>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut threads = Vec::new();
    let groups = fs::read_dir(root).map_err(|e| e.to_string())?;
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
            let Some(mut thread) = parse_summary(&summary_path, group_cwd.as_deref()) else {
                continue;
            };
            if is_subagent_session(&session_path) {
                continue;
            }
            thread.headless = is_non_interactive_session(&session_path);
            thread.watch_status = watch_status(&session_path);
            threads.push(thread);
        }
    }

    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(threads)
}

pub fn find_thread(session_id: &str) -> Result<ThreadInfo, String> {
    find_thread_in(&sessions_root(), session_id)
}

fn find_thread_in(root: &Path, session_id: &str) -> Result<ThreadInfo, String> {
    let id = session_id.trim();
    if !is_safe_session_id(id) {
        return Err("invalid session id".into());
    }
    let dir = find_session_dir_in(root, "", id);
    let summary = dir.join("summary.json");
    if !summary.is_file() {
        return Err(format!("session {id} was not found"));
    }
    let group_cwd = dir.parent().and_then(cwd_for_group);
    let Some(mut thread) = parse_summary(&summary, group_cwd.as_deref()) else {
        return Err(format!("session {id} was not found"));
    };
    if is_subagent_session(&dir) {
        return Err(format!("session {id} was not found"));
    }
    thread.headless = is_non_interactive_session(&dir);
    thread.watch_status = watch_status(&dir);
    Ok(thread)
}

const ATTACH_FOREIGN_ERR: &str =
    "This is a grok -p / subagent session. Grokzilla watches it read-only and will not attach.";
const ATTACH_LIVE_ERR: &str =
    "This session is already running in another Grok process. Grokzilla will not attach.";
const LIVE_FOREIGN_ERR: &str =
    "This grok -p session is still running. Grokzilla will not attach or delete it.";

pub fn reject_non_interactive(session_id: &str, cwd: &str) -> Result<(), String> {
    reject_non_interactive_in(&sessions_root(), session_id, cwd)
}

fn reject_non_interactive_in(root: &Path, session_id: &str, cwd: &str) -> Result<(), String> {
    let dir = find_session_dir_in(root, cwd, session_id);
    if is_non_interactive_session(&dir) {
        return Err(ATTACH_FOREIGN_ERR.into());
    }
    Ok(())
}

pub fn reject_live_owner(session_id: &str, cwd: &str) -> Result<(), String> {
    reject_live_owner_in(
        &sessions_root(),
        &active_sessions_path(),
        session_id,
        cwd,
    )
}

fn reject_live_owner_in(
    root: &Path,
    active_path: &Path,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    reject_non_interactive_in(root, session_id, cwd)?;
    if let Some(pid) = live_owner_pid_from(active_path, session_id) {
        if pid_is_alive(pid) {
            return Err(ATTACH_LIVE_ERR.into());
        }
    }
    Ok(())
}

pub fn reject_live_headless(session_id: &str, cwd: &str) -> Result<(), String> {
    let dir = find_session_dir(cwd, session_id);
    if is_non_interactive_session(&dir)
        && (watch_status(&dir) == "running" || session_has_live_owner(session_id))
    {
        return Err(LIVE_FOREIGN_ERR.into());
    }
    Ok(())
}

fn watch_status(session_dir: &Path) -> String {
    let updates = session_dir.join("updates.jsonl");
    let kind = last_update_kind(&updates);
    if matches!(kind.as_deref(), Some("turn_completed") | Some("task_completed")) {
        return "done".into();
    }
    if file_is_fresh(&updates, Duration::from_secs(20))
        || file_is_fresh(&session_dir.join("summary.json"), Duration::from_secs(20))
    {
        return "running".into();
    }
    if kind.as_deref() == Some("error") {
        return "error".into();
    }
    "done".into()
}

fn file_is_fresh(path: &Path, max_age: Duration) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age <= max_age)
        .unwrap_or(false)
}

fn last_update_kind(path: &Path) -> Option<String> {
    let line = last_nonempty_line(path)?;
    let value: Value = serde_json::from_str(&line).ok()?;
    let update = value
        .get("params")
        .and_then(|params| params.get("update"))
        .cloned()
        .or_else(|| value.get("update").cloned())?;
    update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .map(|kind| kind.to_string())
}

fn last_nonempty_line(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.seek(SeekFrom::End(0)).ok()?;
    let start = len.saturating_sub(64 * 1024);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    buf.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn session_kind(session_dir: &Path) -> Option<String> {
    let text = fs::read_to_string(session_dir.join("summary.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("session_kind")
        .and_then(Value::as_str)
        .map(|kind| kind.to_ascii_lowercase())
}

fn is_foreign_kind(kind: &str) -> bool {
    matches!(
        kind,
        "headless"
            | "single"
            | "non_interactive"
            | "non-interactive"
            | "subagent"
            | "subagent_resume"
    )
}

fn is_subagent_kind(kind: &str) -> bool {
    matches!(kind, "subagent" | "subagent_resume")
}

fn is_subagent_session(session_dir: &Path) -> bool {
    session_kind(session_dir).is_some_and(|kind| is_subagent_kind(&kind))
}

fn is_non_interactive_session(session_dir: &Path) -> bool {
    if session_kind(session_dir).is_some_and(|kind| is_foreign_kind(&kind)) {
        return true;
    }
    let Ok(text) = fs::read_to_string(session_dir.join("prompt_context.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    if value.get("is_non_interactive") == Some(&Value::Bool(true)) {
        return true;
    }
    value
        .get("audience")
        .and_then(Value::as_str)
        .is_some_and(|audience| {
            audience.eq_ignore_ascii_case("headless") || audience.eq_ignore_ascii_case("subagent")
        })
}

fn active_sessions_path() -> PathBuf {
    grok_home().join("active_sessions.json")
}

fn session_has_live_owner(session_id: &str) -> bool {
    live_owner_pid_from(&active_sessions_path(), session_id).is_some_and(pid_is_alive)
}

fn live_owner_pid_from(path: &Path, session_id: &str) -> Option<u32> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let rows = value.as_array()?;
    for row in rows {
        let id = row
            .get("session_id")
            .or_else(|| row.get("sessionId"))
            .and_then(Value::as_str)?;
        if id != session_id {
            continue;
        }
        let pid = row.get("pid").and_then(Value::as_u64)?;
        if pid > 0 && pid <= u32::MAX as u64 {
            return Some(pid as u32);
        }
    }
    None
}

fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let raw = pid as i32;
        if raw <= 0 {
            return false;
        }
        let rc = unsafe { libc::kill(raw, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDoc {
    pub path: String,
    pub markdown: String,
    pub exists: bool,
}

pub fn read_plan(session_id: &str, cwd: &str) -> Result<PlanDoc, String> {
    if !is_safe_session_id(session_id) {
        return Err("invalid session id".into());
    }
    let path = find_session_dir(cwd, session_id).join("plan.md");
    if !path.is_file() {
        return Ok(PlanDoc {
            path: path.display().to_string(),
            markdown: String::new(),
            exists: false,
        });
    }
    let markdown = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(PlanDoc {
        path: path.display().to_string(),
        markdown,
        exists: true,
    })
}

pub fn write_plan(session_id: &str, cwd: &str, markdown: &str) -> Result<PlanDoc, String> {
    reject_non_interactive(session_id, cwd)?;
    write_plan_in(&sessions_root(), session_id, cwd, markdown)
}

fn write_plan_in(root: &Path, session_id: &str, cwd: &str, markdown: &str) -> Result<PlanDoc, String> {
    if !is_safe_session_id(session_id) {
        return Err("invalid session id".into());
    }
    let dir = find_session_dir_in(root, cwd, session_id);
    if !dir.is_dir() {
        return Err("session directory not found".into());
    }
    let path = dir.join("plan.md");
    fs::write(&path, markdown).map_err(|e| e.to_string())?;
    Ok(PlanDoc {
        path: path.display().to_string(),
        markdown: markdown.to_string(),
        exists: true,
    })
}

pub fn hydrate_updates(session_id: &str, cwd: &str) -> Result<Vec<Value>, String> {
    Ok(compact_updates(read_raw_updates(session_id, cwd)?))
}

pub fn load_tool_body(session_id: &str, cwd: &str, tool_call_id: &str) -> Result<Value, String> {
    if !is_safe_session_id(session_id) {
        return Err("invalid session id".into());
    }
    let mut found = json!({});
    for update in read_raw_updates(session_id, cwd)? {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        if kind != "tool_call" && kind != "tool_call_update" {
            continue;
        }
        if update.get("toolCallId").and_then(Value::as_str) != Some(tool_call_id) {
            continue;
        }
        merge_json(&mut found, &update);
    }
    Ok(json!({
        "input": found.get("rawInput").cloned().unwrap_or(Value::Null),
        "output": found.get("rawOutput").cloned().unwrap_or(Value::Null),
        "content": found.get("content").cloned().unwrap_or(Value::Null),
    }))
}

fn read_raw_updates(session_id: &str, cwd: &str) -> Result<Vec<Value>, String> {
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

fn is_text_kind(kind: &str) -> bool {
    matches!(
        kind,
        "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"
    )
}

fn ignored_kind(kind: &str) -> bool {
    matches!(kind, "task_backgrounded")
}

pub fn compact_updates(updates: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut tool_index: HashMap<String, usize> = HashMap::new();
    for update in updates {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind.is_empty() || ignored_kind(kind) {
            continue;
        }
        if is_text_kind(kind) {
            if let Some(last) = out.last_mut() {
                if last.get("sessionUpdate").and_then(Value::as_str) == Some(kind) {
                    concat_update_text(last, &update);
                    continue;
                }
            }
            out.push(update);
            continue;
        }
        if kind == "tool_call" || kind == "tool_call_update" {
            let id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !id.is_empty() {
                if let Some(&idx) = tool_index.get(&id) {
                    merge_json(&mut out[idx], &update);
                    truncate_tool(&mut out[idx]);
                    continue;
                }
                tool_index.insert(id, out.len());
            }
            let mut next = update;
            truncate_tool(&mut next);
            out.push(next);
            continue;
        }
        out.push(update);
    }
    out
}

fn concat_update_text(dst: &mut Value, src: &Value) {
    let extra = src
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .or_else(|| src.get("text").and_then(Value::as_str))
        .unwrap_or("");
    if extra.is_empty() {
        return;
    }
    let Some(obj) = dst.as_object_mut() else {
        return;
    };
    if let Some(content) = obj.get_mut("content") {
        if let Some(map) = content.as_object_mut() {
            if let Some(Value::String(text)) = map.get_mut("text") {
                text.push_str(extra);
                return;
            }
        }
    }
    if let Some(Value::String(text)) = obj.get_mut("text") {
        text.push_str(extra);
    }
}

fn merge_json(dst: &mut Value, src: &Value) {
    let Some(src_obj) = src.as_object() else {
        *dst = src.clone();
        return;
    };
    let Some(dst_obj) = dst.as_object_mut() else {
        *dst = src.clone();
        return;
    };
    for (key, value) in src_obj {
        if value.is_null() {
            continue;
        }
        dst_obj.insert(key.clone(), value.clone());
    }
}

fn truncate_tool(update: &mut Value) {
    let mut clipped = false;
    if let Some(value) = update.get_mut("rawInput") {
        clipped |= truncate_value(value, TOOL_PREVIEW_LIMIT);
    }
    if let Some(value) = update.get_mut("rawOutput") {
        clipped |= truncate_value(value, TOOL_PREVIEW_LIMIT);
    }
    if let Some(value) = update.get_mut("content") {
        clipped |= truncate_value(value, TOOL_PREVIEW_LIMIT);
    }
    if clipped {
        if let Some(obj) = update.as_object_mut() {
            obj.insert("truncated".into(), Value::Bool(true));
        }
    }
}

fn truncate_value(value: &mut Value, limit: usize) -> bool {
    match value {
        Value::String(text) if text.len() > limit => {
            let mut end = limit.min(text.len());
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push('…');
            true
        }
        Value::Array(items) => items.iter_mut().any(|item| truncate_value(item, limit)),
        Value::Object(map) => map.values_mut().any(|item| truncate_value(item, limit)),
        _ => false,
    }
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
    find_session_dir_in(&sessions_root(), cwd, session_id)
}

const CHAT_MEDIA_LIMIT: u64 = 16 * 1024 * 1024;

pub fn read_chat_media(session_id: &str, cwd: &str, src: &str) -> Result<Value, String> {
    read_chat_media_in(&sessions_root(), session_id, cwd, src)
}

fn read_chat_media_in(root: &Path, session_id: &str, cwd: &str, src: &str) -> Result<Value, String> {
    if !is_safe_session_id(session_id) {
        return Err("invalid session id".into());
    }
    let path = resolve_chat_media_path(root, session_id, cwd, src)?;
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > CHAT_MEDIA_LIMIT {
        return Err("Media is larger than 16 MB".into());
    }
    let mime = media_mime(&path).ok_or_else(|| "unsupported media type".to_string())?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let kind = if mime.starts_with("video/") {
        "video"
    } else {
        "image"
    };
    Ok(json!({
        "kind": kind,
        "content": format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        "path": path.display().to_string(),
        "size": size,
    }))
}

fn resolve_chat_media_path(
    root: &Path,
    session_id: &str,
    cwd: &str,
    src: &str,
) -> Result<PathBuf, String> {
    let cleaned = normalize_media_src(src)?;
    if media_mime(Path::new(&cleaned)).is_none() {
        return Err("unsupported media type".into());
    }
    let session_dir = find_session_dir_in(root, cwd, session_id);
    let session_root = fs::canonicalize(&session_dir).ok();
    let workspace_root = fs::canonicalize(cwd).ok();

    let relative = Path::new(&cleaned);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if relative.is_absolute() {
        candidates.push(PathBuf::from(&cleaned));
    } else {
        let rel = cleaned.trim_start_matches("./");
        if is_session_media_rel(rel) {
            candidates.push(session_dir.join(rel));
        }
        candidates.push(PathBuf::from(cwd).join(rel));
        candidates.push(session_dir.join(rel));
    }

    let mut last_err = "media file not found".to_string();
    for candidate in candidates {
        match fs::canonicalize(&candidate) {
            Ok(resolved) => {
                if !resolved.is_file() {
                    last_err = "not a file".into();
                    continue;
                }
                let in_session = session_root
                    .as_ref()
                    .map(|root| resolved.starts_with(root))
                    .unwrap_or(false);
                let in_workspace = workspace_root
                    .as_ref()
                    .map(|root| resolved.starts_with(root))
                    .unwrap_or(false);
                if !in_session && !in_workspace {
                    last_err = "File is outside this session and workspace".into();
                    continue;
                }
                if media_mime(&resolved).is_none() {
                    last_err = "unsupported media type".into();
                    continue;
                }
                return Ok(resolved);
            }
            Err(err) => last_err = err.to_string(),
        }
    }
    Err(last_err)
}

fn is_session_media_rel(src: &str) -> bool {
    let s = src.trim_start_matches("./");
    s == "images"
        || s == "videos"
        || s.starts_with("images/")
        || s.starts_with("videos/")
}

fn normalize_media_src(src: &str) -> Result<String, String> {
    let mut s = src.trim().to_string();
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        let wrap = (bytes[0] == b'<' && bytes[s.len() - 1] == b'>')
            || (bytes[0] == b'"' && bytes[s.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[s.len() - 1] == b'\'');
        if wrap {
            s = s[1..s.len() - 1].trim().to_string();
        }
    }
    if s.is_empty() {
        return Err("empty media src".into());
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("asset:")
        || lower.starts_with("tauri:")
    {
        return Err("remote media src".into());
    }
    if let Some(rest) = lower
        .strip_prefix("file://")
        .map(|_| s.split_at(7).1.to_string())
    {
        let rest = rest.trim_start_matches("//");
        let rest = rest
            .strip_prefix("localhost")
            .unwrap_or(&rest)
            .to_string();
        s = if rest.starts_with('/') {
            rest
        } else {
            format!("/{rest}")
        };
    }
    s = percent_decode(&s);
    if let Some(idx) = s.find(['?', '#']) {
        if !Path::new(&s).is_absolute() {
            s = s[..idx].to_string();
        }
    }
    if s.is_empty() || s.contains('\0') {
        return Err("invalid media src".into());
    }
    Ok(s)
}

fn media_mime(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => return None,
    })
}

fn find_session_dir_in(root: &Path, cwd: &str, session_id: &str) -> PathBuf {
    let encoded = root.join(encode_cwd(cwd)).join(session_id);
    if encoded.is_dir() {
        return encoded;
    }
    if let Ok(groups) = fs::read_dir(root) {
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
        headless: false,
        watch_status: "done".into(),
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
    use std::fs;

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
    fn skips_grok_p_headless_sessions() {
        let root = std::env::temp_dir().join(format!("gz-ni-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let group = root.join("proj");
        let interactive = group.join("sesslive");
        let headless = group.join("sesshead");
        fs::create_dir_all(&interactive).unwrap();
        fs::create_dir_all(&headless).unwrap();
        fs::write(group.join(".cwd"), "/tmp/demo").unwrap();
        let summary = |id: &str| {
            format!(
                r#"{{"info":{{"id":"{id}","cwd":"/tmp/demo"}},"generated_title":"{id}","updated_at":"2026-01-01T00:00:00Z"}}"#
            )
        };
        fs::write(interactive.join("summary.json"), summary("sesslive")).unwrap();
        fs::write(headless.join("summary.json"), summary("sesshead")).unwrap();
        fs::write(
            interactive.join("prompt_context.json"),
            r#"{"is_non_interactive":false}"#,
        )
        .unwrap();
        fs::write(
            headless.join("prompt_context.json"),
            r#"{"is_non_interactive":true}"#,
        )
        .unwrap();
        fs::write(
            headless.join("updates.jsonl"),
            "{\"params\":{\"update\":{\"sessionUpdate\":\"turn_completed\"}}}\n",
        )
        .unwrap();
        let threads = super::list_threads_in(&root).unwrap();
        let live = threads.iter().find(|t| t.session_id == "sesslive").unwrap();
        let head = threads.iter().find(|t| t.session_id == "sesshead").unwrap();
        assert!(!live.headless);
        assert!(head.headless);
        assert_eq!(head.watch_status, "done");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watch_status_is_done_after_turn_completed() {
        let dir = std::env::temp_dir().join(format!("gz-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("updates.jsonl"),
            "{\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\"}}}\n{\"params\":{\"update\":{\"sessionUpdate\":\"turn_completed\"}}}\n",
        )
        .unwrap();
        fs::write(dir.join("summary.json"), "{}").unwrap();
        assert_eq!(super::watch_status(&dir), "done");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn treats_headless_session_kind_as_non_interactive() {
        let root = std::env::temp_dir().join(format!("gz-hk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("proj").join("sesshead");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"info":{"id":"sesshead","cwd":"/tmp/demo"},"session_kind":"headless"}"#,
        )
        .unwrap();
        assert!(super::is_non_interactive_session(&dir));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn treats_subagent_session_kind_as_non_interactive() {
        let root = std::env::temp_dir().join(format!("gz-sk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("proj").join("sesschild");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"info":{"id":"sesschild","cwd":"/tmp/demo"},"session_kind":"subagent"}"#,
        )
        .unwrap();
        assert!(super::is_non_interactive_session(&dir));
        assert!(super::is_subagent_session(&dir));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hides_subagent_sessions_from_the_sidebar() {
        let root = std::env::temp_dir().join(format!("gz-hide-sub-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let group = root.join("proj");
        let parent = group.join("sessparent");
        let child = group.join("sesschild");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&child).unwrap();
        fs::write(group.join(".cwd"), "/tmp/demo").unwrap();
        fs::write(
            parent.join("summary.json"),
            r#"{"info":{"id":"sessparent","cwd":"/tmp/demo"},"session_kind":"headless","updated_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            child.join("summary.json"),
            r#"{"info":{"id":"sesschild","cwd":"/tmp/demo"},"session_kind":"subagent","updated_at":"2026-01-01T00:00:01Z"}"#,
        )
        .unwrap();
        let threads = super::list_threads_in(&root).unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].session_id, "sessparent");
        assert!(threads[0].headless);
        assert!(super::find_thread_in(&root, "sesschild").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_attach_when_another_live_pid_owns_the_session() {
        let root = std::env::temp_dir().join(format!("gz-live-root-{}", std::process::id()));
        let active = std::env::temp_dir().join(format!("gz-live-active-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&active);
        let dir = root.join("proj").join("sesslive");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"info":{"id":"sesslive","cwd":"/tmp/demo"},"generated_title":"live"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("prompt_context.json"),
            r#"{"is_non_interactive":false,"audience":"primary"}"#,
        )
        .unwrap();
        let pid = std::process::id();
        fs::write(
            &active,
            format!(r#"[{{"session_id":"sesslive","pid":{pid},"cwd":"/tmp/demo"}}]"#),
        )
        .unwrap();
        let err = super::reject_live_owner_in(&root, &active, "sesslive", "/tmp/demo").unwrap_err();
        assert!(err.contains("already running"));
        fs::write(&active, r#"[{"session_id":"sesslive","pid":999999,"cwd":"/tmp/demo"}]"#).unwrap();
        assert!(super::reject_live_owner_in(&root, &active, "sesslive", "/tmp/demo").is_ok());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&active);
    }

    #[test]
    fn rejects_attach_to_unmarked_headless_via_prompt_context() {
        let root = std::env::temp_dir().join(format!("gz-pc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("proj").join("sesshead");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"info":{"id":"sesshead","cwd":"/tmp/demo"}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("prompt_context.json"),
            r#"{"is_non_interactive":true,"audience":"primary"}"#,
        )
        .unwrap();
        let err = super::reject_non_interactive_in(&root, "sesshead", "/tmp/demo").unwrap_err();
        assert!(err.contains("read-only"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_plan_rejects_unsafe_ids() {
        let err = super::read_plan("../etc", "/tmp").unwrap_err();
        assert!(err.contains("invalid"));
    }

    #[test]
    fn writes_plan_into_the_session_dir() {
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("gz-plan-root-{pid}"));
        let cwd = std::env::temp_dir().join(format!("gz-plan-cwd-{pid}"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&cwd);
        let session_id = "01sess-plan";
        let dir = root.join(super::encode_cwd(cwd.to_str().unwrap())).join(session_id);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let doc = super::write_plan_in(&root, session_id, cwd.to_str().unwrap(), "# Title\n\nDo the thing.\n").unwrap();
        assert!(doc.exists);
        assert_eq!(fs::read_to_string(dir.join("plan.md")).unwrap(), "# Title\n\nDo the thing.\n");
        assert!(super::write_plan_in(&root, "../etc", cwd.to_str().unwrap(), "nope").is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&cwd);
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(!super::is_safe_session_id("../etc"));
        assert!(!super::is_safe_session_id("a/b"));
        assert!(super::is_safe_session_id("01a07ece-f6f9-7d61-930f-cc789f20cae6"));
    }

    #[test]
    fn finds_thread_by_session_id() {
        let root = std::env::temp_dir().join(format!("gz-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("proj").join("01sess-find-me");
        fs::create_dir_all(&dir).unwrap();
        fs::write(root.join("proj").join(".cwd"), "/tmp/demo").unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"info":{"id":"01sess-find-me","cwd":"/tmp/demo"},"generated_title":"Found me","updated_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("prompt_context.json"),
            r#"{"is_non_interactive":true}"#,
        )
        .unwrap();
        let thread = super::find_thread_in(&root, "01sess-find-me").unwrap();
        assert_eq!(thread.session_id, "01sess-find-me");
        assert_eq!(thread.cwd, "/tmp/demo");
        assert_eq!(thread.title.as_deref(), Some("Found me"));
        assert!(thread.headless);
        assert!(super::find_thread_in(&root, "../etc").is_err());
        assert!(super::find_thread_in(&root, "missing-session").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_session_relative_chat_images() {
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("gz-media-root-{pid}"));
        let cwd = std::env::temp_dir().join(format!("gz-media-cwd-{pid}"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&cwd);
        let session_id = "01sess-media";
        let session_dir = root.join(super::encode_cwd(cwd.to_str().unwrap())).join(session_id);
        fs::create_dir_all(session_dir.join("images")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(session_dir.join("images/1.jpg"), b"jpeg-bytes").unwrap();
        fs::write(cwd.join("hero.png"), b"png-bytes").unwrap();

        let session_img = super::read_chat_media_in(&root, session_id, cwd.to_str().unwrap(), "images/1.jpg").unwrap();
        assert_eq!(session_img["kind"], "image");
        assert!(session_img["content"].as_str().unwrap().starts_with("data:image/jpeg;base64,"));
        assert!(session_img["path"].as_str().unwrap().ends_with("images/1.jpg"));

        let workspace_img = super::read_chat_media_in(&root, session_id, cwd.to_str().unwrap(), "hero.png").unwrap();
        assert!(workspace_img["content"].as_str().unwrap().starts_with("data:image/png;base64,"));

        assert!(super::read_chat_media_in(&root, session_id, cwd.to_str().unwrap(), "https://x/a.png").is_err());
        assert!(super::read_chat_media_in(&root, "../etc", cwd.to_str().unwrap(), "images/1.jpg").is_err());
        assert!(super::read_chat_media_in(&root, session_id, cwd.to_str().unwrap(), "/etc/hosts").is_err());
        assert!(super::read_chat_media_in(&root, session_id, cwd.to_str().unwrap(), "notes.txt").is_err());
        fs::write(root.join("secret.png"), b"nope").unwrap();
        assert!(super::read_chat_media_in(
            &root,
            session_id,
            cwd.to_str().unwrap(),
            "images/../../secret.png"
        )
        .is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&cwd);
    }

    #[test]
    fn compact_merges_chunks_and_tools() {
        let updates = vec![
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello" }
            }),
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": " world" }
            }),
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "read",
                "status": "pending"
            }),
            serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "rawOutput": { "text": "ok" }
            }),
            serde_json::json!({ "sessionUpdate": "turn_completed" }),
        ];
        let compact = super::compact_updates(updates);
        assert_eq!(compact.len(), 3);
        assert_eq!(compact[2]["sessionUpdate"], "turn_completed");
        assert_eq!(compact[0]["content"]["text"], "Hello world");
        assert_eq!(compact[1]["status"], "completed");
        assert_eq!(compact[1]["rawOutput"]["text"], "ok");
        assert_eq!(compact[1]["title"], "read");
    }

    #[test]
    fn compact_truncates_large_tool_output() {
        let big = "x".repeat(6000);
        let updates = vec![serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "t1",
            "rawOutput": { "text": big }
        })];
        let compact = super::compact_updates(updates);
        assert_eq!(compact[0]["truncated"], true);
        let text = compact[0]["rawOutput"]["text"].as_str().unwrap();
        assert!(text.len() < 5000);
        assert!(text.ends_with('…'));
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
