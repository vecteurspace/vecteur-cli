import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { App } from "./App.js";

const props = {
  project: "project-123456789",
  cwd: "/tmp/vecteur-workspace",
  created: false,
  userLabel: "tester",
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("App", () => {
  afterEach(() => cleanup());

  it("renders the header brand and input placeholder", () => {
    const { lastFrame } = render(<App {...props} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Vecteur");
    expect(frame).toContain("Ask anything");
  });

  it("shows matching slash commands while typing", async () => {
    const { stdin, lastFrame } = render(<App {...props} />);

    await tick();
    stdin.write("/");
    await tick();
    stdin.write("h");
    await tick();
    stdin.write("e");
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("/help");
    expect(frame).toContain("show this help");
  });
});
