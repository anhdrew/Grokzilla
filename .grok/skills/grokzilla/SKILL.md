---
name: grokzilla
description: Operate the local Grokzilla desktop app from Grok Bot via the grokzilla CLI.
---

# Grokzilla (local Mac)

Grokzilla is a **local macOS app**. The Grok Bot cloud computer cannot click it. Use **Execution on Local Computer** and the `grokzilla` CLI.

## Setup

1. Grokzilla.app is running on this Mac.
2. Grok Bot → Settings → General → Agent → **Execution on Local Computer** is Ask or Always.
3. CLI: `~/.grok/bin/grokzilla` (or `grokzilla` on PATH).

If the app is closed: `grokzilla launch`.

## Commands (JSON on stdout)

```
grokzilla status
grokzilla projects
grokzilla threads [--cwd PATH]
grokzilla open --cwd PATH [--session ID]
grokzilla new [--cwd PATH]
grokzilla send [--session ID] [--file prompt.md] TEXT
grokzilla transcript [--session ID]
grokzilla wait [--timeout 600]
grokzilla stop
grokzilla permission allow|deny [--option ID]
grokzilla set-mode ask|plan|auto|yolo
grokzilla set-model ID
```

## Read the chat first

Before sending, call `grokzilla transcript` (or `status`). Use:

- `needs.summary` — what the session is waiting on
- `needs.lastUser` / `needs.lastAssistant` — latest human ask and Grok reply
- `needs.permission` — tool approval waiting
- `chat` — full readable log (`[user]`, `[assistant]`, `[tool]`, `[thinking]`)

That is how you know what the thread needs.

## Rules

- Never `send` / `set-mode` / `permission` on `headless: true` or `readOnly: true` (grok -p watch).
- `send` only queues; `wait` until not running (exit 2 = permission needed).
- Do not `session/load` grok -p by other means. This CLI already refuses attach.
