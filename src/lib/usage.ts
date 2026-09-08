export type UsageInfo = {
  percent: number | null;
  resetsAt: string | null;
  startedAt: string | null;
  periodType: string | null;
  tier: string | null;
};

const SAMPLES_KEY = "gz.usage.samples";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type UsageSample = { t: number; percent: number; periodEnd: string | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function centVal(value: unknown): number | null {
  const rec = asRecord(value);
  if (!rec) return typeof value === "number" ? value : null;
  const val = rec.val;
  return typeof val === "number" ? val : null;
}

function periodTypeLabel(raw?: string | null): string | null {
  if (!raw) return null;
  if (/weekly/i.test(raw)) return "week";
  if (/monthly/i.test(raw)) return "month";
  if (/daily/i.test(raw)) return "day";
  return null;
}

export function usageFrom(raw: unknown): UsageInfo {
  const root = asRecord(raw) ?? {};
  const config = asRecord(root.config) ?? root;
  const period = asRecord(config.currentPeriod);
  const percentRaw = config.creditUsagePercent;
  let percent = typeof percentRaw === "number" && Number.isFinite(percentRaw) ? percentRaw : null;
  if (percent == null) {
    const used = centVal(config.used) ?? centVal(asRecord(config.usage)?.includedUsed) ?? centVal(asRecord(config.usage)?.totalUsed);
    const limit = centVal(config.monthlyLimit);
    if (used != null && limit && limit > 0) percent = (used / limit) * 100;
  }
  const resetsAt =
    (typeof period?.end === "string" && period.end) ||
    (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd) ||
    null;
  const startedAt =
    (typeof period?.start === "string" && period.start) ||
    (typeof config.billingPeriodStart === "string" && config.billingPeriodStart) ||
    null;
  const periodType =
    periodTypeLabel(typeof period?.type === "string" ? period.type : null) ||
    (resetsAt ? "period" : null);
  const tier =
    (typeof root.subscriptionTier === "string" && root.subscriptionTier) ||
    (typeof config.subscriptionTier === "string" && config.subscriptionTier) ||
    null;
  return {
    percent: percent == null ? null : Math.min(100, Math.max(0, percent)),
    resetsAt,
    startedAt,
    periodType,
    tier,
  };
}

export function gmtOffsetLabel(date = new Date()): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return mins ? `GMT${sign}${hours}:${String(mins).padStart(2, "0")}` : `GMT${sign}${hours}`;
}

export function formatLocalStamp(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.getDate();
  const month = MONTHS[date.getMonth()] ?? "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${month} ${hh}:${mm} ${gmtOffsetLabel(date)}`;
}

function readSamples(): UsageSample[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(SAMPLES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is UsageSample =>
        item &&
        typeof item === "object" &&
        typeof item.t === "number" &&
        typeof item.percent === "number",
    );
  } catch {
    return [];
  }
}

export function rememberUsageSample(usage: UsageInfo, now = Date.now()): void {
  if (usage.percent == null) return;
  try {
    if (typeof localStorage === "undefined") return;
    const cutoff = now - 36 * 3600_000;
    const next = readSamples()
      .filter((sample) => sample.t >= cutoff && sample.periodEnd === usage.resetsAt)
      .concat({ t: now, percent: usage.percent, periodEnd: usage.resetsAt });
    localStorage.setItem(SAMPLES_KEY, JSON.stringify(next.slice(-72)));
  } catch {
    /* ignore quota / private mode */
  }
}

function projectEmptyAt(
  percent: number,
  t0: number,
  p0: number,
  now: number,
  reset: number,
): number | null {
  if (now <= t0) return null;
  const gained = percent - p0;
  const elapsed = now - t0;
  if (gained <= 0.2 || elapsed < 10 * 60_000) return null;
  const emptyAt = now + ((100 - percent) / gained) * elapsed;
  if (Number.isFinite(reset) && emptyAt >= reset - 60_000) return null;
  return emptyAt;
}

export function estimateEmptyAt(
  usage: UsageInfo,
  now = Date.now(),
  samples?: UsageSample[],
): number | null {
  const percent = usage.percent;
  if (percent == null || percent <= 0) return null;
  if (percent >= 99.5) return now;

  const reset = usage.resetsAt ? Date.parse(usage.resetsAt) : NaN;
  const periodSamples = (samples ?? readSamples()).filter(
    (sample) => sample.periodEnd === usage.resetsAt,
  );
  if (periodSamples.length >= 2 && now - periodSamples[0]!.t >= 30 * 60_000) {
    const fromSamples = projectEmptyAt(
      percent,
      periodSamples[0]!.t,
      periodSamples[0]!.percent,
      now,
      reset,
    );
    if (fromSamples != null) return fromSamples;
  }

  const start = usage.startedAt ? Date.parse(usage.startedAt) : NaN;
  if (!Number.isFinite(start)) return null;
  return projectEmptyAt(percent, start, 0, now, reset);
}
