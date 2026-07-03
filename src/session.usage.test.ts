import { describe, expect, it } from "vitest";
import { formatUsage, unitsAsTime } from "./session.js";

describe("unitsAsTime (1,000 units ≈ 1 min — shared vocabulary)", () => {
  it("renders minutes under an hour", () => expect(unitsAsTime(45_000)).toBe("45 min"));
  it("renders hours + minutes", () => expect(unitsAsTime(6_300_000)).toBe("105h"));
  it("renders derived-scale allowances", () =>
    expect(unitsAsTime(50_409_577)).toBe("840h 10m"));
  it("renders unlimited", () => expect(unitsAsTime(-1)).toBe("unlimited"));
});

describe("formatUsage", () => {
  it("renders plan, usage, forecast, grants and credits from real shapes", () => {
    const out = formatUsage({
      account_type: "basic",
      credit_balance_eur: 12.5,
      tokens: {
        daily_used: 1_000_000,
        daily_limit: 50_409_577,
        monthly_used: 30_000_000,
        monthly_limit: 1_008_191_556,
      },
      forecast: { projected_pct_of_limit: 42.5, depletion_date: null },
      grants: [
        { label: "team pool", remaining_units: 3_000_000, shared_member_count: 4, expires_at: "2026-07-31T00:00:00Z" },
      ],
    });
    expect(out).toContain("plan: BASIC");
    expect(out).toContain("left of 840h 10m");
    expect(out).toContain("~42.5% of your monthly allowance");
    expect(out).toContain("granted:    50h left (team pool) · shared with 4 · expires 2026-07-31");
    expect(out).toContain("credits:    €12.50");
  });

  it("degrades gracefully with no tokens block", () => {
    expect(formatUsage({ account_type: "free" })).toContain("plan: FREE");
  });
});
