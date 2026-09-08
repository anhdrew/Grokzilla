mod acp;
mod fssearch;
mod grok;
mod sessions;
mod skills;
mod workspace;
mod terminal;

use acp::AcpClient;
use grok::GrokStatus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sessions::{PlanDoc, ProjectInfo, ThreadInfo, ThreadStats};
use std::sync::Arc;
use std::collections::HashMap;
use tauri::{Manager, State};
use tokio::sync::Mutex;

pub struct TaskClient { pub client: Arc<AcpClient>, pub cwd: String }
pub struct AppState {
    client: Mutex<Option<Arc<AcpClient>>>,
    tasks: Mutex<HashMap<String, TaskClient>>,
    grok_path: Mutex<Option<std::path::PathBuf>>,
}
async fn task_client(state: &AppState, session: &str) -> Result<Arc<AcpClient>, String> {
    state.tasks.lock().await.get(session).map(|t| t.client.clone()).ok_or("Task is not attached".into())
}
async fn spawn_task(app: tauri::AppHandle, state: &AppState) -> Result<Arc<AcpClient>, String> {
    let path = state.grok_path.lock().await.clone().or_else(grok::find_grok).ok_or("Grok CLI not found")?;
    let client = Arc::new(AcpClient::spawn(app, path).await?);
    let init = client.initialize().await?;
    let method = init["_meta"]["defaultAuthMethodId"].as_str().or_else(|| init["authMethods"][0]["id"].as_str()).unwrap_or("cached_token");
    if let Err(err) = client.authenticate(method).await { client.shutdown().await; return Err(err); }
    client.set_init(init).await;
    Ok(client)
}
#[tauri::command]
async fn configure_runtime(state: State<'_, AppState>, grok_path: String) -> Result<(), String> {
    let path = if grok_path.trim().is_empty() { None } else {
        let p = std::path::PathBuf::from(grok_path);
        if !p.is_absolute() || !p.is_file() { return Err("CLI path must be an existing absolute file path".into()); } Some(p)
    };
    *state.grok_path.lock().await = path;
    Ok(())
}
#[tauri::command]
async fn close_task(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if let Some(task) = state.tasks.lock().await.remove(&session_id) { task.client.shutdown().await; }
    Ok(())
}

fn require_client(client: &Option<Arc<AcpClient>>) -> Result<Arc<AcpClient>, String> {
    client
        .clone()
        .ok_or_else(|| "Grok agent is not running".to_string())
}

#[tauri::command]
fn grok_status() -> GrokStatus {
    grok::status()
}

#[tauri::command]
async fn start_agent(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let grok = grok::find_grok().ok_or_else(|| {
        "Grok Build CLI was not found. Install it, then reopen Grokzilla.".to_string()
    })?;

    {
        let mut slot = state.client.lock().await;
        if let Some(existing) = slot.as_ref() {
            if existing.is_alive().await {
                if let Some(init) = existing.cached_init().await {
                    return Ok(init);
                }
            }
        }
        if let Some(existing) = slot.take() {
            existing.shutdown().await;
        }
        let client = AcpClient::spawn(app, grok).await?;
        let init = client.initialize().await?;
        client.set_init(init.clone()).await;
        *slot = Some(Arc::new(client));
        Ok(init)
    }
}

#[tauri::command]
async fn authenticate(state: State<'_, AppState>, method_id: String) -> Result<Value, String> {
    let slot = state.client.lock().await;
    let client = require_client(&slot)?;
    drop(slot);
    client.authenticate(&method_id).await
}

