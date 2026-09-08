import type { EffortInfo, ModelInfo } from "./types";

export type { EffortInfo, ModelInfo };

export type ModelState = {
  models: ModelInfo[];
  currentModel?: string;
  efforts: EffortInfo[];
  currentEffort?: string;
};

const EFFORT_LABELS: Record<string, string> = {
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
  minimal: "Minimal",
  max: "Max",
};

export const EFFORT_CONFIG_ID = "mode";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function effortLabel(id: string, raw?: string): string {
  if (EFFORT_LABELS[id]) return EFFORT_LABELS[id];
  const stripped = (raw ?? "").replace(/\s*effort$/i, "").trim();
  return stripped || id;
}

export function parseEffort(raw: unknown): EffortInfo | null {
  if (typeof raw === "string" && raw) {
    return { id: raw, label: effortLabel(raw) };
  }
  const obj = asRecord(raw);
  if (!obj) return null;
  const id = String(obj.id ?? obj.value ?? "");
  if (!id) return null;
  const rawLabel =
    (typeof obj.label === "string" && obj.label) ||
    (typeof obj.name === "string" && obj.name) ||
    undefined;
  return {
    id,
    label: effortLabel(id, rawLabel),
    description: typeof obj.description === "string" ? obj.description : undefined,
  };
}

function parseModel(raw: unknown): ModelInfo | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const modelId = String(obj.modelId ?? obj.id ?? "");
  if (!modelId) return null;
  const meta = asRecord(obj._meta) ?? {};
  const effortsRaw = meta.reasoningEfforts ?? obj.reasoningEfforts ?? [];
  const reasoningEfforts = (Array.isArray(effortsRaw) ? effortsRaw : [])
    .map(parseEffort)
    .filter((effort): effort is EffortInfo => Boolean(effort));
  const supports =
    meta.supportsReasoningEffort === true ||
    obj.supportsReasoningEffort === true ||
    reasoningEfforts.length > 0;
  const reasoningEffort =
    (typeof meta.reasoningEffort === "string" && meta.reasoningEffort) ||
    (typeof obj.reasoningEffort === "string" && obj.reasoningEffort) ||
    undefined;
  return {
    modelId,
    name: typeof obj.name === "string" ? obj.name : undefined,
    supportsReasoningEffort: supports,
    reasoningEffort,
    reasoningEfforts,
  };
}

function modelsNode(raw: unknown): Record<string, unknown> | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const meta = asRecord(obj._meta) ?? {};
  const candidates = [obj.models, obj.modelState, meta.modelState, meta.models, obj];
  for (const candidate of candidates) {
    const node = asRecord(candidate);
    if (node && (Array.isArray(node.availableModels) || typeof node.currentModelId === "string")) {
      return node;
    }
  }
  return null;
}

function sessionConfigOptions(raw: unknown): Array<Record<string, unknown>> {
  const obj = asRecord(raw);
  if (!obj) return [];
  const meta = asRecord(obj._meta) ?? obj;
  const config = asRecord(meta["x.ai/sessionConfig"]);
  const options = config?.options;
  if (!Array.isArray(options)) return [];
  return options.map(asRecord).filter((option): option is Record<string, unknown> => Boolean(option));
}

function isEffortOption(option: Record<string, unknown>, knownIds: Set<string>): boolean {
  const id = String(option.id ?? option.value ?? "");
  if (!id) return false;
  if (knownIds.has(id) || id in EFFORT_LABELS) return true;
  return option.category === "mode" && id in EFFORT_LABELS;
}

export function modelsFrom(raw: unknown): ModelState {
  const empty: ModelState = { models: [], efforts: [] };
  const obj = asRecord(raw);
  if (!obj) return empty;

  const node = modelsNode(obj);
  const available = (node?.availableModels ?? []) as unknown[];
  const models = available.map(parseModel).filter((model): model is ModelInfo => Boolean(model));
  const currentModel =
    (typeof node?.currentModelId === "string" && node.currentModelId) ||
    (typeof obj.currentModelId === "string" && obj.currentModelId) ||
    models[0]?.modelId;

  const current = models.find((model) => model.modelId === currentModel);
  const knownIds = new Set((current?.reasoningEfforts ?? []).map((effort) => effort.id));
  const modeOptions = sessionConfigOptions(obj).filter((option) => isEffortOption(option, knownIds));
  const selected = modeOptions.find((option) => option.selected === true);
  const fromConfig = modeOptions.map(parseEffort).filter((effort): effort is EffortInfo => Boolean(effort));

  const efforts =
    current?.supportsReasoningEffort === false
      ? []
      : current?.reasoningEfforts?.length
        ? current.reasoningEfforts
        : fromConfig;

  const currentEffort = efforts.length
    ? (selected && efforts.some((effort) => effort.id === String(selected.id))
        ? String(selected.id)
        : undefined) ||
      (current?.reasoningEffort && efforts.some((effort) => effort.id === current.reasoningEffort)
        ? current.reasoningEffort
        : undefined) ||
      efforts[0]?.id
    : undefined;

  return { models, currentModel, efforts, currentEffort };
}

export function mergeModelState(prev: ModelState, incoming: ModelState): ModelState {
  const models = incoming.models.length ? incoming.models : prev.models;
  const currentModel = incoming.currentModel ?? prev.currentModel;
  const model = models.find((item) => item.modelId === currentModel);
  const efforts = incoming.efforts.length
    ? incoming.efforts
    : model?.reasoningEfforts?.length
      ? model.reasoningEfforts
      : model && model.supportsReasoningEffort === false
        ? []
        : prev.efforts;
  let currentEffort = incoming.currentEffort ?? prev.currentEffort;
  if (!efforts.length) currentEffort = undefined;
  else if (!currentEffort || !efforts.some((effort) => effort.id === currentEffort)) {
    currentEffort =
      (model?.reasoningEffort && efforts.some((effort) => effort.id === model.reasoningEffort)
        ? model.reasoningEffort
        : undefined) ?? efforts[0]?.id;
  }
  return { models, currentModel, efforts, currentEffort };
}
