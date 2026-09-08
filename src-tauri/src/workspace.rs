use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex};
use tauri::Manager;

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static GIT_LOCK: Mutex<()> = Mutex::new(());

pub fn data_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_workspace(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = data_path(&app)?.join("workspace.json");
    if !path.exists() { return Ok(None); }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("Workspace metadata is invalid: {e}"))?;
    if value["version"] != 1 { return Err("Unsupported workspace metadata version; original file was preserved".into()); }
    Ok(Some(value))
}

#[tauri::command]
pub fn write_workspace(app: tauri::AppHandle, value: Value) -> Result<(), String> {
    if value["version"] != 1 { return Err("Unsupported metadata version".into()); }
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = data_path(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("workspace.json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(tmp, dir.join("workspace.json")).map_err(|e| e.to_string())
}

pub fn scoped_path(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    let candidate = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    let resolved = fs::canonicalize(candidate).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) { return Err("File is outside this workspace".into()); }
    Ok(resolved)
}

#[tauri::command]
pub async fn read_workspace_file(cwd: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = scoped_path(&cwd, &path)?;
        let size = fs::metadata(&file).map_err(|e| e.to_string())?.len();
        if size > 8 * 1024 * 1024 { return Err("Preview limit is 8 MB. Open this file externally.".into()); }
        let bytes = fs::read(&file).map_err(|e| e.to_string())?;
        let ext = file.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let mime = match ext.as_str() { "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"), "gif" => Some("image/gif"), "webp" => Some("image/webp"), _ => None };
        if let Some(mime) = mime {
            return Ok(json!({"kind":"image", "content":format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)), "path":file, "size":size}));
        }
        let text = String::from_utf8(bytes).map_err(|_| "Binary file; open externally".to_string())?;
        if text.contains('\0') { return Err("Binary file; open externally".into()); }
        Ok(json!({"kind":if ext == "md" { "markdown" } else { "code" }, "content":text, "path":file, "size":size}))
    }).await.map_err(|e| e.to_string())?
}

pub fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("--no-pager").args(args).current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0").output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct GitInfo { pub root: String, pub branch: String, pub branches: Vec<String>, pub dirty: bool }

#[tauri::command]
pub async fn git_info(cwd: String) -> Result<GitInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git(&cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        Ok(GitInfo { branch: git(&root, &["branch", "--show-current"])?.trim().to_string(),
            branches: git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"])?.lines().map(str::to_string).collect(),
            dirty: !git(&root, &["status", "--porcelain"])?.is_empty(), root })
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all="camelCase")]
pub struct DiffFile { pub path: String, pub old_path: Option<String>, pub status: String, pub patch: String, pub additions: usize, pub deletions: usize }
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all="camelCase")]
pub struct Review { pub files: Vec<DiffFile>, pub token: String }

fn safe_rel(path: &str) -> Result<(), String> {
    if path.is_empty() || Path::new(path).is_absolute() || Path::new(path).components().any(|c| matches!(c, std::path::Component::ParentDir)) || path.split('/').any(|p| p == ".git") {
        return Err("Invalid repository path".into());
    }
    Ok(())
}

