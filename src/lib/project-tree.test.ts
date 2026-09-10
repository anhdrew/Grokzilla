import { describe, expect, it } from "vitest";
import { expandSelectedIfAllowed, toggleExpanded } from "./project-tree";

describe("toggleExpanded", () => {
  it("closes an open folder on the first click", () => {
    const result = toggleExpanded(new Set(["/tmp/app"]), "/tmp/app/");
    expect([...result.expanded]).toEqual([]);
    expect(result.userCollapsed).toBe("/tmp/app");
  });

  it("opens a closed folder", () => {
    const result = toggleExpanded(new Set(), "/tmp/app");
    expect([...result.expanded]).toEqual(["/tmp/app"]);
    expect(result.userCollapsed).toBeNull();
  });
});

describe("expandSelectedIfAllowed", () => {
  it("does not reopen a folder the user just collapsed", () => {
    expect(expandSelectedIfAllowed(new Set(), "/tmp/app", "/tmp/app/")).toBeNull();
  });

  it("expands the selected folder when the user did not collapse it", () => {
    const next = expandSelectedIfAllowed(new Set(), "/tmp/app", "/tmp/other");
    expect([...next!]).toEqual(["/tmp/app"]);
  });

  it("leaves an already-open selected folder alone", () => {
    expect(expandSelectedIfAllowed(new Set(["/tmp/app"]), "/tmp/app", null)).toBeNull();
  });
});
