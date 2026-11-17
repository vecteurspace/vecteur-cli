import { runBlocks, runArtifacts, artifactRows, blockText } from "./blocks.js";
import { MODEL_CHOICES, PLAN_WORDS, STOP_ACTION_HREFS, TERMINAL_STATES } from "./contract.js";
import { STOP_WORDS } from "./stop-words.js";
import { CliError } from "./errors.js";

/** Terminal presentation only; exact copy and JSON paths retain the original bytes. */
export const terminalText = value => String(value ?? "").replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f-\x9f]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\t/g, "    ");

/** A bounded unified whole-file hunk. This is a review display, never an executable patch. */
export function localFileDiff(before, after, from, to) {
  const decode = bytes => new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  let a, b;
  try { a=decode(before); b=decode(after); }
  catch { return `${terminalText(from)} → ${terminalText(to)}: binary or non-UTF-8 diff unavailable`; }
  const lines = text => text ? text.match(/[^\n]*\n|[^\n]+$/g) : [];
  const left=lines(a), right=lines(b);
  if (a===b) return `${terminalText(from)} → ${terminalText(to)}: already identical`;
  const out=[`--- ${terminalText(from)}`,`+++ ${terminalText(to)}`,`@@ -${left.length?1:0},${left.length} +${right.length?1:0},${right.length} @@`];
  let size=0, count=0;
  for (const [prefix, rows] of [['-',left],['+',right]]) for(const line of rows) {
    const rendered=prefix+terminalText(line.replace(/\n$/,''));
    if (++count>200 || size+rendered.length>16000) return out.join('\n')+'\n… diff truncated (200 lines / 16000 characters)';
    size+=rendered.length;out.push(rendered);
    if(!line.endsWith('\n'))out.push('\\ No newline at end of file');
  }
  return out.join('\n');
}

export function proposalReview(rel, snapshot, bytes) {
  return [snapshot.classification === 'local changed' ? `you changed ${terminalText(rel)} since Vecteur read it; your edit is kept`
    : snapshot.classification === 'first sync' ? 'Vecteur has no earlier version of this file from you' : snapshot.classification,
    snapshot.baseline ? snapshot.baseBytes ? localFileDiff(snapshot.baseBytes,snapshot.bytes ?? Buffer.alloc(0),'base','local now') : 'base → local now: base diff unavailable (hash-based status retained)' : '',
    localFileDiff(snapshot.bytes ?? Buffer.alloc(0),bytes,'local now','proposed')].filter(Boolean).join('\n');
}

export function adoptionHint(proposal, original) {
  const quote = value => "'"+value.replaceAll("'", "'\\''")+"'";
  return `Review and adopt in your editor, or:\nmv -i -- ${quote(proposal)} ${quote(original)}`;
}

export function canonicalJson(value) {
  validateNumbers(value);
  return `${JSON.stringify(sortValue(value))}\n`;
}

