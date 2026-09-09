import { describe, expect, it } from "vitest";
import { defaults, normalizeWorkspace } from "./workspace";

describe("workspace metadata", () => {
  it("fills missing fields from defaults", () => {
    const data = normalizeWorkspace({
      version: 1,
      settings: { concurrency: 2, theme: "dark" },
      selectedCwd: "/tmp/app",
    });
    expect(data.settings.theme).toBe("dark");
    expect(data.settings.concurrency).toBe(2);
    expect(data.settings.defaultMode).toBe("ask");
    expect(data.layout.rightOpen).toBe(true);
    expect(data.selectedCwd).toBe("/tmp/app");
    expect(data.tasks).toEqual({});
  });

  it("keeps a named theme and falls back on unknown ids", () => {
    expect(normalizeWorkspace({ version: 1, settings: { theme: "kaiju" } }).settings.theme).toBe("kaiju");
    expect(
      normalizeWorkspace({ version: 1, settings: { theme: "neon" as never } }).settings.theme,
    ).toBe("system");
  });

  it("keeps a per-theme kaiju choice", () => {
    const data = normalizeWorkspace({
      version: 1,
      settings: { theme: "paper", kaiju: { paper: "mothra", dark: "nope" as never } },
    });
    expect(data.settings.kaiju.paper).toBe("mothra");
    expect(data.settings.kaiju.dark).toBe("none");
  });

  it("clamps concurrency and rejects unknown versions", () => {
    expect(normalizeWorkspace({ version: 1, settings: { concurrency: 99 } }).settings.concurrency).toBe(8);
    expect(normalizeWorkspace({ version: 1, settings: { concurrency: 0 } }).settings.concurrency).toBe(1);
    expect(() => normalizeWorkspace({ version: 2 } as never)).toThrow(/Unsupported workspace version/);
  });

  it("keeps default layout sizes when a partial layout is stored", () => {
    const data = normalizeWorkspace({ version: 1, layout: { terminalOpen: true } });
    expect(data.layout.sidebar).toBe(defaults.layout.sidebar);
    expect(data.layout.terminalOpen).toBe(true);
  });
});
