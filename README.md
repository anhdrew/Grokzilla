# Grokzilla

Desktop GUI for [Grok Build CLI](https://docs.x.ai/build/overview). Same agent, same sessions, a window instead of the TUI.

macOS only. Grokzilla does **not** reimplement the model or tool loop. It spawns `grok agent stdio` and speaks [ACP](https://agentclientprotocol.com).

## Install

Download the macOS `.dmg` from [Releases](https://github.com/anhdrew/Grokzilla/releases). Pick `aarch64` for Apple Silicon or `x86_64` for Intel.

The build is ad-hoc signed (no Apple Developer ID). First launch: right-click **Grokzilla.app** → **Open**, or allow it in **System Settings → Privacy & Security**.

To cut a new GitHub Release, bump `version` in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, then:

```bash
git tag v0.3.0
git push origin v0.3.0
```

GitHub Actions builds both Mac chips and uploads the `.dmg` files to the release.

## Requirements

- macOS 13+
- [Grok Build CLI](https://x.ai/cli) installed and on your PATH (or `~/.grok/bin/grok`)
- A Grok login (`grok login`) or `XAI_API_KEY`
- Node 22+, pnpm, Rust (stable)

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

## Develop

```bash
pnpm install
pnpm test
pnpm tauri dev
```

## Use

1. Open a project folder.
2. Start a thread or resume one from `~/.grok/sessions` (shared with the TUI).
3. Ask Grok to work. In **Ask** mode, tool calls wait for a click.

Shortcuts: `Cmd+N` new thread, `Cmd+J` review pane, `Enter` send, `Esc` stop. Hover a thread and click the terminal icon to resume it in Terminal (`grok --resume`). Use **New**, **Plan**, and **Compact** in the chat header for those actions. Slash in the composer is for skills.

Headless `grok -p` sessions show in the sidebar with a `-p` badge. Grokzilla hydrates them from disk and will not `session/load` them. Subagent children of those runs are hidden so they cannot be stolen from a live parent.

## Architecture

```
Grokzilla (Tauri + React)
    JSON-RPC / stdio
grok agent stdio
    ~/.grok/sessions, auth.json, config.toml, MCP, skills
```

## Out of scope (this version)

Windows/Linux packaging, VS Code extension, bundling the `grok` binary, Codex Cloud, computer use.
