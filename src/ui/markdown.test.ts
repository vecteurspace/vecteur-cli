import { describe, expect, it } from "vitest";
import { markdownToAnsi } from "./markdown.js";

describe("markdownToAnsi", () => {
  it("removes markdown delimiters and renders bold/code markers as ansi", () => {
    const rendered = markdownToAnsi("## Heading\n**bold** and `code`");

    expect(rendered).not.toContain("##");
    expect(rendered).not.toContain("**");
    expect(rendered).not.toContain("`");
    expect(rendered).toContain("\x1b[1mHeading\x1b[0m");
    expect(rendered).toContain("\x1b[1mbold\x1b[0m");
    expect(rendered).toContain("\x1b[2m\x1b[36mcode\x1b[0m");
  });

  it("transforms bullets and strips standalone horizontal rules", () => {
    const rendered = markdownToAnsi("---\n- one\n* two\n1. three");

    expect(rendered).not.toContain("---");
    expect(rendered).toContain("• one");
    expect(rendered).toContain("• two");
    expect(rendered).toContain("1. three");
  });

  it("strips <details>/<summary> web-UI HTML and decodes entities", () => {
    const src =
      '<details class="subagent-synthesis" data-agent="engineering">\n' +
      "<summary>🔎 engineering — reasoning &amp; results</summary>\n\n" +
      "Yes — VLEO is a subset of LEO.\n\n</details>";
    const rendered = markdownToAnsi(src);

    expect(rendered).not.toMatch(/<details|<\/details>|<summary>|<\/summary>|data-agent|class=/);
    expect(rendered).not.toContain("&amp;");
    expect(rendered).toContain("reasoning & results"); // entity decoded
    expect(rendered).toContain("▸ "); // summary rendered as a section header
    expect(rendered).toContain("Yes — VLEO is a subset of LEO."); // body kept
  });
});
