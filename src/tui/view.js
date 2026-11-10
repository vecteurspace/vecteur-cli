import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { parseMarkdown } from "../markdown.js";
import { blockContent } from "../blocks.js";
import { terminalText, plainLine, taskLines } from "../format.js";

// Unknown palette: the terminal owns its readable default pair. Only repeated metadata is faint.
export const DEFAULT_THEME = Object.freeze({ primary: "", accent: "1", attention: "1", success: "1", error: "1",
  secondary: "", quiet: "2", rule: "", band: "", strong: "1", em: "3", link: "4" });
const themeOf = color => color === true ? DEFAULT_THEME : color || null;
const RESET = { 1: "22", 2: "22", 3: "23", 4: "24", 7: "27", 38: "39", 48: "49" };
// Targeted resets, never SGR 0: a role inside the input band must not clear the band.
const style = (value, code, theme) => {
  if (!theme || !code || !value) return value;
  const close = []; const parts = code.split(";");
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (n === 38 || n === 48) { close.push(RESET[n]); i += parts[i + 1] === "5" ? 2 : 4; }
    else close.push(RESET[n] ?? ((n >= 30 && n <= 37) || (n >= 90 && n <= 97) ? "39" : "0"));
  }
  return `\x1b[${code}m${value}\x1b[${[...new Set(close)].join(";")}m`;
};
const paint = (value, role = "primary", theme) => style(value, theme?.[role], theme);

// Terminal palette → roles. The reference values are blends of the terminal's own foreground
// toward its background; text roles are pulled back toward the foreground until they reach 4.5:1.
const channel = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (from, to, t) => from.map((v, i) => Math.round(v + (to[i] - v) * t));
const cube = [0, 95, 135, 175, 215, 255];
function xterm256([r, g, b]) {
  const near = v => cube.reduce((best, c, i) => Math.abs(c - v) < Math.abs(cube[best] - v) ? i : best, 0);
  const [i, j, k] = [near(r), near(g), near(b)], rgb = [cube[i], cube[j], cube[k]];
  const level = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), grey = 8 + level * 10;
  const distance = c => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  return distance([grey, grey, grey]) < distance(rgb) ? 232 + level : 16 + 36 * i + 6 * j + k;
}
// The colour a 256-colour terminal actually shows for an index.
const shown = index => index >= 232 ? Array(3).fill(8 + (index - 232) * 10)
  : [Math.floor((index - 16) / 36), Math.floor((index - 16) / 6) % 6, (index - 16) % 6].map(i => cube[i]);
/** Fail loudly when no rendered colour satisfies the actual backgrounds. */
export function readable(from, grounds, { fg, render = rgb => rgb, excluded = [] } = {}) {
  const allowed = rgb => grounds.every(ground => contrast(rgb, ground) >= 4.5)
    && !excluded.some(other => other.every((channel, index) => channel === rgb[index]));
  for (const toward of [fg ?? from, [0, 0, 0], [255, 255, 255]]) {
    for (let step = 0; step <= 100; step++) {
      const value = render(mix(from, toward, step / 100));
      if (allowed(value)) return value;
    }
  }
  // Near-threshold palettes can exhaust a blend's quantized colours. Search rendered candidates too.
  const levels = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  const candidates = levels.flatMap(r => levels.flatMap(g => levels.map(b => render([r, g, b]))));
  candidates.sort((a, b) => a.reduce((sum, v, i) => sum + (v - from[i]) ** 2, 0)
    - b.reduce((sum, v, i) => sum + (v - from[i]) ** 2, 0));
  const found = candidates.find(allowed);
  if (found) return found;
  throw new RangeError("No readable rendered colour at 4.5:1 for these backgrounds");
}

export function paletteTheme({ fg, bg, red, green }, truecolor = false) {
  const render = rgb => truecolor ? rgb : shown(xterm256(rgb));
  const code = (rgb, layer = 38) => truecolor ? `${layer};2;${rgb.join(";")}` : `${layer};5;${xterm256(rgb)}`;
  const band = render(mix(fg, bg, 0.88));
  const grounds = [bg, band], used = [];
  const pick = (base, distinct = false) => {
    const value = readable(base, grounds, { fg, render, excluded: distinct ? used : [] });
    if (distinct) used.push(value);
    return code(value);
  };
  const dark = luminance(bg) < 0.4;
  const primary = pick(fg);
  return Object.freeze({
    primary, strong: `1;${primary}`, em: `3;${primary}`, link: `4;${primary}`,
    accent: pick(dark ? [105, 215, 239] : [0, 120, 150], true),
    success: pick(green ?? (dark ? [100, 220, 130] : [0, 115, 45]), true),
    error: pick(red ?? (dark ? [255, 135, 150] : [175, 30, 55]), true),
    secondary: pick(mix(fg, bg, 0.25), true),
    attention: pick(dark ? [233, 173, 12] : [154, 103, 0]),
    quiet: pick(mix(fg, bg, 0.42)), rule: pick(mix(fg, bg, 0.62)), band: code(band, 48),
  });
}

