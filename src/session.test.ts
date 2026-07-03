import { describe, expect, test } from "vitest";
import { titleFromPrompt } from "./session.js";

describe("titleFromPrompt", () => {
  test("collapses whitespace and keeps short prompts", () => {
    expect(titleFromPrompt("  How  many\n sats? ")).toBe("How many sats?");
  });
  test("caps long prompts to 60 chars with an ellipsis", () => {
    const long = "Design a GTO to GEO transfer comparing chemical and electric propulsion options thoroughly";
    const out = titleFromPrompt(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });
});
