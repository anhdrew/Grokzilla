import { describe, expect, it } from "vitest";
import { activeToken, replaceToken } from "./tokens";

describe("activeToken", () => {
  it("detects @ mentions", () => {
    const token = activeToken("see @src/ap", 11);
    expect(token).toMatchObject({ kind: "at", query: "src/ap", start: 4 });
  });

  it("detects hidden @!", () => {
    expect(activeToken("@!.env", 6)?.hidden).toBe(true);
    expect(activeToken("@!.env", 6)?.query).toBe(".env");
  });

  it("detects slash at start", () => {
    expect(activeToken("/comp", 5)).toMatchObject({ kind: "slash", query: "comp" });
  });

  it("detects slash after other words", () => {
    expect(activeToken("please /comp", 12)).toMatchObject({
      kind: "slash",
      query: "comp",
      start: 7,
    });
  });

  it("ignores slash inside a path", () => {
    expect(activeToken("src/app", 7)).toBeNull();
  });

  it("closes after whitespace", () => {
    expect(activeToken("/compact keep", 13)).toBeNull();
  });

  it("replaces the token", () => {
    expect(replaceToken("look @fo", { kind: "at", query: "fo", start: 5, end: 8, hidden: false }, "@src/foo.ts ")).toBe(
      "look @src/foo.ts ",
    );
  });
});
