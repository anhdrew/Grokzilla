export type SessionStatus = "idle" | "running" | "needs-input" | "error";

export type PermissionOption = {
  optionId: string;
  name: string;
  kind?: string;
};

export type PermissionRequest = {
  id: number;
  sessionId: string;
  title?: string;
  toolCall?: Record<string, unknown>;
  options: PermissionOption[];
  raw: Record<string, unknown>;
};

export type PlanDoc = {
  path: string;
  markdown: string;
  exists: boolean;
};

export type ToolLocation = { path: string; line?: number };

export type ToolBlock = {
  type: "tool";
  id: string;
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  locations?: ToolLocation[];
  collapsed: boolean;
  truncated?: boolean;
};

export type TranscriptBlock =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "thinking"; id: string; text: string; collapsed: boolean }
  | ToolBlock
  | { type: "plan"; id: string; entries: unknown[] }
  | { type: "mode"; id: string; modeId: string };

export type SlashCommand = {
  name: string;
  description?: string;
  hint?: string;
  source?: string;
};

export type Attachment = {
  path: string;
  rel: string;
  kind: "file" | "folder" | "image";
  mimeType?: string;
  preview?: string;
};

export type PathHit = {
  path: string;
  rel: string;
  kind: "file" | "folder" | string;
  score: number;
};

export type SkillInfo = {
  name: string;
  description: string;
  hint?: string | null;
  source: string;
  userInvocable: boolean;
};

export type EffortInfo = {
  id: string;
  label: string;
  description?: string;
};

export type Transcript = {
  blocks: TranscriptBlock[];
  commands: SlashCommand[];
  modeId?: string;
  effortId?: string;
  status: SessionStatus;
};

export type ThreadStats = {
  contextPercent?: number | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  turnCount?: number | null;
  toolCalls?: number | null;
  userMessages?: number | null;
  assistantMessages?: number | null;
};

export type ThreadInfo = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  summary?: string | null;
  model?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  messageCount?: number | null;
  headless?: boolean;
  watchStatus?: "running" | "done" | "error" | string;
};

export type ProjectInfo = {
  cwd: string;
  name: string;
  threadCount: number;
};

export type GrokStatus = {
  grokPath?: string | null;
  version?: string | null;
  loggedIn: boolean;
  grokHome: string;
  authPath: string;
};

export type ModelInfo = {
  modelId: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: EffortInfo[];
};

export type AcpEvent = {
  kind: "update" | "permission" | "notification" | "exit" | "log" | "error" | string;
  sessionId?: string | null;
  method?: string | null;
  id?: number | null;
  payload: unknown;
};

export type SessionUpdate = {
  sessionUpdate?: string;
  content?: unknown;
  text?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: ToolLocation[];
  entries?: unknown[];
  currentModeId?: string;
  modeId?: string;
  availableCommands?: Array<SlashCommand & { input?: { hint?: string } }>;
  truncated?: boolean;
};
