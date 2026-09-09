import { describe, expect, it } from "vitest";
import { isDarkTheme, kaijuForTheme, normalizeKaijuId, normalizeThemeId, resolveTheme } from "./themes";

describe("normalizeThemeId", () => {
  it("keeps known ids and falls back to system", () => {
    expect(normalizeThemeId("kaiju")).toBe("kaiju");
    expect(normalizeThemeId("paper")).toBe("paper");
    expect(normalizeThemeId("system")).toBe("system");
    expect(normalizeThemeId("neon")).toBe("system");
    expect(normalizeThemeId(null)).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("maps system to the OS palette and passes named themes through", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("kaiju")).toBe("kaiju");
    expect(resolveTheme("light")).toBe("light");
  });
});

describe("isDarkTheme", () => {
  it("treats paper and light as light, named dark palettes as dark", () => {
    expect(isDarkTheme("light")).toBe(false);
    expect(isDarkTheme("paper")).toBe(false);
    expect(isDarkTheme("dark")).toBe(true);
    expect(isDarkTheme("kaiju")).toBe(true);
    expect(isDarkTheme("carbon")).toBe(true);
    expect(isDarkTheme("abyss")).toBe(true);
    expect(isDarkTheme("ember")).toBe(true);
  });
});

describe("kaijuForTheme", () => {
  it("defaults the Kaiju palette to Godzilla and others to none", () => {
    expect(normalizeKaijuId("mothra")).toBe("mothra");
    expect(normalizeKaijuId("rodan")).toBe("none");
    expect(kaijuForTheme({}, "kaiju")).toBe("godzilla");
    expect(kaijuForTheme({}, "dark")).toBe("none");
    expect(kaijuForTheme({ kaiju: "none", dark: "ghidorah" }, "kaiju")).toBe("none");
    expect(kaijuForTheme({ kaiju: "none", dark: "ghidorah" }, "dark")).toBe("ghidorah");
  });
});
