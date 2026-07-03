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
});
