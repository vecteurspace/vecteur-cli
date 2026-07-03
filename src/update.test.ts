import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";
import { isNewer } from "./update.js";

test("VERSION matches package.json (no drift)", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(VERSION).toBe(pkg.version);
});

describe("isNewer semver compare", () => {
  test.each([
    ["0.3.0", "0.2.0", true],
    ["0.2.1", "0.2.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.2.0", "0.2.0", false],
    ["0.1.9", "0.2.0", false],
    ["0.2.0-rc.1", "0.2.0", false], // prerelease suffix ignored -> equal -> not newer
    ["v0.3.0", "0.2.0", true], // tolerate leading v
  ])("isNewer(%s, %s) === %s", (a, b, expected) => {
    expect(isNewer(a, b)).toBe(expected);
  });
});
