import { describe, expect, it } from "vitest";
import {
  isLocalMediaSrc,
  isSessionMediaSrc,
  isWebSrc,
  keepMediaUrl,
  mediaKind,
  toolMedia,
} from "./media";

describe("media src helpers", () => {
  it("keeps http and relative urls, drops javascript", () => {
    expect(isWebSrc("https://cdn.example/a.png")).toBe(true);
    expect(isWebSrc("data:image/png;base64,abc")).toBe(true);
    expect(isWebSrc("images/1.jpg")).toBe(false);
    expect(keepMediaUrl("images/1.jpg")).toBe("images/1.jpg");
    expect(keepMediaUrl("javascript:alert(1)")).toBe("");
  });

  it("detects grok session media paths", () => {
    expect(isSessionMediaSrc("images/1.jpg")).toBe(true);
    expect(isSessionMediaSrc("videos/2.mp4")).toBe(true);
    expect(isSessionMediaSrc("./images/3.png")).toBe(true);
    expect(isSessionMediaSrc("assets/hero.png")).toBe(false);
    expect(mediaKind("images/1.jpg")).toBe("image");
    expect(mediaKind("videos/1.mp4")).toBe("video");
    expect(isLocalMediaSrc("images/1.jpg")).toBe(true);
    expect(isLocalMediaSrc("https://x/a.png")).toBe(false);
    expect(isLocalMediaSrc("src/App.tsx")).toBe(false);
  });
});

describe("toolMedia", () => {
  it("reads ImageGen rawOutput", () => {
    expect(
      toolMedia({
        type: "ImageGen",
        path: "/tmp/session/images/1.jpg",
        filename: "1.jpg",
        session_folder: "images",
      }),
    ).toEqual({
      path: "/tmp/session/images/1.jpg",
      filename: "1.jpg",
      kind: "image",
    });
  });

  it("parses JSON tool content from grok", () => {
    const text = JSON.stringify({
      path: "/tmp/session/images/2.jpg",
      filename: "2.jpg",
      session_folder: "images",
      message: "Image generated",
    });
    expect(
      toolMedia(undefined, [{ type: "content", content: { type: "text", text } }]),
    ).toEqual({
      path: "/tmp/session/images/2.jpg",
      filename: "2.jpg",
      kind: "image",
    });
  });
});
