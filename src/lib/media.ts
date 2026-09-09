import { api, type ChatMedia } from "./api";

const WEB_SRC = /^(https?:|data:|blob:|asset:|tauri:)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const SESSION_MEDIA = /^(?:\.\.?\/)*(images|videos)(?:\/|$)/i;
const MEDIA_TYPES = new Set([
  "imagegen",
  "imageedit",
  "imagetovideo",
  "referencetovideo",
  "videogen",
]);

const cache = new Map<string, Promise<ChatMedia>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isWebSrc(src: string): boolean {
  return WEB_SRC.test(src.trim());
}

export function keepMediaUrl(url: string): string {
  const value = url.trim();
  if (!value || /^javascript:/i.test(value)) return "";
  return value;
}

export function mediaKind(src: string): "image" | "video" | null {
  const path = src.trim().split(/[?#]/)[0];
  if (IMAGE_EXT.test(path)) return "image";
  if (VIDEO_EXT.test(path)) return "video";
  return null;
}

export function isSessionMediaSrc(src: string): boolean {
  const path = src.trim().replace(/^file:\/\/(localhost)?/i, "");
  return SESSION_MEDIA.test(path);
}

export function isLocalMediaSrc(src?: string | null): boolean {
  if (!src) return false;
  const value = src.trim();
  if (!value || isWebSrc(value)) return false;
  return mediaKind(value) != null || isSessionMediaSrc(value);
}

export type ToolMedia = {
  path: string;
  filename?: string;
  kind: "image" | "video";
};

export function toolMedia(output: unknown, content?: unknown): ToolMedia | null {
  const fromRecord = (value: unknown): ToolMedia | null => {
    const rec = asRecord(value);
    if (!rec) return null;
    const path = typeof rec.path === "string" ? rec.path : "";
    if (!path) return null;
    const type = String(rec.type ?? rec.variant ?? "").toLowerCase();
    const folder = String(rec.session_folder ?? rec.sessionFolder ?? "").toLowerCase();
    const filename = typeof rec.filename === "string" ? rec.filename : undefined;
    const kind = mediaKind(path) ?? (folder === "videos" || type.includes("video") ? "video" : "image");
    if (MEDIA_TYPES.has(type) || folder === "images" || folder === "videos" || mediaKind(path)) {
      return { path, filename, kind };
    }
    return null;
  };

  const walk = (value: unknown, depth: number): ToolMedia | null => {
    if (depth > 6 || value == null) return null;
    const hit = fromRecord(value);
    if (hit) return hit;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") && trimmed.includes("path")) {
        try {
          return fromRecord(JSON.parse(trimmed) as unknown);
        } catch {
          return null;
        }
      }
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const rec = asRecord(value);
    if (!rec) return null;
    return walk(rec.content, depth + 1) ?? walk(rec.text, depth + 1);
  };

  return fromRecord(output) ?? walk(content, 0);
}

export function loadChatMedia(sessionId: string, cwd: string, src: string): Promise<ChatMedia> {
  const key = `${sessionId}\0${cwd}\0${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = api.readChatMedia(sessionId, cwd, src).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}