fn review(cwd: &str, scope: &str, base: &str) -> Result<Review, String> {
    let revision = if scope == "branch" {
        if base.starts_with('-') { return Err("Invalid base branch".into()); }
        let commit = git(cwd, &["rev-parse", "--verify", &format!("{base}^{{commit}}")])?;
        Some(format!("{}...HEAD", commit.trim()))
    } else { None };
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
    match scope { "staged" => args.push("--cached"), "branch" => args.push(revision.as_deref().unwrap()), "unstaged" => {}, _ => return Err("Unknown review scope".into()) }
    let mut list_args = args.clone(); list_args.extend(["--name-status", "-z", "--"]);
    let list = git(cwd, &list_args)?;
    let mut parts = list.split('\0').filter(|p| !p.is_empty());
    let mut names = vec![];
    while let Some(status) = parts.next() {
        let first = parts.next().ok_or("Invalid Git status")?;
        let (path, old) = if status.starts_with('R') || status.starts_with('C') {
            (parts.next().ok_or("Invalid rename status")?, Some(first.to_string()))
        } else { (first, None) };
        names.push((path.to_string(), old, status.to_string()));
    }
    if scope == "unstaged" {
        for path in git(cwd, &["ls-files", "--others", "--exclude-standard", "-z"])?.split('\0').filter(|p| !p.is_empty()) {
            names.push((path.to_string(), None, "?".into()));
        }
    }
    let mut files = vec![];
    for (path, old, status) in names {
        let patch = if status == "?" {
            let output = Command::new("git").args(["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", &path]).current_dir(cwd).output().map_err(|e| e.to_string())?;
            if output.status.code().unwrap_or(2) > 1 { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
            String::from_utf8_lossy(&output.stdout).into_owned()
        } else {
            let mut a = args.clone(); a.extend(["--", &path]); if let Some(ref p) = old { a.push(p); } git(cwd, &a)?
        };
        let additions = patch.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
        let deletions = patch.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
        files.push(DiffFile { path, old_path: old, status, patch, additions, deletions });
    }
    // Hash the exact snapshot, HEAD and index, so actions cannot silently apply a stale review.
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(&files).unwrap().hash(&mut hash);
    git(cwd, &["rev-parse", "HEAD"]).unwrap_or_default().hash(&mut hash);
    git(cwd, &["ls-files", "--stage", "-z"])?.hash(&mut hash);
    Ok(Review { files, token: format!("{:x}", hash.finish()) })
}

#[tauri::command]
pub async fn git_review(cwd: String, scope: String, base: String) -> Result<Review, String> {
    tauri::async_runtime::spawn_blocking(move || review(&cwd, &scope, &base)).await.map_err(|e| e.to_string())?
}

fn one_hunk(patch: &str, index: usize) -> Result<String, String> {
    let mut header = String::new(); let mut hunks: Vec<String> = vec![];
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") { hunks.push(String::new()); }
        if let Some(hunk) = hunks.last_mut() { hunk.push_str(line); } else { header.push_str(line); }
    }
    Ok(format!("{}{}", header, hunks.get(index).ok_or("Hunk no longer exists")?))
}

