import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { api } from "../lib/api";
import { getExplorerDrag } from "../lib/explorer-drag";
import { APP_COMMANDS, activeToken, replaceToken } from "../lib/tokens";
import { isReadOnlySession, normalizeModeId } from "../lib/format";
import { MODES, useApp } from "../lib/store";
import type { PathHit, SlashCommand } from "../lib/types";
import { IconFile, IconFolder } from "./icons";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
const EMPTY_COMMANDS: SlashCommand[] = [];

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

export const Composer = memo(function Composer() {
  const composer = useApp((s) => s.composer);
  const setComposer = useApp((s) => s.setComposer);
  const attachments = useApp((s) => s.attachments);
  const addAttachment = useApp((s) => s.addAttachment);
  const removeAttachment = useApp((s) => s.removeAttachment);
  const attachEntry = useApp((s) => s.attachEntry);
  const selectedCwd = useApp((s) => s.selectedCwd);
  const selectedSession = useApp((s) => s.selectedSession);
  const skills = useApp((s) => s.skills);
  const sessionCommands = useApp((s) => {
    const id = s.selectedSession;
    return id ? (s.transcripts[id]?.commands ?? EMPTY_COMMANDS) : EMPTY_COMMANDS;
  });
  const modeId = useApp((s) => {
    const id = s.selectedSession;
    const raw = id ? s.transcripts[id]?.modeId : undefined;
    return normalizeModeId(raw) ?? raw;
  });
  const models = useApp((s) => s.models);
  const currentModel = useApp((s) => s.currentModel);
  const efforts = useApp((s) => s.efforts);
  const currentEffort = useApp((s) => s.currentEffort);
  const headless = useApp((s) =>
    Boolean(s.threads.find((item) => item.sessionId === s.selectedSession)?.headless),
  );
  const readOnly = useApp((s) => isReadOnlySession(s.selectedSession, s.threads, s.readOnlyIds));
  const sending = useApp((s) => s.sending);
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const setMode = useApp((s) => s.setMode);
  const setModel = useApp((s) => s.setModel);
  const setEffort = useApp((s) => s.setEffort);
  const area = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<PathHit[]>([]);
  const [active, setActive] = useState(0);
  const [dragDepth, setDragDepth] = useState(0);
  const token = activeToken(composer, cursor);

  const commands = useMemo(() => {
    const merged: SlashCommand[] = [...APP_COMMANDS];
    const seen = new Set(merged.map((c) => c.name));
    for (const command of sessionCommands) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      merged.push({ ...command, source: command.source ?? "session" });
    }
    for (const skill of skills) {
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
  }, [skills, sessionCommands, token]);

  useEffect(() => {
    if (token?.kind !== "at" || !selectedCwd) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      const q = token.hidden ? `!${token.query}` : token.query;
      void api.searchPaths(selectedCwd, q).then((rows) => {
        setHits(rows);
        setActive(0);
      });
    }, 80);
    return () => window.clearTimeout(handle);
  }, [token?.kind, token?.query, token?.hidden, selectedCwd]);

  useEffect(() => {
    setActive(0);
  }, [token?.kind, token?.query]);

  const menu = token?.kind === "slash" ? "slash" : token?.kind === "at" ? "at" : null;
  const menuCount = menu === "slash" ? commands.length : hits.length;

  function acceptAt(hit: PathHit) {
    if (!token || token.kind !== "at") return;
    const insert = `@${hit.rel} `;
    const next = replaceToken(composer, token, insert);
    setComposer(next);
    addAttachment({
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
    const next = replaceToken(composer, token, insert);
    setComposer(next);
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
      void send();
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
        const cwd = selectedCwd ?? "";
        rel = path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\//, "") : file.name || path;
      }
      addAttachment({
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
      attachEntry({
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
      {attachments.length ? (
        <div className="chips">
          {attachments.map((item) => (
            <button
              key={item.path}
              className="chip"
              onClick={() => removeAttachment(item.path)}
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
      {headless ? (
        <div className="watch-note">
          Watching a <b>grok -p</b> session. Status and results update here; Grokzilla will not send
          or attach.
        </div>
      ) : readOnly ? (
        <div className="watch-note">
          This session is open <b>read-only</b>. The transcript updates from disk; Grokzilla will
          not attach.
        </div>
      ) : null}
      <textarea
        ref={area}
        value={composer}
        placeholder={
          headless
            ? "Read-only — this grok -p session is watch-only"
            : readOnly
              ? "Read-only — paste another session id in the sidebar to switch"
              : "Message Grokzilla…  @ files  / skills  drop images"
        }
        disabled={readOnly}
        onChange={(e) => {
          setComposer(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onClick={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        <div className="composer-controls">
          <div className="modes" role="radiogroup" aria-label="Mode">
            {MODES.map((mode) => {
              const on = modeId === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`mode ${on ? "on" : ""}`}
                  disabled={!selectedSession || readOnly}
                  onClick={() => {
                    if (on) return;
                    void setMode(mode.id);
                  }}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          <select
            className="select composer-select"
            value={currentModel ?? ""}
            disabled={!selectedSession || readOnly}
            onChange={(e) => void setModel(e.target.value)}
            aria-label="Model"
          >
            {(models.length ? models : [{ modelId: "grok-4.6", name: "Grok 4.6" }]).map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.name ?? model.modelId}
              </option>
            ))}
          </select>
          <select
            className="select composer-select"
            title="Thinking level"
            value={currentEffort ?? ""}
            disabled={!selectedSession || readOnly || efforts.length === 0}
            onChange={(e) => void setEffort(e.target.value)}
            aria-label="Thinking"
          >
            {efforts.length ? (
              efforts.map((effort) => (
                <option key={effort.id} value={effort.id} title={effort.description}>
                  {effort.label}
                </option>
              ))
            ) : (
              <option value="">Thinking</option>
            )}
          </select>
        </div>
        {sending && !readOnly ? (
          <button className="danger" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button
            className="send"
            onClick={() => void send()}
            disabled={readOnly || (!composer.trim() && attachments.length === 0)}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
});
