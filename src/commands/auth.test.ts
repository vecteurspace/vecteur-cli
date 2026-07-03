import { describe, expect, it } from "vitest";
import { formatDeviceInstructions } from "./auth.js";

describe("formatDeviceInstructions", () => {
  it("contains the verification uri and user code", () => {
    const instructions = formatDeviceInstructions("https://vecteur.space/device", "ABCD-EFGH");

    expect(instructions).toContain("https://vecteur.space/device");
    expect(instructions).toContain("ABCD-EFGH");
    expect(instructions).toContain("https://vecteur.space/device?code=ABCD-EFGH");
  });
});
