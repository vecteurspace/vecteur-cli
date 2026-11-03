import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { parseMarkdown } from "../markdown.js";
import { terminalText } from "../format.js";
const style = (value, code, color) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
// One accent (the web's sky cyan, xterm 81), one secondary grey; amber only for attention.
const ACCENT = "38;5;81", DIM = "90", ATTENTION = "33";
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const printableAscii = /^[\x20-\x7e]*$/;
const measure = value => printableAscii.test(value) ? value.length : stringWidth(value);
const wrapped = new Map();
const wrap = (value, width, wordWrap = true) => {
  width = Math.max(1, width);
  const key = value.length <= 512 ? `${width}:${wordWrap}:${value}` : null;
  if (key && wrapped.has(key)) return wrapped.get(key);
  const lines = !value.includes("\n") && measure(value) <= width ? [value]
    : wrapAnsi(value, width, { hard: true, trim: false, wordWrap }).split("\n");
  if (key) {
    if (wrapped.size === 128) wrapped.delete(wrapped.keys().next().value);
    wrapped.set(key, lines);
  }
  return lines;
};
// Prose wraps at word boundaries and drops the break's leading space; the composer keeps every space.
const prose = (value, width) => wrapAnsi(value, Math.max(1, width), { hard: true, trim: true }).split("\n");
const pad = (value, width) => value + " ".repeat(Math.max(0, width - measure(value)));

function inline(tokens, color) {
  return tokens.map(token => {
    const href = token.href && /^https?:\/\//i.test(token.href) ? ` <${token.href}>` : "";
    const value = token.text + href;
    return token.kind === "strong" ? style(value, "1", color)
      : token.kind === "em" ? style(value, "3", color)
        : token.kind === "code" ? style(value, ACCENT, color)
          : token.kind === "link" ? style(value, "4", color) : value;
  }).join("");
}