const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const PROSE = 88; // readable measure on wide terminals; tables and code may use the full width
const NEW_PROJECT = "New Project on first send";
const printableAscii = /^[\x20-\x7e]*$/;
const measure = value => printableAscii.test(value) ? value.length : stringWidth(value);
// Each wrapped row closes whatever style is still open and the next row reopens it: a role never
// rides a line feed into a row that is later dropped or drawn by someone else (wrap-ansi only
// re-closes the 16-colour codes, not 256/truecolor ones).
const CLOSE = { 1: "22", 2: "22", 3: "23", 4: "24", 7: "27" };
function seal(lines) {
  let open = [];
  return lines.map(line => {
    const head = open.length ? `\x1b[${open.join(";")}m` : "";
    for (const [, list] of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const parts = list.split(";");
      for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i] || 0);
        if (n === 38 || n === 48) { const width = parts[i + 1] === "5" ? 3 : 5; open = open.filter(g => !g.startsWith(`${n};`)); open.push(parts.slice(i, i + width).join(";")); i += width - 1; }
        else if (n === 0) open = [];
        else if (n === 39 || n === 49) open = open.filter(g => !g.startsWith(n === 39 ? "38;" : "48;") && !(n === 39 ? /^(3[0-7]|9[0-7])$/ : /^(4[0-7]|10[0-7])$/).test(g));
        else if (["22", "23", "24", "27"].includes(String(n))) open = open.filter(g => CLOSE[g] !== String(n));
        else open.push(String(n));
      }
    }
    const tail = open.length ? `\x1b[${[...new Set(open.map(g => CLOSE[g] ?? (g.startsWith("48") || /^(4[0-7]|10[0-7])$/.test(g) ? "49" : "39")))].join(";")}m` : "";
    return head + line + tail;
  });
}
// Cached wraps own only immutable text rows; each caller receives a separate array.
const wrapped = new Map();
const wrap = (value, width, wordWrap = true) => {
  width = Math.max(1, width);
  const key = value.length <= 512 ? `${width}:${wordWrap}:${value}` : null;
  if (key && wrapped.has(key)) return [...wrapped.get(key)];
  const lines = !value.includes("\n") && measure(value) <= width ? [value]
    : seal(wrapAnsi(value, width, { hard: true, trim: false, wordWrap }).split("\n"));
  if (key) {
    if (wrapped.size === 128) wrapped.delete(wrapped.keys().next().value);
    wrapped.set(key, Object.freeze([...lines]));
  }
  return lines;
};
// Prose wraps at word boundaries and drops the break's leading space; the composer keeps every space.
const prose = (value, width) => seal(wrapAnsi(value, Math.max(1, width), { hard: true, trim: true }).split("\n"));
// Key hints fold between their " · " segments, never inside one ("? shortcuts" stays whole).
const fold = (text, width) => text.split("\n").flatMap(part => part.split(" · ").reduce((rows, segment) => {
  if (rows.length && measure(rows.at(-1)) + 3 + measure(segment) <= width) rows[rows.length - 1] += " · " + segment;
  else rows.push(segment);
  return rows;
}, [])).flatMap(row => wrap(row, width));
const pad = (value, width) => value + " ".repeat(Math.max(0, width - measure(value)));

function inline(tokens, theme) {
  return tokens.map(token => {
    const href = token.href && /^https?:\/\//i.test(token.href) ? ` <${token.href}>` : "";
    const value = token.text + href;
    return token.kind === "strong" ? paint(value, "strong", theme)
      : token.kind === "em" ? paint(value, "em", theme)
        : token.kind === "code" ? paint(value, "accent", theme)
          : token.kind === "link" ? paint(value, "link", theme) : paint(value, "primary", theme);
  }).join("");
}

