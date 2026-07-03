import React from "react";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import { test, expect } from "vitest";

// Definitive: pressing Enter SUBMITS. Use the network-free /help slash command.
test("Enter submits: /help executes and the input clears", async () => {
  const { stdin, lastFrame } = render(<App project="p1" cwd="/tmp/ws" created={false} />);
  await new Promise((r) => setTimeout(r, 50));
  stdin.write("/help");
  await new Promise((r) => setTimeout(r, 50));
  stdin.write("\r"); // Enter
  await new Promise((r) => setTimeout(r, 120));
  const frame = lastFrame() ?? "";
  // (a) HELP executed → its body (only present in the real HELP text) is on screen
  expect(frame).toMatch(/@path|\/files|attach a local file/);
  // (b) input cleared → the placeholder is showing again
  expect(frame).toContain("Ask anything");
});