const numeric = /^[-+−~≈<>≤≥±]?\s?\d[\d.,]*(?:\s?[^\s\d]\S*)?$/;
function table(block, width, color) {
  const grid = [block.header, ...block.rows].map(row => row.map(cell => inline(cell, false)));
  const columns = Math.max(...grid.map(row => row.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(1, ...grid.map(row => measure(row[i] ?? ""))));
  if (widths.reduce((a, b) => a + b, 0) + 3 * (columns - 1) > width) {
    // Too wide for the terminal: one record per row, never a clipped column.
    const lines = [];
    block.rows.forEach((row, index) => {
      lines.push(style(`Record ${index + 1}`, "1", color));
      row.forEach((cell, column) => lines.push(...wrap(`${style(grid[0]?.[column] || `Column ${column + 1}`, DIM, color)}  ${inline(cell, color)}`, width)));
    });
    return lines;
  }
  const right = widths.map((_, i) => block.rows.length > 0 && block.rows.every(row => numeric.test(inline(row[i] ?? [], false).trim() || "0")));
  const cell = (value, i) => right[i] ? " ".repeat(Math.max(0, widths[i] - measure(value))) + value : pad(value, widths[i]);
  const bar = style(" │ ", DIM, color);
  return [style(grid[0].map((value, i) => pad(value, widths[i])).join(" │ "), "1", color),
    style(widths.map(w => "─".repeat(w)).join("─┼─"), DIM, color),
    ...grid.slice(1).map(row => widths.map((_, i) => cell(row[i] ?? "", i)).join(bar))];
}

/** Shared web grammar; only trusted renderer styling can emit terminal controls. */
export function markdownView(source, width, color = true) {
  const lines = [];
  for (const block of parseMarkdown(terminalText(source))) {
    if (block.kind === "table") lines.push(...table(block, width, color));
    else if (block.kind === "codeblock") {
      if (block.language) lines.push(style(block.language, DIM, color));
      lines.push(...wrap(block.text, width - 2, false).map(line => style("│ ", DIM, color) + line));
    } else if (block.kind === "hr") {
      lines.push(style("─".repeat(Math.min(width, 48)), DIM, color));
    } else if (block.kind === "list") {
      block.items.forEach((item, index) => {
        const prefix = block.ordered ? `${index + 1}. ` : "• ";
        prose(inline(item, color), width - prefix.length).forEach((line, i) => lines.push((i ? " ".repeat(prefix.length) : style(prefix, DIM, color)) + line));
      });
    } else {
      let value = inline(block.inline, color);
      if (block.kind === "heading") value = style(value, block.level <= 2 ? `1;${ACCENT}` : "1", color);
      if (block.kind === "quote") lines.push(...prose(value, width - 2).map(line => style("│ ", DIM, color) + line));
      else lines.push(...prose(value, width));
    }
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

// One terminal owns this cache. Cursor movement never rewraps unrelated paragraphs.
let composerText;
const composerLayouts = new Map();
function composerViewport(composer, cursor, width, height) {
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
  const active = wrap(before + "▌" + terminalText(paragraph.text.slice(local)), width, false);
  const cursorRow = paragraph.row + wrap(before + "▌", width, false).length - 1;
  const start = Math.max(0, cursorRow - height + 1);
  const next = paragraphs[paragraphs.indexOf(paragraph) + 1]?.row ?? lines.length;
  const visible = start < paragraph.row ? lines.slice(start, paragraph.row) : [];
  visible.push(...active.slice(Math.max(0, start - paragraph.row)), ...lines.slice(next, next + height));
  return { lines: visible.slice(0, height), position: `Line ${paragraphs.indexOf(paragraph) + 1}/${paragraphs.length}`,
    scrolling: lines.length > height };
}

/** One rounded box, the same frame as the prompt: a label may sit in the top or bottom border. */
function box(rows, width, color, { top = "", bottom = "" } = {}) {
  const inner = Math.max(1, width - 4);
  const edge = (left, label, right) => {
    const text = label ? `─ ${trimEnd(label, inner - 2)} ` : "";
    return style(left + text + "─".repeat(Math.max(0, width - 2 - measure(text))) + right, DIM, color);
  };
  return [edge("╭", top, "╮"), ...rows.map(row => `${style("│", DIM, color)} ${row}${" ".repeat(Math.max(0, inner - measure(row)))} ${style("│", DIM, color)}`),
    edge("╰", bottom, "╯")];
}

/** The once-printed welcome: one calm box, a single accent glyph, no ASCII logo. */
export function welcome(version, origin, columns = 80, color = true, channel, folder) {
  const width = Math.max(20, columns - 1), inner = width - 4;
  const label = `${version}${channel === "preview" ? " · Preview" : ""}`;
  const where = [folder, origin === "https://vecteur.space" ? "" : origin].filter(Boolean).map(terminalText).join(" · ");
  const head = `${style("▼", ACCENT, color)} ${style("Vecteur", "1", color)} ${style(label, DIM, color)}`;
  const lines = measure(`▼ Vecteur ${label} · Laplace · Vecteur cloud`) <= inner
    ? [`${head} ${style("· Laplace · Vecteur cloud", DIM, color)}`] : [head];
  if (where) lines.push(style(trimEnd(`  ${where}`, inner), DIM, color));
  return box(lines, width, color).join("\n") + "\n";
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

/** Bottom-anchored live area: activity, focus, the prompt box, then one or two footer lines. */
export function richFrame(view, composer, cursor, { columns = 80, rows = 24, color = true, tick = null } = {}) {
  const width = Math.max(20, columns - 1), budget = Math.max(1, rows - 3);
  const active = !!view.run?.subject && !view.run.terminal;
  const readOnly = view.project?.role === "VIEWER", signedOut = view.offline || !view.account;
  const glyph = tick === null ? "●" : SPINNER[tick % SPINNER.length];
  const runHint = readOnly ? "Read-only · /help · Ctrl+D detach"
    : signedOut ? `${view.offline ? "/resume" : "/login"} · /help · Ctrl+D detach`
      : `${view.run?.question ? "/answer" : "/steer · /answer-now"} · /help${width < 60 ? "\n" : " · "}Esc twice cancel · Ctrl+D detach`;
  if (rows < 12) {
    const focus = view.focus ?? view.prompt;
    const choices = view.choices ?? focus?.options ?? view.palette ?? [];
    const selected = Math.min(view.selected ?? view.paletteSelected ?? 0, Math.max(0, choices.length - 1));
    const choice = choices[selected];
    const content = focus?.title ?? (view.login ? `Sign in · Code ${view.login.user_code}` : view.issue?.text
      ?? (active ? `${view.run.elapsed ?? "Elapsed unavailable"} · ${view.status}` : view.status));
    const status = wrap(terminalText(content), width).slice(0, 1);
    if (choice) status.push(wrap(terminalText(`› ${selected + 1}/${choices.length} ${choice.label ?? '/' + choice.name}`), width)[0]);
    else if (view.login) status.push(['› Open browser', '› Copy link', '› Work offline'][view.loginAction ?? 0]);
    const draft = composerViewport(composer, cursor, width - 2, 1).lines[0];
    const hint = focus || choices.length ? '↑↓ Enter choose · Esc back' : view.login ? 'Tab actions · Enter open · Esc offline'
      : active ? runHint : '? keys · /help · Ctrl+D exit';
    return [...status, `${style("›", ACCENT, color)} ${draft}`, ...wrap(style(hint, DIM, color), width).slice(0, 2)].slice(0, budget).join("\n");
  }
  if (rows < 8) return wrap(`${view.status} · Ctrl+D exit`, width).slice(0, budget).join("\n");
  const project = view.projectLabel ?? view.project?.name ?? "New Project on first send";
  // The steady footer names the Workspace, never a personal address; /status shows the account.
  const workspaces = view.account?.workspaces ?? [];
  const account = view.account ? (workspaces.find(row => row.id === view.project?.workspace_id) ?? workspaces[0])?.name ?? "Signed in"
    : view.offline ? "Offline" : "Not signed in";
  const compact = width < 60 || rows < 18;
  const prompt = view.focus ?? view.prompt;
  const compactFocus = rows < 24 && (view.focus || view.prompt || view.login || view.palette?.length || view.issue);
  const compactRun = rows < 18 && active;

  // Footer first: it is what keeps every state escapable, so the rest fits around it.
  const hint = prompt ? prompt.multiple ? "Space toggle · ↑↓ move · Enter confirm · Esc back" : "↑↓ choose · Enter confirm · Esc back · Ctrl+D exit"
    : view.login ? "Tab actions · Enter on empty activates · Esc offline"
      : view.palette?.length ? "↑↓ choose · Tab complete · Enter open · Esc close"
        : active ? runHint
          : `${readOnly ? "Read-only · /project" : signedOut ? "Enter sign in" : view.busy ? "Please wait" : "Enter send"}`
            + (width < 60 ? " · /help · Ctrl+D exit" : " · Alt+Enter newline · / commands · ? keys · /help · Ctrl+D exit");
  const execution = view.location && view.location !== "Vecteur cloud" ? view.location : "Cloud";
  const context = `${view.lead ? `${view.lead} · ` : ""}${view.model} · ${execution}`;
  const footer = wrap(style(hint, DIM, color), width - 1).slice(0, 2).map(line => " " + line);
  const identity = trimEnd(`${project === "New Project on first send" ? "New Project" : project} · ${account}`, width);
  const where = trimStart(view.folder ?? ".", Math.max(6, width - measure(identity) - measure(context) - 7));
  const left = where === "." ? identity : `${identity} · ${where}`;
  if (!compact && measure(left) + measure(context) + 4 <= width) {
    footer.push(" " + style(left + " ".repeat(width - 2 - measure(left) - measure(context)) + context, DIM, color));
  } else {
    footer.push(" " + style(trimEnd(context, width - 1), DIM, color));
    if (!compact && !compactFocus) footer.push(" " + style(trimEnd(left, width - 1), DIM, color));
  }
  if (view.origin && view.origin !== "https://vecteur.space") footer.push(" " + style(trimEnd(view.origin, width - 1), ACCENT, color));

  // A breathing line between the scrollback and the live area when the window has room for it.
  const lines = rows >= 18 && !compactFocus ? [""] : [];
  const room = () => budget - footer.length - 3 - lines.length;
  const line = (value, code, limit = 2) => {
    const text = terminalText(value);
    lines.push(...wrap(code ? style(text, code, color) : text, width).slice(0, Math.max(0, Math.min(limit, room()))));
  };
  // Activity: the one animated glyph, the current step and the server-anchored clock.
  if (active && !compactFocus) {
    const clock = view.run.elapsed ?? "Elapsed unavailable";
    const doing = compactRun ? view.status : (view.run.progress || "Working").replace(/^Starting: (.+)$/, "$1") + "…";
    const head = `${style(glyph, ACCENT, color)} ${terminalText(doing)}`, tail = style(terminalText(clock), DIM, color);
    if (measure(`${glyph} ${terminalText(doing)} · ${terminalText(clock)}`) <= width) lines.push(`${head} ${style("·", DIM, color)} ${tail}`);
    else if (compactRun) lines.push(wrap(head, width)[0], `  ${tail}`);
    else lines.push(wrap(`${style(glyph, ACCENT, color)} ${tail} · ${terminalText(doing)}`, width)[0]);
    if (!compactRun && view.status && view.status !== "Running") line(view.status, DIM, 1);
  }
  if (!compactFocus && !compactRun && view.run?.question) line(readOnly ? "Waiting for an editor to answer"
    : signedOut ? "Question pending — reconnect to answer" : "Your answer is needed · /answer", `1;${ATTENTION}`, 1);
  if (prompt) {
    line(prompt.title, "1", compactFocus ? 1 : 3);
    if (!prompt.typed) {
      const choices = view.choices ?? prompt.options, selected = Math.min(view.selected ?? 0, Math.max(0, choices.length - 1));
      const more = choices.length > 1 && !compactFocus ? 1 : 0;
      const count = Math.max(1, Math.min(5, room() - more));
      const offset = Math.max(0, selected - count + 1);
      choices.slice(offset, offset + count).forEach((item, i) => {
        const index = prompt.options.indexOf(item) + 1, current = i + offset === selected;
        const checked = prompt.multiple ? `${composer.split(/[, ]+/).includes(String(index)) ? "[x]" : "[ ]"} ` : "";
        lines.push(wrap(`${current ? style("›", ACCENT, color) : " "} ${index}. ${checked}${current ? style(terminalText(item.label), ACCENT, color) : terminalText(item.label)}`, width)[0]);
      });
      if (!choices.length) line("No matching choices; clear the filter", ATTENTION, 1);
      if (choices.length > count && more) line(`${selected + 1}/${choices.length} · ↑↓ more choices`, DIM, 1);
    }
  } else if (view.login) {
    line(`Approve code ${view.login.user_code} in your browser`, "1", 1);
    if (!compactFocus) line(view.login.verification_uri_complete, ACCENT, 2);
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
      lines.push(wrap(`${current ? style("›", ACCENT, color) : " "} ${current ? style(label, ACCENT, color) : label}  ${style(terminalText(row.disabled || row.description), DIM, color)}`, width)[0]);
    });
  }
  const compactAttachments = rows < 24 && view.attachments?.length;
  if (view.attachments?.length && !compactAttachments) line(`${view.attachments.length} file(s) selected · uploaded only on send`, DIM, 1);
  if (view.issue && !prompt) line(view.issue.text + (view.issue.count > 1 ? ` (${view.issue.count} attempts)` : ""), ATTENTION, Math.max(1, Math.min(3, room())));
  if (!active && !view.issue && !prompt && !view.login && !view.palette?.length) line(view.status, DIM, 1);
  const maxDraft = Math.max(1, Math.min(6, budget - lines.length - footer.length - 2));
  const draft = composerViewport(composer, cursor, width - 6, maxDraft);
  const selection = compactAttachments ? `${view.attachments.length} file(s) · upload on send` : "";
  const placeholder = prompt ? (prompt.typed ? "Type your answer…" : "Filter or type a choice number…")
    : readOnly ? "Read-only Project — draft here…" : view.offline ? "Draft offline…"
      : !view.account ? "Sign in to send — draft here…"
        : active ? "Draft your next question…" : "Ask Laplace…";
  lines.push(...box(draft.lines.map((value, index) => `${index ? "  " : style("›", ACCENT, color) + " "}${composer ? value : style("▌" + placeholder, DIM, color)}`),
    width, color, { top: selection, bottom: draft.scrolling ? draft.position : "" }));
  lines.push(...footer);
  return lines.slice(-budget).join("\n");
}

const indent = (text, first, rest = "  ") => text.split("\n").map((line, i) => (i ? (line ? rest : "") : first) + line).join("\n");

/** One scrollback block per message: the ask, the answer with its record, or a quiet notice. */
export function richMessage(message, columns, color, { stepsShown = false } = {}) {
  const width = Math.max(20, columns - 1);
  if (message.kind === "user") {
    return "\n" + indent(wrap(terminalText(message.text), width - 2).join("\n"), style("›", ACCENT, color) + " ") + "\n";
  }
  if (message.kind === "step") return style(trimEnd(`  ⎿ ${message.text}`, width), DIM, color);
  if (message.kind === "cost") {
    const display = message.value?.display ?? {};
    const parts = [["Used", display.used], ["Limit", display.limit], ["Remaining", display.remaining]].filter(([, v]) => v !== null && v !== undefined);
    return style(trimEnd(`  Usage this UTC month · ${parts.length ? parts.map(([k, v]) => `${k} ${v}`).join(" · ") : "no exact amount available"} · /usage`, width), DIM, color);
  }
  if (message.kind !== "answer") return wrap(terminalText(message.text), width - 2).map(line => "  " + line).join("\n");
  const run = message.sections;
  if (!run) return "\n" + indent(markdownView(message.text, width - 2, color), style("●", ACCENT, color) + " ") + "\n";
  const out = [];
  out.push(run.answer !== undefined ? indent(markdownView(run.answer, width - 2, color), style("●", ACCENT, color) + " ")
    : style("●", ATTENTION, color) + " No answer was published for this Run.");
  const section = (title, rows) => { if (rows.length) out.push("", "  " + style(title, DIM, color), ...rows); };
  const one = text => text.split("\n").map(part => part.trim()).filter(Boolean).join(" · ");
  section("Steps", run.tasks.slice(stepsShown).map(task => style(trimEnd(`  ⎿ ${one(task.replace(/^\s*[▸·]\s*/, ""))}`, width), DIM, color)));
  // Evidence rows are never truncated: quantity, unit and origin wrap with a hanging indent.
  const full = (row, code = DIM) => prose(terminalText(row.trim()), width - 4).map((part, i) => (i ? "    " : "  ") + style(part, code, color));
  section("Inputs and origins", run.origins.flatMap(row => full(row)));
  section("Assumptions", run.assumptions.flatMap(row => full(row)));
  section("Transfer tables", run.tables.flatMap(rows => rows.flatMap(row => full(row))));
  // Up to three files, readable names before digest-named ones; numbers stay the /download numbers.
  const numbered = run.artifacts.map((row, i) => ({ ...row, number: i + 1 }));
  const digest = row => /^[0-9a-f]{32,}\./.test(row.artifact.filename);
  const shown = [...numbered.filter(row => !digest(row)), ...numbered.filter(digest)].slice(0, 3);
  const more = run.artifacts.length - shown.length;
  section("Files", shown.flatMap(({ artifact, number }) => prose(`${terminalText(artifact.filename)} ${style(`· ${artifact.kind} · /download ${number}`, DIM, color)}`, width - 4)
    .map((part, i) => `  ${i ? " " : style("↓", ACCENT, color)} ${part}`))
    .concat(more > 0 ? [style(`  … ${more} more · /files`, DIM, color)] : []));
  out.push("", ...full(run.tail.map(terminalText).join(" · "), run.state === "ok" ? DIM : ATTENTION));
  return "\n" + out.join("\n") + "\n";
}
