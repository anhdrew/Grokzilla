import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { api } from "../lib/api";
import { getExplorerDrag } from "../lib/explorer-drag";
import { APP_COMMANDS, activeToken, replaceToken } from "../lib/tokens";
import { MODES, useApp } from "../lib/store";
import type { PathHit, SlashCommand } from "../lib/types";
import { IconFile, IconFolder } from "./icons";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer() {
  const app = useApp();
  const area = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<PathHit[]>([]);
  const [active, setActive] = useState(0);
  const [dragDepth, setDragDepth] = useState(0);
  const token = activeToken(app.composer, cursor);

  const commands = useMemo(() => {
    const merged: SlashCommand[] = [...APP_COMMANDS];
    const seen = new Set(merged.map((c) => c.name));
    const sessionId = app.selectedSession;
    const sessionCmds = sessionId ? app.transcripts[sessionId]?.commands ?? [] : [];
    for (const command of sessionCmds) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      merged.push({ ...command, source: command.source ?? "session" });
    }
    for (const skill of app.skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      merged.push({
        name: skill.name,
        description: skill.description,
        hint: skill.hint ?? undefined,
        source: skill.source || "skill",
      });
    }
    const query = token?.kind === "slash" ? token.query.toLowerCase() : "";
    return merged
      .filter(
        (c) =>
          !query ||
          c.name.toLowerCase().includes(query) ||
          (c.description ?? "").toLowerCase().includes(query),
      )
      .slice(0, 14);
  }, [app.selectedSession, app.skills, app.transcripts, token]);

  useEffect(() => {
    if (token?.kind !== "at" || !app.selectedCwd) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      const q = token.hidden ? `!${token.query}` : token.query;
      void api.searchPaths(app.selectedCwd!, q).then((rows) => {
        setHits(rows);
        setActive(0);
      });
    }, 80);
    return () => window.clearTimeout(handle);
  }, [token?.kind, token?.query, token?.hidden, app.selectedCwd]);

  useEffect(() => {
    setActive(0);
  }, [token?.kind, token?.query]);

  const menu = token?.kind === "slash" ? "slash" : token?.kind === "at" ? "at" : null;
  const menuCount = menu === "slash" ? commands.length : hits.length;
  const modeId = app.selectedSession ? app.transcripts[app.selectedSession]?.modeId : undefined;

  function acceptAt(hit: PathHit) {
    if (!token || token.kind !== "at") return;
    const insert = `@${hit.rel} `;
    const next = replaceToken(app.composer, token, insert);
    app.setComposer(next);
    app.addAttachment({
      path: hit.path,
      rel: hit.rel,
      kind: hit.kind === "folder" ? "folder" : "file",
    });
    setHits([]);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      const pos = token.start + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCursor(pos);
    });
  }

  function acceptSlash(command: SlashCommand) {
    if (!token || token.kind !== "slash") return;
    const insert = command.hint ? `/${command.name} ` : `/${command.name}`;
    const next = replaceToken(app.composer, token, insert);
    app.setComposer(next);
    if (!command.hint) {
      void useApp.getState().send();
    } else {
      requestAnimationFrame(() => {
        const el = area.current;
        if (!el) return;
        const pos = next.length;
        el.focus();
        el.setSelectionRange(pos, pos);
        setCursor(pos);
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu && menuCount > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % menuCount);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + menuCount) % menuCount);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        if (menu === "at" && hits[active]) acceptAt(hits[active]);
        else if (menu === "slash" && commands[active]) acceptSlash(commands[active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setHits([]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void app.send();
    }
  }

  async function ingestFiles(list: FileList | File[]) {
    const files = [...list] as Array<File & { path?: string }>;
    for (const file of files) {
      const image = isImageFile(file);
      let preview: string | undefined;
      if (image) {
        try {
          preview = await readDataUrl(file);
        } catch {
          preview = undefined;
        }
      }
      let path = file.path;
      let rel = file.name || "drop";
      if (!path) {
        try {
          const dataUrl = preview ?? (await readDataUrl(file));
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          const saved = await api.saveDrop(file.name || (image ? "image.png" : "drop.bin"), base64);
          path = saved.path;
          rel = saved.rel;
        } catch {
          continue;
        }
      } else {
        const cwd = app.selectedCwd ?? "";
        rel = path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\//, "") : file.name || path;
      }
      app.addAttachment({
        path,
        rel,
        kind: image ? "image" : "file",
        mimeType: file.type || undefined,
        preview,
      });
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragDepth(0);
    const entry = getExplorerDrag(event.dataTransfer);
    if (entry) {
      event.stopPropagation();
      app.attachEntry({
        path: entry.path,
        rel: entry.rel,
        kind: entry.kind === "folder" ? "folder" : "file",
      });
      return;
    }
    void ingestFiles(event.dataTransfer.files);
  }

  return (
    <div
      className={`composer ${dragDepth > 0 ? "dragover" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragDepth((n) => n + 1);
      }}
      onDragLeave={() => setDragDepth((n) => Math.max(0, n - 1))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="composer-drop">Drop files, folders, or images</div>
      {app.attachments.length ? (
        <div className="chips">
          {app.attachments.map((item) => (
            <button
              key={item.path}
              className="chip"
              onClick={() => app.removeAttachment(item.path)}
              title={item.path}
            >
              {item.kind === "image" && item.preview ? (
                <img className="chip-thumb" src={item.preview} alt="" />
              ) : item.kind === "folder" ? (
                "▸"
              ) : (
                "#"
              )}{" "}
              {item.rel}
              <span>×</span>
            </button>
          ))}
        </div>
      ) : null}
      {menu === "slash" && commands.length ? (
        <div className="popover">
          {commands.map((command, index) => (
            <button
              key={`${command.source}-${command.name}`}
              className={`slash-item ${index === active ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                acceptSlash(command);
              }}
            >
              <b>/{command.name}</b>
              <span>
                {command.description}
                {command.source ? ` · ${command.source}` : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {menu === "at" && hits.length ? (
        <div className="popover">
          {hits.map((hit, index) => {
            const folder = hit.kind === "folder";
            return (
              <button
                key={hit.path}
                className={`slash-item at-hit ${index === active ? "on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptAt(hit);
                }}
              >
                {folder ? <IconFolder className="slash-ico folder" /> : <IconFile className="slash-ico file" />}
                <span className="slash-copy">
                  <b>{hit.rel}</b>
                  <span>{folder ? "Folder" : "File"} · {hit.path}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <textarea
        ref={area}
        value={app.composer}
        placeholder="Message Grokzilla…  @ files  / skills  drop images"
        onChange={(e) => {
          app.setComposer(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onClick={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        <div className="composer-controls">
          <div className="modes">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                className={`mode ${modeId === mode.id ? "on" : ""}`}
                disabled={!app.selectedSession}
                onClick={() => void app.setMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <select
            className="select composer-select"
            value={app.currentModel ?? ""}
            disabled={!app.selectedSession}
            onChange={(e) => void app.setModel(e.target.value)}
            aria-label="Model"
          >
            {(app.models.length ? app.models : [{ modelId: "grok-4.6", name: "Grok 4.6" }]).map(
              (model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.name ?? model.modelId}
                </option>
              ),
            )}
          </select>
          <select
            className="select composer-select"
            title="Thinking level"
            value={app.currentEffort ?? ""}
            disabled={!app.selectedSession || app.efforts.length === 0}
            onChange={(e) => void app.setEffort(e.target.value)}
            aria-label="Thinking"
          >
            {app.efforts.length ? (
              app.efforts.map((effort) => (
                <option key={effort.id} value={effort.id} title={effort.description}>
                  {effort.label}
                </option>
              ))
            ) : (
              <option value="">Thinking</option>
            )}
          </select>
        </div>
        {app.sending ? (
          <button className="danger" onClick={() => void app.stop()}>
            Stop
          </button>
        ) : (
          <button
            className="send"
            onClick={() => void app.send()}
            disabled={!app.composer.trim() && app.attachments.length === 0}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
