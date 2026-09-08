export type TokenKind = "slash" | "at";

export type ActiveToken = {
  kind: TokenKind;
  query: string;
  start: number;
  end: number;
  hidden: boolean;
};

export function activeToken(text: string, cursor: number): ActiveToken | null {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, pos);
  let start = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(before[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  const token = before.slice(start);
  if (token.startsWith("@")) {
    const body = token.slice(1);
    const hidden = body.startsWith("!");
    return {
      kind: "at",
      query: hidden ? body.slice(1) : body,
      start,
      end: pos,
      hidden,
    };
  }
  if (token.startsWith("/") && start === 0) {
    return {
      kind: "slash",
      query: token.slice(1),
      start,
      end: pos,
      hidden: false,
    };
  }
  return null;
}

export function replaceToken(text: string, token: ActiveToken, insert: string): string {
  return text.slice(0, token.start) + insert + text.slice(token.end);
}

export const APP_COMMANDS = [
  { name: "new", description: "Start a new thread", source: "app" },
  { name: "clear", description: "Start a new thread", source: "app" },
  { name: "resume", description: "Open a session by id", source: "app", hint: "session id" },
  { name: "view", description: "Open a session read-only", source: "app", hint: "session id" },
  { name: "plan", description: "Switch to plan mode", source: "app", hint: "what to plan" },
  { name: "view-plan", description: "Open the saved plan", source: "app" },
  { name: "always-approve", description: "Skip permission prompts", source: "app" },
  { name: "effort", description: "Set thinking level", source: "app", hint: "low | medium | high | xhigh" },
  { name: "compact", description: "Compress conversation history", source: "app", hint: "what to keep" },
];
