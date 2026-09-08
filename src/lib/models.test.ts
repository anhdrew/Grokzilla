import { describe, expect, it } from "vitest";
import { mergeModelState, modelsFrom } from "./models";

const grok46 = {
  modelId: "grok-4.6",
  name: "Grok 4.6",
  _meta: {
    supportsReasoningEffort: true,
    reasoningEffort: "xhigh",
    reasoningEfforts: [
      { id: "xhigh", value: "xhigh", label: "Extra High Effort", description: "Highest effort" },
      { id: "high", value: "high", label: "High Effort", default: true },
      { id: "medium", value: "medium", label: "Medium Effort" },
      { id: "low", value: "low", label: "Low Effort" },
    ],
  },
};

const grok45 = {
  modelId: "grok-4.5",
  name: "Grok 4.5",
  _meta: {
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    reasoningEfforts: [
      { id: "high", value: "high", label: "High Effort" },
      { id: "medium", value: "medium", label: "Medium Effort" },
      { id: "low", value: "low", label: "Low Effort" },
    ],
  },
};

describe("modelsFrom", () => {
  it("reads initialize _meta.modelState", () => {
    const parsed = modelsFrom({
      _meta: { modelState: { currentModelId: "grok-4.6", availableModels: [grok46, grok45] } },
    });
    expect(parsed.currentModel).toBe("grok-4.6");
    expect(parsed.models.map((m) => m.modelId)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(parsed.efforts.map((e) => e.id)).toEqual(["xhigh", "high", "medium", "low"]);
    expect(parsed.efforts[0]).toMatchObject({ id: "xhigh", label: "Extra High" });
    expect(parsed.currentEffort).toBe("xhigh");
  });

  it("reads session/new models + sessionConfig selected effort", () => {
    const parsed = modelsFrom({
      sessionId: "sess",
      models: { currentModelId: "grok-4.6", availableModels: [grok46, grok45] },
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "grok-4.6", category: "model", label: "Grok 4.6", selected: true },
            { id: "xhigh", category: "mode", label: "Extra High Effort", selected: false },
            { id: "high", category: "mode", label: "High Effort", selected: true },
            { id: "medium", category: "mode", label: "Medium Effort", selected: false },
            { id: "low", category: "mode", label: "Low Effort", selected: false },
          ],
        },
      },
    });
    expect(parsed.currentEffort).toBe("high");
    expect(parsed.efforts.map((e) => e.label)).toEqual(["Extra High", "High", "Medium", "Low"]);
  });

  it("does not treat permission modes as thinking levels", () => {
    const parsed = modelsFrom({
      models: { currentModelId: "grok-4.6", availableModels: [grok46] },
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "ask", category: "mode", label: "Ask", selected: true },
            { id: "plan", category: "mode", label: "Plan", selected: false },
          ],
        },
      },
    });
    expect(parsed.efforts.map((e) => e.id)).toEqual(["xhigh", "high", "medium", "low"]);
    expect(parsed.currentEffort).toBe("xhigh");
  });

  it("disables efforts when the model has none", () => {
    const parsed = modelsFrom({
      models: {
        currentModelId: "plain",
        availableModels: [{ modelId: "plain", name: "Plain", _meta: { supportsReasoningEffort: false } }],
      },
    });
    expect(parsed.efforts).toEqual([]);
    expect(parsed.currentEffort).toBeUndefined();
  });
});

describe("mergeModelState", () => {
  it("keeps previous models when incoming is empty", () => {
    const prev = modelsFrom({ models: { currentModelId: "grok-4.6", availableModels: [grok46] } });
    const merged = mergeModelState(prev, { models: [], efforts: [] });
    expect(merged.currentModel).toBe("grok-4.6");
    expect(merged.efforts.map((e) => e.id)).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("drops extra-high when switching to a model that lacks it", () => {
    const prev = modelsFrom({ models: { currentModelId: "grok-4.6", availableModels: [grok46, grok45] } });
    const incoming = modelsFrom({
      models: { currentModelId: "grok-4.5", availableModels: [grok46, grok45] },
    });
    const merged = mergeModelState(prev, incoming);
    expect(merged.currentModel).toBe("grok-4.5");
    expect(merged.currentEffort).toBe("high");
    expect(merged.efforts.map((e) => e.id)).toEqual(["high", "medium", "low"]);
  });
});
