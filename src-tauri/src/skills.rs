use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub hint: Option<String>,
    pub source: String,
    pub user_invocable: bool,
}

pub fn list_skills(cwd: &str) -> Vec<SkillInfo> {
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (source, root) in skill_roots(cwd) {
        collect_from(&root, &source, &mut skills, &mut seen);
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn skill_roots(cwd: &str) -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    let cwd = PathBuf::from(cwd);
    let mut dir = Some(cwd.as_path());
    while let Some(current) = dir {
        roots.push(("project".into(), current.join(".grok/skills")));
        roots.push(("project".into(), current.join(".agents/skills")));
        roots.push(("project".into(), current.join(".claude/skills")));
        if current.join(".git").exists() {
            break;
        }
        dir = current.parent();
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        roots.push(("user".into(), home.join(".grok/skills")));
        roots.push(("user".into(), home.join(".agents/skills")));
        roots.push(("bundled".into(), home.join(".grok/bundled/skills")));
    }
    roots
}

fn collect_from(
    root: &Path,
    source: &str,
    skills: &mut Vec<SkillInfo>,
    seen: &mut std::collections::HashSet<String>,
) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let skill_md = if path.is_dir() {
            path.join("SKILL.md")
        } else {
            continue;
        };
        if !skill_md.is_file() {
            continue;
        }
        if let Some(skill) = parse_skill(&skill_md, source) {
            if !skill.user_invocable {
                continue;
            }
            if seen.insert(skill.name.clone()) {
                skills.push(skill);
            }
        }
    }
}

fn parse_skill(path: &Path, source: &str) -> Option<SkillInfo> {
    let text = fs::read_to_string(path).ok()?;
    let fallback = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".into());
    let fm = frontmatter(&text);
    let name = fm
        .get("name")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let user_invocable = fm
        .get("user-invocable")
        .map(|v| v != "false")
        .unwrap_or(true);
    Some(SkillInfo {
        name,
        description: fm.get("description").cloned().unwrap_or_default(),
        hint: fm.get("argument-hint").cloned(),
        source: source.to_string(),
        user_invocable,
    })
}

fn frontmatter(text: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let rest = text.strip_prefix("---").unwrap_or("");
    let Some((block, _)) = rest.split_once("\n---") else {
        return map;
    };
    for line in block.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
        map.insert(key.trim().to_string(), value);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::frontmatter;

    #[test]
    fn parses_yaml_frontmatter() {
        let text = "---\nname: commit\ndescription: Make a commit\nuser-invocable: true\n---\n# hi\n";
        let fm = frontmatter(text);
        assert_eq!(fm.get("name").unwrap(), "commit");
        assert_eq!(fm.get("description").unwrap(), "Make a commit");
    }
}