const numeric = /^[-+−~≈<>≤≥±]?\s?\d[\d.,]*(?:\s?[^\s\d]\S*)?$/;
function table(block, width, theme) {
  const grid = [block.header, ...block.rows].map(row => row.map(cell => inline(cell, null)));
  const columns = Math.max(...grid.map(row => row.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(1, ...grid.map(row => measure(row[i] ?? ""))));
  if (widths.reduce((a, b) => a + b, 0) + 3 * (columns - 1) > width) {
    // Too wide for the terminal: one record per row, never a clipped column.
    const lines = [];
    block.rows.forEach((row, index) => {
      lines.push(paint(`Record ${index + 1}`, "strong", theme));
      row.forEach((cell, column) => lines.push(...wrap(`${paint(grid[0]?.[column] || `Column ${column + 1}`, "secondary", theme)}  ${inline(cell, theme)}`, width)));
    });
    return lines;
  }
  const right = widths.map((_, i) => block.rows.length > 0 && block.rows.every(row => numeric.test(inline(row[i] ?? [], null).trim() || "0")));
  const cell = (value, i) => right[i] ? " ".repeat(Math.max(0, widths[i] - measure(value))) + value : pad(value, widths[i]);
  const bar = paint(" │ ", "rule", theme);
  return [paint(grid[0].map((value, i) => pad(value, widths[i])).join(" │ "), "strong", theme),
    paint(widths.map(w => "─".repeat(w)).join("─┼─"), "rule", theme),
    ...grid.slice(1).map(row => widths.map((_, i) => paint(cell(row[i] ?? "", i), "primary", theme)).join(bar))];
}

/** Shared web grammar; only trusted renderer styling can emit terminal controls. */
export function markdownView(source, width, color = true) {
  const theme = themeOf(color), lines = [], measureWidth = Math.min(width, PROSE);
  for (const block of parseMarkdown(terminalText(source))) {
    if (block.kind === "table") lines.push(...table(block, width, theme));
    else if (block.kind === "codeblock") {
      if (block.language) lines.push(paint(block.language, "quiet", theme));
      lines.push(...wrap(block.text, width - 2, false).map(line => paint("│ ", "rule", theme) + paint(line, "primary", theme)));
    } else if (block.kind === "hr") {
      lines.push(paint("─".repeat(Math.min(width, 48)), "rule", theme));
    } else if (block.kind === "list") {
      block.items.forEach((item, index) => {
        const prefix = block.ordered ? `${index + 1}. ` : "• ";
        prose(inline(item, theme), measureWidth - prefix.length).forEach((line, i) => lines.push((i ? " ".repeat(prefix.length) : paint(prefix, "quiet", theme)) + line));
      });
    } else {
      let value = inline(block.inline, theme);
      if (block.kind === "heading") value = paint(value, "strong", theme);
      if (block.kind === "quote") lines.push(...prose(value, measureWidth - 2).map(line => paint("│ ", "rule", theme) + line));
      else lines.push(...prose(value, measureWidth));
    }
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

// One terminal owns this cache. Cursor movement never rewraps unrelated paragraphs.
let composerText;
const composerLayouts = new Map();
function composerViewport(composer, cursor, width, height, theme) {
  if (composerText !== composer) { composerLayouts.clear(); composerText = composer; }
  let composerLayout = composerLayouts.get(width);
  if (!composerLayout) {
    const paragraphs = [], lines = []; let offset = 0;
    for (const text of composer.split("\n")) {
      paragraphs.push({ text, offset, row: lines.length });
      lines.push(...wrap(terminalText(text), width, false)); offset += text.length + 1;
    }
    composerLayout = { paragraphs, lines };
    if (composerLayouts.size === 3) composerLayouts.delete(composerLayouts.keys().next().value);
    composerLayouts.set(width, composerLayout);
  }
  const { paragraphs, lines } = composerLayout;
  const paragraph = paragraphs.findLast(row => row.offset <= cursor) ?? paragraphs[0];
  const local = cursor - paragraph.offset;
  const before = terminalText(paragraph.text.slice(0, local));
  // The caret is the one accent mark inside the input: wrapped on its plain glyph, painted after.
  const active = wrap(before + "▌" + terminalText(paragraph.text.slice(local)), width, false)
    .map(line => line.replace("▌", paint("▌", "accent", theme)));
  const cursorRow = paragraph.row + wrap(before + "▌", width, false).length - 1;
  const start = Math.max(0, cursorRow - height + 1);
  const next = paragraphs[paragraphs.indexOf(paragraph) + 1]?.row ?? lines.length;
  const visible = start < paragraph.row ? lines.slice(start, paragraph.row) : [];
  visible.push(...active.slice(Math.max(0, start - paragraph.row)), ...lines.slice(next, next + height));
  return { lines: visible.slice(0, height), position: `Line ${paragraphs.indexOf(paragraph) + 1}/${paragraphs.length}`,
    scrolling: lines.length > height };
}

/** The composer: a filled input band between two rules; a label may sit in either rule. */
function composerBand(rows, width, theme, { top = "", bottom = "" } = {}) {
  const rule = label => {
    const text = label ? `── ${trimEnd(label, width - 4)} ` : "";
    return paint(text + "─".repeat(Math.max(0, width - measure(text))), "rule", theme);
  };
  const band = theme?.band;
  return [rule(top), ...rows.map(row => band ? style(pad(row, width), band, theme) : row), rule(bottom)];
}

// Display-cell truncation with an ellipsis; never more work than the visible width needs.
function trimEnd(value, max) {
  const safe = terminalText(value);
  if (measure(safe) <= max) return safe;
  const chars = [...safe].slice(0, Math.max(0, max));
  while (chars.length && measure(chars.join("")) > max - 1) chars.pop();
  return chars.join("") + "…";
}

function trimStart(value, max) {
  const safe = terminalText(value);
  if (measure(safe) <= max) return safe;
  const chars = [...safe].slice(-Math.max(1, max));
  while (chars.length && measure(chars.join("")) > max - 1) chars.shift();
  return "…" + chars.join("");
}

const execution = view => view.location && view.location !== "Vecteur cloud" ? view.location : "Cloud";
const routeOf = view => `${view.lead ? `${view.lead} · ` : ""}${view.model} · ${execution(view)}`;
const customOrigin = view => view.origin && view.origin !== "https://vecteur.space" ? view.origin : "";

/**
 * Identity: `▼ Vecteur <version>` and the folder, the route group on the right (beneath when
 * narrow). Live while the transcript is empty, then committed once to scrollback.
 */
export function richHeader(view, columns = 80, color = true) {
  const theme = themeOf(color), width = Math.max(20, columns - 1);
  const label = `${view.version ?? ""}${view.channel === "preview" ? " · Preview" : ""}`;
  const brand = `${paint("▼", "accent", theme)} ${paint("Vecteur", "strong", theme)} ${paint(label, "quiet", theme)}`;
  const brandWidth = measure(`▼ Vecteur ${label}`);
  // Only a signed-in, online session earns the filled dot; it claims nothing about a server.
  const live = !!view.account && !view.offline;
  const route = trimEnd(routeOf(view), width - 4);
  const routeText = `${paint(live ? "●" : "○", live ? "accent" : "quiet", theme)} ${paint(route, "secondary", theme)}`;
  const routeWidth = measure(route) + 2;
  const lines = ["", brandWidth + 4 + routeWidth <= width
    ? brand + " ".repeat(width - brandWidth - routeWidth) + routeText : brand];
  // A non-production origin is never hidden for visual simplicity.
  const origin = customOrigin(view), directory = view.directory ? terminalText(view.directory) : "";
  if (directory && origin && measure(directory) + 3 + measure(origin) <= width - 2) {
    lines.push(`  ${paint(directory, "quiet", theme)}${paint(" · ", "quiet", theme)}${paint(terminalText(origin), "accent", theme)}`);
  } else {
    if (directory) lines.push("  " + paint(trimStart(directory, width - 2), "quiet", theme));
    if (origin) lines.push("  " + paint(trimEnd(origin, width - 2), "accent", theme));
  }
  if (lines[1] === brand) lines.push("  " + routeText);
  return lines;
}

// First-use suggestions are plain text, never a menu; existing commands stay authoritative.
const ONBOARDING = ["Review a mission brief and find the missing inputs",
  "Compare orbit options for an Earth-observation mission", "Turn requirements into an analysis plan"];

/** The live region: `top` (identity, first-use note) above a flexible gap, `bottom` anchored. */
export function richLayout(view, composer, cursor, options = {}) {
  const { columns = 80, rows = 24, color = true, tick = null } = options;
  const theme = themeOf(color);
  const width = Math.max(20, columns - 1), budget = Math.max(1, rows - 3);
  const active = !!view.run?.subject && !view.run.terminal;
  const pending = view.run?.blocks?.find(block => !block.committed && block.calls);
  const pendingContent = pending ? blockContent(pending) : null;
  // Compact layouts reserve their activity row for the open call, including its state.
  const callSummary = pendingContent ? `${pendingContent.tool}  ${trimEnd(plainLine(pendingContent.title),
    Math.max(1, width - measure(`${pendingContent.tool}   · ${pendingContent.status}`)))} · ${pendingContent.status}` : null;
  const readOnly = view.project?.role === "VIEWER", signedOut = view.offline || !view.account;
  const glyph = tick === null ? "●" : SPINNER[tick % SPINNER.length];
  const runHint = readOnly ? "Read-only · /help · Ctrl+D detach"
    : signedOut ? `${view.offline ? "/resume" : "/login"} · /help · Ctrl+D detach`
      : `${view.run?.question ? "/answer" : "/steer · /answer-now"} · /help${width < 60 ? "\n" : " · "}Esc twice cancel · Ctrl+D detach`;
  const idleHint = `${readOnly ? "Read-only · /project" : signedOut ? "Enter sign in" : view.busy ? "Please wait" : "Enter send"} · / commands · ? shortcuts`;
  if (rows < 12) {
    const focus = view.focus ?? view.prompt;
    const choices = view.choices ?? focus?.options ?? view.palette ?? [];
    const selected = Math.min(view.selected ?? view.paletteSelected ?? 0, Math.max(0, choices.length - 1));
    const choice = choices[selected];
    const content = focus?.title ?? (view.login ? `Sign in · Code ${view.login.user_code}` : view.issue?.text
      ?? view.egress ?? (active ? callSummary ?? `${view.run.elapsed ?? "Elapsed unavailable"} · ${view.status}` : view.status));
    const status = wrap(terminalText(content), width).slice(0, 1);
    if (active && callSummary && content !== callSummary) status.push(callSummary);
    if (choice) status.push(wrap(terminalText(`› ${selected + 1}/${choices.length} ${choice.label ?? '/' + choice.name}`), width)[0]);
    else if (view.login) status.push(['› Open browser', '› Copy link', '› Work offline'][view.loginAction ?? 0]);
    const draft = composerViewport(composer, cursor, width - 2, 1, theme).lines[0];
    const hint = focus || choices.length ? '↑↓ Enter choose · Esc back' : view.login ? 'Tab actions · Enter open · Esc offline'
      : active ? runHint : idleHint;
    return { top: [], bottom: [...status.map(row => paint(row, "primary", theme)), `${paint("›", "accent", theme)} ${paint(draft, "primary", theme)}`,
      ...fold(hint, width).slice(0, 2).map(row => paint(row, "secondary", theme))].slice(0, budget) };
  }
  // The steady footer names the Workspace, never a personal address; /status shows the account.
  const workspaces = view.account?.workspaces ?? [];
  const account = view.account ? (workspaces.find(row => row.id === view.project?.workspace_id) ?? workspaces[0])?.name ?? "Signed in"
    : view.offline ? "Offline" : "Not signed in";
  const projectLabel = view.projectLabel ?? view.project?.name ?? NEW_PROJECT;
  const identity = `${account} · ${projectLabel === NEW_PROJECT ? "New project" : projectLabel}`;
  const compact = width < 60 || rows < 18;
  const prompt = view.focus ?? view.prompt;
  const compactFocus = rows < 24 && (view.focus || view.prompt || view.login || view.palette?.length || view.issue);
  const compactRun = rows < 18 && active;

  // Footer first: it is what keeps every state escapable, so the rest fits around it.
  const hint = prompt ? prompt.multiple ? "Space toggle · ↑↓ move · Enter confirm · Esc back" : "↑↓ choose · Enter confirm · Esc back · Ctrl+D exit"
    : view.login ? "Tab actions · Enter on empty activates · Esc offline"
      : view.palette?.length ? "↑↓ choose · Tab complete · Enter open · Esc close"
        : active ? runHint : idleHint;
  // While the identity header is live it owns the route and origin; afterwards the footer does.
  const context = view.header ? identity : compact ? routeOf(view) : `${identity} · ${routeOf(view)}`;
  const footer = [];
  if (!compact && !hint.includes("\n") && measure(context) + 3 + measure(hint) <= width) {
    footer.push(paint(context, "secondary", theme) + " ".repeat(width - measure(context) - measure(hint)) + paint(hint, "quiet", theme));
  } else {
    footer.push(...fold(hint, width).slice(0, 2).map(row => paint(row, "quiet", theme)));
    footer.push(paint(trimEnd(context, width), "secondary", theme));
  }
  if (!view.header && customOrigin(view)) footer.push(paint(trimEnd(customOrigin(view), width), "accent", theme));

  // A breathing line between the scrollback and the live area when the window has room for it.
  const lines = rows >= 18 && !compactFocus ? [""] : [];
  const room = () => budget - footer.length - 3 - lines.length;
  const line = (value, role, limit = 2) => {
    const text = terminalText(value);
    lines.push(...wrap(text, width).slice(0, Math.max(0, Math.min(limit, room()))).map(row => paint(row, role, theme)));
  };
  if (active && compactFocus && compactRun && pending) line(callSummary, "attention", 1);
  // Activity: the one animated glyph, the current step and the server-anchored clock.
  if (active && !compactFocus) {
    const clock = view.run.elapsed ?? "Elapsed unavailable";
    const doing = compactRun ? callSummary ?? view.status : (view.run.progress || "Working").replace(/^Starting: (.+)$/, "$1").replace(/[.…]+$/, "") + "…";
    const head = `${paint(glyph, "accent", theme)} ${paint(terminalText(doing), "primary", theme)}`, tail = paint(terminalText(clock), "quiet", theme);
    if (measure(`${glyph} ${terminalText(doing)} · ${terminalText(clock)}`) <= width) lines.push(`${head} ${paint("·", "quiet", theme)} ${tail}`);
    else if (compactRun) lines.push(callSummary ? paint(terminalText(doing), "attention", theme) : wrap(head, width)[0], `  ${tail}`);
    else lines.push(wrap(`${paint(glyph, "accent", theme)} ${tail} · ${paint(terminalText(doing), "primary", theme)}`, width)[0]);
    if (!compactRun && view.status && view.status !== "Running") line(`  ${view.status}`, "secondary", 1);
  }
  if (active && !compactFocus && !compactRun) {
    const pending = view.run.blocks?.find(block => !block.committed && block.calls);
    if (pending) {
      const content = blockContent(pending);
      line(`  ${content.tool}  ${content.title} · ${content.status}`, "attention", 1);
      if (pending.kind === "sources") line(`  ${content.rows.join(" · ")}`, "secondary", 1);
    }
    for (const block of view.run.blocks?.filter(block => block.kind === "control") ?? []) {
      const c = blockContent(block);
      line(`  ${c.title} · ${c.rows.join(" · ")}`, "secondary", 1);
    }
  }
  if (!compactFocus && !compactRun && view.run?.question) line(readOnly ? "Waiting for an editor to answer"
    : signedOut ? "Question pending — reconnect to answer" : "Your answer is needed · /answer", "attention", 1);
  if (prompt) {
    line(prompt.title, "strong", compactFocus ? 1 : 3);
    if (!prompt.typed) {
      const choices = view.choices ?? prompt.options, selected = Math.min(view.selected ?? 0, Math.max(0, choices.length - 1));
      const more = choices.length > 1 && !compactFocus ? 1 : 0;
      const count = Math.max(1, Math.min(5, room() - more));
      const offset = Math.max(0, selected - count + 1);
      choices.slice(offset, offset + count).forEach((item, i) => {
        const index = prompt.options.indexOf(item) + 1, current = i + offset === selected;
        const checked = prompt.multiple ? `${composer.split(/[, ]+/).includes(String(index)) ? "[x]" : "[ ]"} ` : "";
        lines.push(wrap(`${current ? paint("›", "accent", theme) : " "} ${index}. ${checked}${current ? paint(terminalText(item.label), "accent", theme) : paint(terminalText(item.label), "primary", theme)}`, width)[0]);
      });
      if (!choices.length) line("No matching choices; clear the filter", "attention", 1);
      if (choices.length > count && more) line(`${selected + 1}/${choices.length} · ↑↓ more choices`, "quiet", 1);
    }
  } else if (view.login) {
    line(`Approve code ${view.login.user_code} in your browser`, "strong", 1);
    if (!compactFocus) line(view.login.verification_uri_complete, "accent", 2);
    const actions = ["Open browser", "Copy link", "Work offline"];
    line(compactFocus ? `› ${actions[view.loginAction ?? 0]} (${(view.loginAction ?? 0) + 1}/3)`
      : actions.map((text, i) => `${i === view.loginAction ? "› " : ""}${text}`).join(" · "), undefined, compactFocus ? 1 : 2);
  } else if (view.palette?.length) {
    const selected = Math.min(view.paletteSelected ?? 0, view.palette.length - 1);
    const count = Math.max(1, Math.min(6, room()));
    const offset = Math.max(0, selected - count + 1);
    const name = Math.min(16, Math.max(...view.palette.map(row => row.name.length + 1)));
    view.palette.slice(offset, offset + count).forEach((row, i) => {
      const current = i + offset === selected, label = pad(`/${row.name}`, name);
      lines.push(wrap(`${current ? paint("›", "accent", theme) : " "} ${current ? paint(label, "accent", theme) : paint(label, "primary", theme)}  ${paint(terminalText(row.disabled || row.description), "secondary", theme)}`, width)[0]);
    });
  }
  const compactAttachments = rows < 24 && view.attachments?.length;
  if (view.attachments?.length && !compactAttachments) line(view.egress ?? `${view.attachments.length} file(s) selected · uploaded only on send`, "secondary", 1);
  if (view.issue && !prompt) line(view.issue.text + (view.issue.count > 1 ? ` (${view.issue.count} attempts)` : ""), "attention", Math.max(1, Math.min(3, room())));
  // First use: signed in, idle, an unbound folder, an empty transcript and an empty draft.
  const firstUse = view.header && view.firstUse && !active && !composer && !prompt
    && !view.login && !view.issue && !view.palette?.length && !view.attachments?.length;
  const idle = !active && !view.issue && !prompt && !view.login && !view.palette?.length;
  // "Ready" is what the idle hint already says; every other state keeps its line.
  if (idle && !firstUse && view.status !== "Ready") line(view.status, "secondary", 1);
  const maxDraft = Math.max(1, Math.min(6, budget - lines.length - footer.length - 2));
  const draft = composerViewport(composer, cursor, width - 4, maxDraft, theme);
  const selection = compactAttachments ? view.egress ?? `${view.attachments.length} file(s) · upload on send` : "";
  const placeholder = prompt ? (prompt.typed ? "Type your answer…" : "Filter or type a choice number…")
    : readOnly ? "Read-only Project — draft here…" : view.offline ? "Draft offline…"
      : !view.account ? "Sign in to send — draft here…"
        : active ? "Draft your next question…" : "Ask Laplace…";
  lines.push(...composerBand(draft.lines.map((value, index) => ` ${index ? " " : paint("›", "accent", theme)} ${composer ? paint(value, "primary", theme)
    : paint("▌", "accent", theme) + paint(placeholder, "secondary", theme)}`), width, theme,
  { top: selection, bottom: draft.scrolling ? draft.position : "" }));
  lines.push(...footer);
  const bottom = lines.slice(-budget);

  // Above the gap: identity while the transcript is empty, then the first-use note if it fits.
  const space = rows - 1 - bottom.length;
  const top = [];
  if (view.header) {
    const header = richHeader(view, columns, theme);
    // No room for the identity: the footer owns the route and origin, as after the commit.
    if (header.length > space) return richLayout({ ...view, header: false }, composer, cursor, options);
    top.push(...header);
  }
  if (firstUse) {
    const note = "New folder · A project will be created on your first message. /link existing";
    const intro = [paint("What are we working on?", "strong", theme), paint("Ask Laplace about your mission, or start from a file.", "secondary", theme)];
    const suggestions = ONBOARDING.map(text => `${paint("›", "accent", theme)} ${paint(text, "secondary", theme)}`);
    const quiet = wrap(note, width).map(row => paint(row, "quiet", theme));
    const body = [[...intro, "", ...suggestions, "", ...quiet], [...intro, "", ...quiet], quiet]
      .map(rows => rows.map(row => measure(row) > width ? wrap(row, width)[0] : row))
      .find(rows => top.length + 1 + rows.length + 1 <= space);
    if (body) top.push("", ...body);
  }
  return { top, bottom };
}

/** Bottom-anchored live area as one string: identity, gap, activity, focus, composer, footer. */
export function richFrame(view, composer, cursor, options = {}) {
  const { top, bottom } = richLayout(view, composer, cursor, options);
  return [...top, ...bottom].join("\n");
}

const indent = (text, first, rest = "  ") => text.split("\n").map((line, i) => (i ? (line ? rest : "") : first) + line).join("\n");

/** One scrollback block per message: the ask, the answer with its record, or a quiet notice. */
export function richMessage(message, columns, color, { stepsShown = false, shownKeys = new Set() } = {}) {
  const theme = themeOf(color), width = Math.max(20, columns - 1);
  if (message.kind === "user") {
    const rows = wrap(terminalText(message.text), width - 2).map((row, index) =>
      `${index ? " " : paint("›", "accent", theme)} ${paint(row, "strong", theme)}`);
    return "\n" + rows.map(row => theme?.band ? style(pad(row, width), theme.band, theme) : row).join("\n") + "\n";
  }
  if (message.kind === "block") return richBlock(message.block, columns, theme);
  if (message.kind === "turn-footer") return paint(terminalText(message.text), "quiet", theme);
  if (message.kind !== "answer") return wrap(terminalText(message.text), width - 2).map(line => "  " + line).join("\n");
  const run = message.sections;
  if (!run) return "\n" + indent(markdownView(message.text, width - 2, theme), paint("●", "accent", theme) + " ") + "\n";
  const out = [];
  // A horizon stop says so, and what can be done, before the work (the plain renderer's `humanRun` prints the same lines).
  if (run.stop?.length) out.push(...run.stop.flatMap(line => (line ? prose(terminalText(line), width - 4).map(part => "  " + paint(part, "attention", theme)) : [""])), "");
  for (const block of run.blocks ?? []) {
    if (!shownKeys.has(block.key) && ["tool", "sources", "clarification"].includes(block.kind))
      out.push(richBlock(block, columns, theme), "");
  }
  out.push(run.answer !== undefined ? indent(markdownView(run.answer, width - 2, theme), paint("●", "accent", theme) + " ")
    : paint("●", "attention", theme) + " No answer was published for this Run.");
  // The host's publication warnings, beside a non-empty answer, as the plain renderer and the browser show them (`format.js` publicationChecks).
  if (run.answer !== undefined && run.answer !== "" && run.checks?.length)
    out.push("", ...run.checks.flatMap(check => prose(terminalText(check), width - 4).map(part => "  " + paint(part, "attention", theme))));
  const section = (title, rows) => { if (rows.length) out.push("", "  " + paint(title, "strong", theme), ...rows); };
  const one = text => text.split("\n").map(part => part.trim()).filter(Boolean).join(" · ");
  const shownSteps = new Set((run.blocks ?? []).filter(block => block.kind === "step" && shownKeys.has(block.key)).map(block => block.stepId));
  const tasks = shownSteps.size && run.events ? taskLines(run.events.filter(event => event.kind !== "step_finished" || !shownSteps.has(event.payload?.step_id)), { facts: true }) : run.tasks;
  section("Steps", tasks.slice(stepsShown).flatMap(task => prose(terminalText(one(task.replace(/^\s*[▸·]\s*/, ""))), width - 4).map(row => `  ⎿ ${paint(row, "secondary", theme)}`)));
  // Evidence rows are never truncated: quantity, unit and origin wrap with a hanging indent.
  const full = (row, role = "secondary") => prose(terminalText(row.trim()), width - 4).map((part, i) => (i ? "    " : "  ") + paint(part, role, theme));
  section("Inputs and origins", run.origins.flatMap(row => full(row)));
  section("Assumptions", run.assumptions.flatMap(row => full(row)));
  section("Transfer tables", run.tables.flatMap(rows => rows.flatMap(row => full(row))));
  section("Files", run.artifacts.flatMap(({ artifact, number, sameBytesAs }, i) =>
    prose(`${terminalText(artifact.path ?? artifact.filename)} · ${terminalText(artifact.kind)} · /download ${number ?? i + 1}${sameBytesAs ? ` · same bytes as ${sameBytesAs}` : ""}`, width - 4)
      .map((part, index) => `  ${index ? " " : paint("↓", "accent", theme)} ${paint(part, "secondary", theme)}`)));
  out.push("", ...full(run.tail.map(terminalText).join(" · "), run.state === "ok" ? "quiet" : "attention"));
  section("Controls", (run.blocks ?? []).filter(block => block.kind === "control" && !shownKeys.has(block.key))
    .map(block => richBlock(block, columns, theme)));
  return "\n" + out.join("\n") + "\n";
}


/** The same human grammar in live scrollback and reload, with bounded excerpt previews. */
export function richBlock(block, columns = 80, color = true, { full = false } = {}) {
  const theme = themeOf(color), width = Math.max(20, columns - 1);
  const c = blockContent(block, { full });
  const role = block.kind === "step"
    ? ["computed", "read"].includes(c.status) ? "success" : ["failed", "refused"].includes(c.status) ? "error" : "attention"
    : c.status === "ok" ? "success" : ["running", "requested", "queued", "claimed"].includes(c.status) ? "attention" : "error";
  const header = `${paint("●", role, theme)} ${paint(terminalText(c.tool ?? c.title), "strong", theme)}${c.tool ? `  ${paint(terminalText(c.title), "primary", theme)}` : ""}`;
  const out = wrap(header, width);
  for (const row of c.rows) out.push(...wrap(terminalText(row).trim(), width - 5).map((line, i) =>
    `${i ? "     " : "  ⎿  "}${paint(line, "secondary", theme)}`));
  const preview = c.preview ?? [];
  // Preserve the selected logical lines in scrollback, even at narrow widths.
  // Bound each line independently so a long notice cannot displace the cause.
  const selected = c.previewTail ? preview.slice(-3) : preview.slice(0, 3);
  const wrapped = selected.map(row => wrap(row, width - 5));
  const display = wrapped.flatMap(rows => rows.slice(0, 3));
  if (display.length) {
    out.push(...display.map(row => "     " + paint(row, "secondary", theme)));
    const truncated = preview.length > 3 || wrapped.some(rows => rows.length > 3);
    const label = truncated ? "… output excerpt truncated · ctrl+o for the full block" : "output excerpt · ctrl+o for the full block";
    out.push(...wrap(label, width - 5).map(row => "     " + paint(row, "secondary", theme)));
  }
  return out.join("\n");
}
