# Grokzilla

Desktop GUI for [Grok Build CLI](https://docs.x.ai/build/overview). Same agent, same sessions, a window instead of the TUI.

macOS only. Grokzilla does **not** reimplement the model or tool loop. It spawns `grok agent stdio` and speaks [ACP](https://agentclientprotocol.com).

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

Shortcuts: `Cmd+N` new thread, `Cmd+J` review pane, `Enter` send, `Esc` stop.

## Architecture

```
Grokzilla (Tauri + React)
    JSON-RPC / stdio
grok agent stdio
    ~/.grok/sessions, auth.json, config.toml, MCP, skills
```

## Out of scope (this version)

Windows/Linux packaging, VS Code extension, bundling the `grok` binary, Codex Cloud, computer use.
