import { describe, expect, it } from "vitest";
import { loadArchive, saveArchive, withArchived, withoutArchived, type StorageLike } from "./archive";

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("archive persistence", () => {
  it("round-trips thread and project ids", () => {
    const storage = memory();
    saveArchive({ threads: ["s1", "s1", "s2"], projects: ["/tmp/a"] }, storage);
    expect(loadArchive(storage)).toEqual({
      threads: ["s1", "s2"],
      projects: ["/tmp/a"],
    });
  });

  it("returns empty lists for missing or invalid data", () => {
    const storage = memory();
    storage.setItem("gz.archived.threads", "{not json");
    expect(loadArchive(storage)).toEqual({ threads: [], projects: [] });
    expect(loadArchive(null)).toEqual({ threads: [], projects: [] });
  });

  it("adds and removes ids", () => {
    expect(withArchived(["a"], "b")).toEqual(["a", "b"]);
    expect(withArchived(["a"], "a")).toEqual(["a"]);
    expect(withoutArchived(["a", "b"], "a")).toEqual(["b"]);
  });
});
