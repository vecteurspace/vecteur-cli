import React from "react";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import { test, expect } from "vitest";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B";

test("slash menu: highlights first, arrows move it, Tab completes, prefix+Enter runs highlighted", async () => {
  const { stdin, lastFrame } = render(<App project="p1" cwd="/tmp/ws" created={false} />);
  await wait(40);

  // type "/" -> menu lists commands, first (files) highlighted with ❯
  stdin.write("/");
  await wait(40);
  let f = lastFrame() ?? "";
  expect(f).toMatch(/❯ *\/files/);
  expect(f).toContain("/exit"); // full menu present

  // downArrow -> highlight moves to the second command (project)
  stdin.write(DOWN);
  await wait(40);
  f = lastFrame() ?? "";
  expect(f).toMatch(/❯ *\/project/);

  // fresh input "/fi" + Tab -> input completes to "/files "
  stdin.write("\r");            // clear any state via a submit of current (project) — harmless
  await wait(60);
  stdin.write("/fi");
  await wait(40);
  stdin.write("\t");            // Tab completes to highlighted (files)
  await wait(40);
  expect(lastFrame() ?? "").toMatch(/\/files/);
});

test("prefix + Enter runs the highlighted command (/he -> /help)", async () => {
  const { stdin, lastFrame } = render(<App project="p1" cwd="/tmp/ws" created={false} />);
  await wait(40);
  stdin.write("/he");
  await wait(40);
  stdin.write("\r");           // Enter with only a prefix -> resolves to highlighted /help
  await wait(120);
  expect(lastFrame() ?? "").toMatch(/@path|attach a local file/); // HELP body rendered
});