#[tauri::command]
pub async fn git_action(cwd: String, scope: String, base: String, token: String, action: String, path: Option<String>, hunk: Option<usize>, message: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GIT_LOCK.lock().map_err(|e| e.to_string())?;
        let current = review(&cwd, &scope, &base)?;
        if current.token != token { return Err("Changes have moved since this review. Refresh and try again.".into()); }
        if action == "commit" {
            if scope != "staged" { return Err("Review staged changes before committing".into()); }
            let msg = message.unwrap_or_default(); if msg.trim().is_empty() { return Err("Commit message is required".into()); }
            return git(&cwd, &["commit", "-m", &msg]);
        }
        if action == "push" { return git(&cwd, &["push"]); }
        let path = path.ok_or("Choose a file")?; safe_rel(&path)?;
        let file = current.files.iter().find(|f| f.path == path).ok_or("File no longer in review")?;
        if let Some(index) = hunk {
            if !matches!((action.as_str(), scope.as_str()), ("stage", "unstaged") | ("unstage", "staged")) || file.status != "M" {
                return Err("Hunk staging is available for modified files only; use the file action for additions and renames.".into());
            }
            let patch = one_hunk(&file.patch, index)?;
            let mut cmd = Command::new("git"); cmd.current_dir(&cwd).args(["apply", "--cached", "--recount", "--whitespace=nowarn"]);
            if action == "unstage" { cmd.arg("--reverse"); }
            let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
            child.stdin.take().ok_or("Missing Git stdin")?.write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
            return Ok("Hunk updated".into());
        }
        match (action.as_str(), scope.as_str()) {
            ("stage", "unstaged") => { let mut args = vec!["add", "--", &path]; if let Some(ref old) = file.old_path { args.push(old); } git(&cwd, &args) },
            ("unstage", "staged") => {
                let mut args = vec!["reset", "-q", "HEAD", "--", &path]; if let Some(ref old) = file.old_path { args.push(old); }
                if git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_err() { git(&cwd, &["rm", "--cached", "--", &path]) } else { git(&cwd, &args) }
            },
            ("discard", "unstaged") if file.status != "?" && file.old_path.is_none() => git(&cwd, &["restore", "--worktree", "--", &path]),
            _ => Err("This action is unavailable for the selected change".into()),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_worktree(app: tauri::AppHandle, cwd: String, base: String) -> Result<Value, String> {
    let parent = data_path(&app)?.join("worktrees");
    tauri::async_runtime::spawn_blocking(move || {
        if base.starts_with('-') { return Err("Invalid branch".into()); }
        let root = git(&cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string();
        let commit = git(&root, &["rev-parse", "--verify", &format!("{base}^{{commit}}")])?;
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let path = parent.join(format!("task-{id}"));
        let branch = format!("grokzilla/task-{id}");
        git(&root, &["worktree", "add", "-b", &branch, path.to_str().ok_or("Invalid path")?, commit.trim()])?;
        Ok(json!({"cwd":path, "repository":root, "branch":branch, "base":base, "environment":"worktree"}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_worktree(app: tauri::AppHandle, repository: String, cwd: String, state: tauri::State<'_, crate::AppState>, terminals: tauri::State<'_, crate::terminal::Terminals>) -> Result<(), String> {
    let allowed = data_path(&app)?.join("worktrees");
    let target = fs::canonicalize(&cwd).map_err(|e| e.to_string())?;
    let managed = fs::canonicalize(allowed).map_err(|e| e.to_string())?;
    if !target.starts_with(&managed) || target == managed { return Err("Only app-managed worktrees can be removed".into()); }
    if state.tasks.lock().await.values().any(|t| t.cwd == cwd) || terminals.has_cwd(&cwd) { return Err("Close task sessions and terminal tabs before removing this worktree".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        if !git(&cwd, &["status", "--porcelain", "--ignored"])?.is_empty() { return Err("Worktree contains changes or ignored files. Preserve them before cleanup.".into()); }
        git(&repository, &["worktree", "remove", "--", &cwd])?; Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn merge_worktree(repository: String, branch: String, target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GIT_LOCK.lock().map_err(|e| e.to_string())?;
        if git(&repository, &["branch", "--show-current"])?.trim() != target { return Err("The destination branch must be checked out in the original project".into()); }
        if !git(&repository, &["status", "--porcelain"])?.is_empty() { return Err("Commit or stash destination changes before merging".into()); }
        if branch.starts_with('-') { return Err("Invalid branch".into()); }
        let commit = git(&repository, &["rev-parse", "--verify", &format!("{branch}^{{commit}}")])?;
        git(&repository, &["merge", "--no-edit", commit.trim()]).map_err(|e| format!("Merge did not complete. Inspect Git status and resolve or abort in Terminal. {e}"))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo() -> PathBuf {
        let path = std::env::temp_dir().join(format!("gz-git-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&path).unwrap(); let cwd = path.to_str().unwrap();
        git(cwd, &["-c", "init.templateDir=", "init", "-q"]).unwrap();
        git(cwd, &["config", "user.email", "test@example.com"]).unwrap();
        git(cwd, &["config", "user.name", "Test"]).unwrap();
        path
    }
    #[test] fn review_tracks_untracked_staged_rename_and_stale_content() {
        let dir=repo(); let cwd=dir.to_str().unwrap(); fs::write(dir.join("a.txt"), "first\n").unwrap();
        assert_eq!(review(cwd,"unstaged", "HEAD").unwrap().files[0].status,"?");
        git(cwd,&["add","."]).unwrap(); assert_eq!(review(cwd,"staged","HEAD").unwrap().files[0].additions,1);
        git(cwd,&["commit","-qm","initial"]).unwrap(); fs::write(dir.join("a.txt"),"second\n").unwrap();
        let first=review(cwd,"unstaged","HEAD").unwrap(); fs::write(dir.join("a.txt"),"third\n").unwrap();
        assert_ne!(first.token,review(cwd,"unstaged","HEAD").unwrap().token);
        git(cwd,&["restore","a.txt"]).unwrap(); git(cwd,&["mv","a.txt","new name.txt"]).unwrap();
        let renamed=review(cwd,"staged","HEAD").unwrap(); assert_eq!(renamed.files[0].old_path.as_deref(),Some("a.txt"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn file_scope_rejects_escape() { assert!(scoped_path("/tmp", "/etc/passwd").is_err()); assert!(safe_rel("../a").is_err()); assert!(safe_rel(".git/config").is_err()); }
    #[test] fn hunk_selection_preserves_header() { let patch="diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n+d\n"; let selected=one_hunk(patch,1).unwrap(); assert!(selected.contains("--- a/a")); assert!(!selected.contains("-a\n")); assert!(selected.contains("-c\n")); }
}
