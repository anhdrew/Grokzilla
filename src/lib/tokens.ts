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
  if (token.startsWith("/")) {
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

export const APP_COMMAND_NAMES = new Set([
  "new",
  "clear",
  "plan",
  "view-plan",
  "show-plan",
  "plan-view",
  "always-approve",
  "yolo",
  "effort",
  "compact",
]);
