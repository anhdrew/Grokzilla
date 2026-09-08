use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHit {
    pub path: String,
    pub rel: String,
    pub kind: String,
    pub score: i32,
}

pub fn search(cwd: &str, query: &str, include_hidden: bool) -> Result<Vec<PathHit>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let q = query.trim_start_matches('!').trim().to_lowercase();
    let mut hits = Vec::new();
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(12));
    for result in builder.build() {
        let Ok(entry) = result else { continue };
        let path = entry.path();
        if path == root {
            continue;
        }
        let rel = path.strip_prefix(&root).unwrap_or(path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let score = score_path(&rel_str, &q);
        if score <= 0 && !q.is_empty() {
            continue;
        }
        if q.is_empty() && rel_str.matches('/').count() > 1 {
            continue;
        }
        hits.push(PathHit {
            path: path.display().to_string(),
            rel: if is_dir {
                format!("{rel_str}/")
            } else {
                rel_str
            },
            kind: if is_dir { "folder".into() } else { "file".into() },
            score,
        });
        if hits.len() > 400 {
            break;
        }
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.rel.len().cmp(&b.rel.len())));
    hits.truncate(40);
    if q.is_empty() {
        hits.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    }
    Ok(hits)
}

pub fn list_dir(cwd: &str, rel: &str) -> Result<Vec<PathHit>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let rel = rel.trim_start_matches("./").trim_matches('/');
    if Path::new(rel).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("invalid path".into());
    }
    let dir = if rel.is_empty() {
        root.clone()
    } else {
        root.join(rel)
    };
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let dir_canon = match dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };
    if !dir_canon.starts_with(&root_canon) {
        return Err("invalid path".into());
    }
    if !dir_canon.is_dir() {
        return Ok(Vec::new());
    }

    let mut hits = Vec::new();
    let mut builder = WalkBuilder::new(&dir_canon);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(1));
    for result in builder.build() {
        let Ok(entry) = result else { continue };
        let path = entry.path();
        if path == dir_canon {
            continue;
        }
        let rel_path = path.strip_prefix(&root_canon).unwrap_or(path);
        let rel_str = rel_path.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        hits.push(PathHit {
            path: path.display().to_string(),
            rel: if is_dir {
                format!("{rel_str}/")
            } else {
                rel_str
            },
            kind: if is_dir { "folder".into() } else { "file".into() },
            score: if is_dir { 2 } else { 1 },
        });
        if hits.len() > 500 {
            break;
        }
    }
    hits.sort_by(|a, b| {
        b.kind
            .cmp(&a.kind)
            .then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()))
    });
    Ok(hits)
}

fn score_path(rel: &str, query: &str) -> i32 {
    if query.is_empty() {
        return 1;
    }
    let rel_l = rel.to_lowercase();
    let name = Path::new(rel)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name == query {
        100
    } else if name.starts_with(query) {
        85
    } else if name.contains(query) {
        70
    } else if rel_l.contains(query) {
        45
    } else if subsequence(&name, query) {
        25
    } else {
        0
    }
}

fn subsequence(hay: &str, needle: &str) -> bool {
    let mut it = hay.chars();
    for ch in needle.chars() {
        if it.find(|c| *c == ch).is_none() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::score_path;

    #[test]
    fn prefers_filename_prefix() {
        assert!(score_path("src/App.tsx", "app") > score_path("src/lib/api.ts", "app"));
    }

    #[test]
    fn list_dir_rejects_parent_escape() {
        let err = super::list_dir("/tmp", "../").unwrap_err();
        assert!(err.contains("invalid"));
    }
}