function keyOrder(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function validateNumbers(value) {
  if (typeof value === "number" && (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new TypeError("canonical JSON contains an unsafe number");
  }
  if (Array.isArray(value)) value.forEach(validateNumbers);
  else if (value && typeof value === "object") Object.values(value).forEach(validateNumbers);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort(keyOrder).map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function safeArtifactName(artifact) {
  const leaf = artifact.path.replaceAll("\\", "/").split("/").at(-1);
  if (!leaf || leaf === "." || leaf === ".." || leaf.startsWith("-") || leaf.startsWith(".")) {
    return `artifact-${artifact.cas_ref.slice("sha256:".length, "sha256:".length + 12)}`;
  }
  return leaf;
}

/** The closed turn: its state, its typed defect and its answer (the last `synthesis`). An unknown state is refused by name. */
function terminalPresentation(value) {
  const last = value.events.at(-1);
  if (last?.kind !== "terminal") throw new CliError("terminal_invalid", "Run record has no final terminal event");
  const state = last.payload?.state;
  if (!TERMINAL_STATES.includes(state)) {
    throw new CliError("terminal_state_unknown", `Run ended in a state this CLI does not know (${plainLine(state).slice(0, 40)}); next: vecteur update`);
  }
  if (state !== value.terminal) throw new CliError("terminal_mismatch", "Run terminal event disagrees with its record");
  return { state, defect: last.payload.defect, answer: value.events.findLast(event => event.kind === "synthesis")?.payload.markdown };
}

/** A template with every `{name}` filled, or null when one is not: a half-filled sentence is never printed. */
function fillWords(template, values) {
  let missing = false;
  const said = template.replace(/\{(\w+)\}/g, (_, name) => { if (values[name] === undefined) missing = true; return values[name] ?? ""; });
  return missing ? null : said;
}

/** The stop card of a `budget` terminal. The wire carries no stop object: the words are the generic limit's
 * (`stop-words.js`), and what this reader may do about it is the server's offer; without it no plan is named. */
function stopLines(value, terminal, offer, origin = "") {
  const choice = MODEL_CHOICES.find(row => row.route_id === value.requested_route_id && row.route_id !== "auto");
  const words = { model: choice?.label ?? "The model", price: PLAN_WORDS.pro_price };
  const computed = value.events.some(event => event.kind === "tool_result" && event.payload.ok);
  const result = terminal.answer ? STOP_WORDS.result.authored : computed ? STOP_WORDS.result.computed : STOP_WORDS.result.nothing;
  const lines = [STOP_WORDS.heading.limit, `${fillWords(STOP_WORDS.reason.limit, words) ?? ""} ${result}`.trim()];
  for (const id of offer?.actions ?? []) {
    if (id === "upgrade_plan") lines.push(`${PLAN_WORDS.pro_action}: ${origin}${STOP_ACTION_HREFS.upgrade_plan}`,
      ...[fillWords(STOP_WORDS.action_line.upgrade_plan, words)].filter(Boolean).map(line => `  ${line}`));
    if (id === "contact_sales") lines.push(`${PLAN_WORDS.enterprise_action}: ${origin}${STOP_ACTION_HREFS.contact_sales}`, `  ${STOP_WORDS.action_line.contact_sales}`);
    if (id === "continue_with_model" && offer.continuation) lines.push(`${fillWords(STOP_WORDS.continue_with, { model: offer.continuation.label })}: /model, then ask a follow-up`);
  }
  if (!offer || offer.actions.includes("see_usage")) lines.push(`${STOP_WORDS.see_usage}: ${origin}${STOP_ACTION_HREFS.see_usage}`, STOP_WORDS.usage_note);
  return lines.map(plainLine);
}

/** The typed tail of a closed turn, shared by the terminal block and the transcript. */
export function terminalBlockLines(value) {
  const terminal = terminalPresentation(value);
  return [`Terminal: ${terminal.state}`, ...(terminal.defect ? [`Cause: ${plainLine(terminal.defect)}`] : [])];
}

/** The server owns amounts and coverage. This function never computes a currency value. */
export function turnFooter(run, cost) {
  const seconds = run?.duration_seconds;
  const duration = Number.isSafeInteger(seconds) && seconds >= 0 ? `${seconds}s` : "duration unavailable";
  const amount = cost?.display?.scope_used ?? cost?.display?.used ?? "no exact amount available";
  const coverage = cost?.coverage ? ` (${cost.coverage} coverage)` : "";
  return plainLine(`✻ ${run?.terminal || "open"} · ${duration} · ${amount}${coverage} this UTC month · /usage`);
}

/** One projection of a Run record; plain text and the rich terminal both render these sections. */
export function runSections(value, { projectId, stopOffer, origin } = {}) {
  const terminal = value.terminal === "" ? null : terminalPresentation(value);
  const project = projectId ? ` --project ${shellQuote(projectId)}` : "";
  const tail = [`Run: ${plainLine(value.run_id)}`, ...(terminal ? terminalBlockLines(value) : [])];
  for (const event of value.events) {
    if (event.kind === "review") tail.push(`Review: ${plainLine(event.payload.verdict)}`);
    if (event.kind === "study") tail.push(`Study record: vecteur artifact get ${shellQuote(event.payload.cas_ref)}${project}`);
  }
  return { blocks: runBlocks(value), state: terminal?.state ?? "", answer: terminal?.answer, duration_seconds: value.duration_seconds,
    artifacts: artifactRows(runArtifacts(value.events)).map(row => ({ ...row,
      command: `vecteur artifact get ${shellQuote(row.artifact.cas_ref)} --output ${shellQuote(safeArtifactName(row.artifact))}${project}` })),
    tail, stop: terminal?.state === "budget" ? stopLines(value, terminal, stopOffer, origin) : [] };
}

export function humanRun(value, { projectId, cost, stopOffer, origin, shownKeys = new Set() } = {}) {
  return humanRunSections(runSections(value, { projectId, stopOffer, origin }), { cost, shownKeys });
}

/** A turn in plain text: the working trace (one line per tool call), the answer, the files, the terminal state and,
 * at a limit, the stop card. Rows already printed live are not repeated. */
export function humanRunSections(run, { cost, shownKeys = new Set() } = {}) {
  const lines = [];
  const trace = run.blocks.filter(block => block.kind !== "terminal" && !shownKeys.has(block.key));
  if (trace.length) lines.push("Working:", ...trace.map(block => `  ${blockText(block)}`), "");
  if (run.answer) lines.push(run.answer, "");
  else if (run.state) lines.push("No answer was published for this Run.", "");
  if (run.artifacts.length) {
    lines.push("Files:");
    for (const { artifact, command, number, sameBytesAs } of run.artifacts) {
      lines.push(`  ${terminalText(artifact.path)} (${plainLine(artifact.kind)}, ${artifact.bytes} B) · /download ${number}${sameBytesAs ? ` · same bytes as ${sameBytesAs}` : ""}`, `    ${terminalText(command)}`);
    }
    lines.push("");
  }
  lines.push(...run.tail);
  if (run.stop.length) lines.push("", ...run.stop);
  if (cost) lines.push("", humanCost(cost).trimEnd());
  return `${lines.join("\n")}\n`;
}

export function humanCost(value) {
  const scope = value.coverage === "complete" ? ` · ${value.binding_scope.scope.type}` : "";
  const lines = [
    `Requested spend · ${value.scope.type} (UTC month): ${value.display.scope_used ?? "Unavailable"}`,
    `Cost${scope} (UTC month, ${value.coverage} coverage):`,
  ];
  for (const [label, amount] of [
    ["Used", value.display.used], ["Limit", value.display.limit], ["Remaining", value.display.remaining],
  ]) {
    if (amount !== null) lines.push(`  ${label}: ${amount}`);
  }
  if (value.display.used === null) lines.push("  No exact amount is available.");
  else if (value.binding_scope.kind === "unlimited") lines.push("  No configured ceiling.");
  return `${lines.join("\n")}\n`;
}

export function human(value, options = {}) {
  if (value && typeof value === "object" && typeof value.run_id === "string") {
    return humanRun(value, options);
  }
  if (value && typeof value === "object" && typeof value.name === "string") {
    return `${value.name} (${value.id})\n`;
  }
  return canonicalJson(value);
}

/** One live line per event worth a line: a tool call as it starts, a failed result, a file as it lands. */
export function progress(event) {
  const payload = event?.payload;
  if (event?.kind === "tool_call") return `${String(payload.tool).charAt(0).toUpperCase()}${String(payload.tool).slice(1)}: ${plainLine(payload.title)}\n`;
  if (event?.kind === "tool_result" && !payload.ok) return `  failed: ${plainLine(payload.excerpt.split("\n").filter(line => line.trim()).at(-1) ?? "no output")}\n`;
  if (event?.kind === "artifact") return `File ready: ${plainLine(payload.path)}\n`;
  return "";
}

export function plainLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

/** A workflow's prompt with each `{{name}}` replaced in ONE pass by a function: a value is never re-read as a blank or as `$&`. */
export function fillPrompt(workflow, valueOf) {
  return workflow.prompt.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (blank, name) => {
    const argument = workflow.arguments.find(item => item.name === name);
    return argument ? valueOf(argument) : blank;
  });
}

/** The ask the engineer edits: each blank shown as its description in brackets, as the web shows it. */
export const scaffold = workflow => fillPrompt(workflow, argument => `[${argument.description}]`);

export function humanWorkflows(workflows) {
  return workflows.length ? workflows.map(w => `${plainLine(w.id)} · ${plainLine(w.name)} · ${plainLine(w.description)}\n`).join("")
    : "No workflows.\n";
}

export function humanWorkflow(w, withScaffold = true) {
  return [`${plainLine(w.name)} (${plainLine(w.id)})`, `You give: ${plainLine(w.steps.bring)}`,
    ...(w.files ? [`Attach: ${plainLine(w.files.label)} · ${w.files.formats.map(f => plainLine(f).toUpperCase()).join(" ")}`
      + (w.files.required ? " · required" : "")] : []),
    `You get: ${plainLine(w.steps.get)}`, ...(withScaffold ? ["", terminalText(scaffold(w))] : []), ""].join("\n");
}