#[tauri::command]
async fn open_in_terminal(session_id: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || grok::open_session_in_terminal(&session_id, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_login() -> Result<GrokStatus, String> {
    let grok = grok::find_grok().ok_or_else(|| "Grok Build CLI was not found".to_string())?;
    grok::start_login(&grok).await?;
    Ok(grok::status())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarLists {
    threads: Vec<ThreadInfo>,
    projects: Vec<ProjectInfo>,
}

#[tauri::command]
async fn list_sidebar() -> Result<SidebarLists, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let threads = sessions::list_threads()?;
        let projects = sessions::projects_from(&threads);
        Ok(SidebarLists { threads, projects })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_threads() -> Result<Vec<ThreadInfo>, String> {
    tauri::async_runtime::spawn_blocking(sessions::list_threads)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let threads = sessions::list_threads()?;
        Ok(sessions::projects_from(&threads))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn find_thread(session_id: String) -> Result<ThreadInfo, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::find_thread(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hydrate_session(session_id: String, cwd: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::hydrate_updates(&session_id, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_plan(session_id: String, cwd: String) -> Result<PlanDoc, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::read_plan(&session_id, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_tool_body(
    session_id: String,
    cwd: String,
    tool_call_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sessions::load_tool_body(&session_id, &cwd, &tool_call_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn thread_stats(session_id: String, cwd: String) -> Result<ThreadStats, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::thread_stats(&session_id, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_thread(session_id: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        sessions::reject_live_headless(&session_id, &cwd)?;
        sessions::delete_thread(&session_id, &cwd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStart {
    session_id: String,
    raw: Value,
}

fn session_id_from(value: &Value) -> Result<String, String> {
    value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| "agent did not return a sessionId".to_string())
}

#[tauri::command]
async fn new_session(app: tauri::AppHandle, state: State<'_, AppState>, cwd: String) -> Result<SessionStart, String> {
    let client = spawn_task(app, &state).await?;
    let result = client.session_new(&cwd).await;
    client.shutdown().await;
    let raw = result?;
    Ok(SessionStart { session_id: session_id_from(&raw)?, raw })
}

#[tauri::command]
async fn load_session(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String, cwd: String) -> Result<SessionStart, String> {
    sessions::reject_non_interactive(&session_id, &cwd)?;
    let mut tasks = state.tasks.lock().await;
    if let Some(task) = tasks.get(&session_id) {
        if task.client.is_alive().await {
            return Ok(SessionStart { session_id, raw: json!({"processId": task.client.generation()}) });
        }
    }
    if let Some(old) = tasks.remove(&session_id) { old.client.shutdown().await; }
    let client = spawn_task(app, &state).await?;
    client.bind(&session_id);
    let mut raw = match client.session_load(&session_id, &cwd).await { Ok(v)=>v, Err(e)=> { client.shutdown().await; return Err(e); } };
    raw["processId"] = json!(client.generation());
    tasks.insert(session_id.clone(), TaskClient { client, cwd });
    Ok(SessionStart { session_id, raw })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentIn {
    path: String,
    rel: String,
    kind: String,
    mime_type: Option<String>,
}

#[tauri::command]
async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<AttachmentIn>>,
) -> Result<Value, String> {
    let client = task_client(&state, &session_id).await?;
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for item in attachments.unwrap_or_default() {
        if let Some(mime) = grok::image_mime(&item.path, &item.kind, item.mime_type.as_deref()) {
            blocks.push(grok::read_image_block(&item.path, &mime)?);
            continue;
        }
        let uri = format!("file://{}", item.path);
        blocks.push(json!({
            "type": "resource_link",
            "uri": uri,
            "name": item.rel,
            "mimeType": if item.kind == "folder" { "inode/directory" } else { "text/plain" }
        }));
    }
    client.prompt_blocks(&session_id, Value::Array(blocks)).await
}

#[tauri::command]
async fn search_paths(cwd: String, query: String) -> Result<Vec<fssearch::PathHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let hidden = query.starts_with('!');
        fssearch::search(&cwd, &query, hidden)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_dir(cwd: String, rel: String) -> Result<Vec<fssearch::PathHit>, String> {
    tauri::async_runtime::spawn_blocking(move || fssearch::list_dir(&cwd, &rel))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_skills(cwd: String) -> Result<Vec<skills::SkillInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || skills::list_skills(&cwd))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_billing(state: State<'_, AppState>) -> Result<Value, String> {
    let slot = state.client.lock().await;
    if let Ok(client) = require_client(&slot) {
        drop(slot);
        if let Ok(value) = client.billing().await {
            return Ok(value);
        }
    } else {
        drop(slot);
    }
    grok::fetch_billing_http()
}

#[tauri::command]
fn save_drop(name: String, data_base64: String) -> Result<grok::SavedDrop, String> {
    grok::save_drop(&name, &data_base64)
}

#[tauri::command]
async fn cancel_prompt(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let client = task_client(&state, &session_id).await?;
    client.cancel(&session_id).await
}

#[tauri::command]
async fn set_mode(
    state: State<'_, AppState>,
    session_id: String,
    mode_id: String,
) -> Result<Value, String> {
    let client = task_client(&state, &session_id).await?;
    client.set_mode(&session_id, &mode_id).await
}

#[tauri::command]
async fn set_model(
    state: State<'_, AppState>,
    session_id: String,
    model_id: String,
) -> Result<Value, String> {
    let client = task_client(&state, &session_id).await?;
    client.set_model(&session_id, &model_id).await
}

#[tauri::command]
async fn set_config_option(
    state: State<'_, AppState>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let client = task_client(&state, &session_id).await?;
    client
        .set_config_option(&session_id, &config_id, &value)
        .await
}

#[tauri::command]
async fn respond_permission(
    state: State<'_, AppState>,
    session_id: String,
    process_id: u64,
    id: u64,
    option_id: Option<String>,
    cancelled: bool,
) -> Result<(), String> {
    let client = task_client(&state, &session_id).await?;
    if client.generation() != process_id { return Err("Permission belongs to an expired process".into()); }
    client.respond_permission(id, option_id, cancelled).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            client: Mutex::new(None),
            tasks: Mutex::new(HashMap::new()),
            grok_path: Mutex::new(None),
        })
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            configure_runtime, close_task,
            workspace::read_workspace, workspace::write_workspace, workspace::read_workspace_file,
            workspace::git_info, workspace::git_review, workspace::git_action,
            workspace::create_worktree, workspace::remove_worktree, workspace::merge_worktree,
            terminal::terminal_open, terminal::terminal_write, terminal::terminal_resize, terminal::terminal_close,
            grok_status,
            start_agent,
            authenticate,
            start_login,
            open_in_terminal,
            list_sidebar,
            list_threads,
            list_projects,
            find_thread,
            hydrate_session,
            read_plan,
            load_tool_body,
            thread_stats,
            delete_thread,
            new_session,
            load_session,
            send_prompt,
            cancel_prompt,
            set_mode,
            set_model,
            set_config_option,
            respond_permission,
            search_paths,
            list_dir,
            list_skills,
            get_billing,
            save_drop
        ])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Grokzilla");
}
