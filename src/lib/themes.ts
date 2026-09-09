export const NAMED_THEMES = [
  { id: "kaiju", label: "Kaiju", scheme: "dark", swatch: "#0b1214" },
  { id: "carbon", label: "Carbon", scheme: "dark", swatch: "#111113" },
  { id: "paper", label: "Paper", scheme: "light", swatch: "#f3efe6" },
  { id: "abyss", label: "Abyss", scheme: "dark", swatch: "#0b1220" },
  { id: "ember", label: "Ember", scheme: "dark", swatch: "#1a1410" },
] as const;

export type NamedThemeId = (typeof NAMED_THEMES)[number]["id"];
export type ThemeId = "light" | "dark" | NamedThemeId;
export type ThemePreference = "system" | ThemeId;

export const KAIJU_OPTIONS = [
  { id: "none", label: "None" },
  { id: "godzilla", label: "Godzilla" },
  { id: "ghidorah", label: "Ghidorah" },
  { id: "mothra", label: "Mothra" },
  { id: "mecha", label: "Mecha" },
  { id: "anguirus", label: "Anguirus" },
] as const;

export type KaijuId = (typeof KAIJU_OPTIONS)[number]["id"];
export type KaijuByTheme = Partial<Record<ThemeId, KaijuId>>;

export const THEME_CHOICES: Array<{ id: ThemePreference; label: string; swatch: string }> = [
  { id: "system", label: "System", swatch: "linear-gradient(135deg, #f4f4f5 50%, #1b1b1d 50%)" },
  { id: "light", label: "Light", swatch: "#f4f4f5" },
  { id: "dark", label: "Dark", swatch: "#1b1b1d" },
  ...NAMED_THEMES.map(({ id, label, swatch }) => ({ id, label, swatch })),
];

const NAMED_IDS = new Set<string>(NAMED_THEMES.map((theme) => theme.id));
const ALL_IDS = new Set<string>(["system", "light", "dark", ...NAMED_IDS]);
const THEME_KEYS = new Set<string>(["light", "dark", ...NAMED_IDS]);
const KAIJU_IDS = new Set<string>(KAIJU_OPTIONS.map((option) => option.id));

export function normalizeThemeId(raw?: string | null): ThemePreference {
  if (raw && ALL_IDS.has(raw)) return raw as ThemePreference;
  return "system";
}

export function isDarkTheme(theme: string | null | undefined): boolean {
  if (!theme || theme === "light" || theme === "paper") return false;
  if (theme === "system") {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return true;
}

export function resolveTheme(preference: ThemePreference, darkOs = false): ThemeId {
  if (preference === "system") return darkOs ? "dark" : "light";
  return preference;
}

export function normalizeKaijuId(raw?: string | null): KaijuId {
  if (raw && KAIJU_IDS.has(raw)) return raw as KaijuId;
  return "none";
}

export function normalizeKaijuMap(raw?: unknown): KaijuByTheme {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next: KaijuByTheme = {};
  for (const [theme, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!THEME_KEYS.has(theme)) continue;
    next[theme as ThemeId] = normalizeKaijuId(typeof value === "string" ? value : null);
  }
  return next;
}

export function kaijuForTheme(map: KaijuByTheme | undefined, theme: ThemeId): KaijuId {
  if (map && Object.prototype.hasOwnProperty.call(map, theme)) return map[theme] ?? "none";
  return theme === "kaiju" ? "godzilla" : "none";
}
