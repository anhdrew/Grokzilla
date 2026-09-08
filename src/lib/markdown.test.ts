import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./markdown";

describe("splitMarkdownBlocks", () => {
  it("keeps a single paragraph intact", () => {
    expect(splitMarkdownBlocks("Hello world")).toEqual(["Hello world"]);
  });

  it("splits on blank lines and round-trips", () => {
    const text = "Hello\n\nWorld";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toEqual(["Hello", "World"]);
    expect(blocks.join("\n\n")).toBe(text);
  });

  it("does not split inside a fenced code block", () => {
    const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toEqual(["Intro", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Outro"]);
    expect(blocks.join("\n\n")).toBe(text);
  });

  it("keeps earlier blocks stable as the tail grows", () => {
    const prefix = splitMarkdownBlocks("# Title\n\nFirst paragraph");
    const grown = splitMarkdownBlocks("# Title\n\nFirst paragraph and more");
    expect(grown[0]).toBe(prefix[0]);
    expect(grown[0]).toBe("# Title");
    expect(grown[1]).toBe("First paragraph and more");
  });

  it("preserves extra blank lines", () => {
    const text = "a\n\n\nb";
    expect(splitMarkdownBlocks(text).join("\n\n")).toBe(text);
  });
});
