import { describe, expect, it } from "vitest";
import { estimateEmptyAt, formatLocalStamp, gmtOffsetLabel, usageFrom } from "./usage";

describe("usageFrom", () => {
  it("prefers creditUsagePercent and currentPeriod.end", () => {
    expect(
      usageFrom({
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-06-01T00:00:00Z",
            end: "2026-06-08T00:00:00Z",
          },
        },
        subscriptionTier: "SuperGrok",
      }),
    ).toEqual({
      percent: 42.5,
      resetsAt: "2026-06-08T00:00:00Z",
      startedAt: "2026-06-01T00:00:00Z",
      periodType: "week",
      tier: "SuperGrok",
    });
  });

  it("falls back to monthly limit cents and billingPeriodEnd", () => {
    expect(
      usageFrom({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 500 },
          billingPeriodStart: "2026-04-01T00:00:00Z",
          billingPeriodEnd: "2026-05-01T00:00:00Z",
        },
      }),
    ).toMatchObject({
      percent: 25,
      resetsAt: "2026-05-01T00:00:00Z",
      startedAt: "2026-04-01T00:00:00Z",
    });
  });
});

describe("formatLocalStamp", () => {
  it("uses the machine timezone offset", () => {
    const iso = "2026-09-14T00:00:00.000Z";
    const stamp = formatLocalStamp(iso);
    expect(stamp).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2} GMT[+-]\d/);
    expect(stamp.endsWith(gmtOffsetLabel(new Date(iso)))).toBe(true);
  });
});

describe("estimateEmptyAt", () => {
  it("projects when 100% is reached from period pace", () => {
    const now = Date.parse("2026-09-08T12:00:00.000Z");
    const empty = estimateEmptyAt(
      {
        percent: 50,
        startedAt: "2026-09-08T00:00:00.000Z",
        resetsAt: "2026-09-15T00:00:00.000Z",
        periodType: "week",
        tier: null,
      },
      now,
    );
    expect(empty).toBe(Date.parse("2026-09-09T00:00:00.000Z"));
  });

  it("returns null when the period reset comes first", () => {
    const now = Date.parse("2026-09-08T12:00:00.000Z");
    expect(
      estimateEmptyAt(
        {
          percent: 10,
          startedAt: "2026-09-08T00:00:00.000Z",
          resetsAt: "2026-09-08T18:00:00.000Z",
          periodType: "week",
          tier: null,
        },
        now,
      ),
    ).toBeNull();
  });

  it("falls back to period pace when recent samples are flat", () => {
    const now = Date.parse("2026-09-08T12:00:00.000Z");
    const periodEnd = "2026-09-15T00:00:00.000Z";
    const empty = estimateEmptyAt(
      {
        percent: 50,
        startedAt: "2026-09-08T00:00:00.000Z",
        resetsAt: periodEnd,
        periodType: "week",
        tier: null,
      },
      now,
      [
        { t: now - 45 * 60_000, percent: 50, periodEnd },
        { t: now, percent: 50, periodEnd },
      ],
    );
    expect(empty).toBe(Date.parse("2026-09-09T00:00:00.000Z"));
  });
});
