import { runBlocks, runArtifacts, artifactRows, blockText } from "./blocks.js";
import {
  AGENT_LABELS, EXECUTION_HORIZONS, HISTORICAL_STOP_HEADS, HORIZON_STOP_DEFECTS, MODEL_CATALOGUE, ORIGIN_KINDS, ORIGIN_WORD,
  PLAN_WORDS, STOP_ACTION_HREFS, STOP_BINDING_FIELDS, STOP_BINDING_SCOPES, STOP_CAUSES, STOP_FIELDS, STOP_PERIODS,
  STOP_RESULT_KINDS, STOP_WORDS, TERMINAL_FIELDS, TERMINAL_RECOVERY_DECLARATIONS,
  validateArtifact, validateSynthesis,
} from "./contract.js";
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

/**
 * ONE CLASSIFICATION OF THE EVIDENCE A RUN USED, SPOKEN BY THIS DOOR TOO.
 *
 * PRD-UX-16: every load-bearing value in a step's inputs shows its origin — your brief, assumed,
 * derived, your file, catalogue, default — and a value the program attributed to nothing renders
 * an explicit marker, NEVER a blank. PRD-CLI-9: every door sees the same state. The web has said
 * this for a while; this door printed `[3] step_finished` and nothing else, so the same run
 * answered "where did this number come from?" on one surface and stayed silent on the other.
 *
 * The words come from `contract.js`, generated from `frontend/src/run/provenance.ts` — the
 * web's own owner — so the two doors cannot drift into different vocabularies without the
 * contract gate going red.
 */
export function originWord(origin) {
  if (!origin || typeof origin !== "object" || typeof origin.kind !== "string") {
    return ORIGIN_WORD.unattributed;
  }
  // A kind the engine invented and this build does not know is NOT silently "unstated": that
  // would report an attribution failure where there is a version skew, and the two read
  // completely differently to whoever is trying to trust the number.
  if (!ORIGIN_KINDS.includes(origin.kind)) return `unknown origin \`${origin.kind}\``;
  return ORIGIN_WORD[origin.kind];
}

/** `name = value unit  (origin word, ref)` — one line per input, in wire order. */
export function inputLines(inputs) {
  if (!Array.isArray(inputs)) return [];
  return inputs.map((row) => {
    const unit = typeof row?.unit === "string" && row.unit ? ` ${row.unit}` : "";
    const word = originWord(row?.origin);
    // The REF is what makes the word actionable — "your file" is a category, "your file
    // (orbit.csv)" is an answer. It is omitted only when the origin does not carry one.
    const ref = typeof row?.origin?.ref === "string" && row.origin.ref
      ? ` ${row.origin.ref}` : "";
    const rendered = `${row?.name ?? "?"} = ${JSON.stringify(row?.value)}${unit}  (${word}${ref})`;
    return `    ${plainLine(rendered)}`;
  });
}

/**
 * ONE ROW PER INTENT, SPOKEN BY THIS DOOR TOO (RunWire v2, CONTRACTS.md S1).
 *
 * The rows are the `step_finished` facts keyed by `step_id`: the finding as the title, the
 * outcome word, the attempt count and the `RESULT:` line the program printed. Tool calls stay
 * folded; this door prints the plan, not the process.
 */
/** The budget that closed a partial row (`step_finished.cause`), in the reader's words — the same
 * words the workbench's row meta uses (`StepRow.vue`). */
const CAUSE_WORD = Object.freeze({
  row_budget: "stopped at its budget", wall_budget: "stopped at the turn's time limit",
  answer_now: "stopped to answer now; what it printed stands",
});

/**
 * THE ENGINEERING DOOR, SPOKEN BY THIS DOOR TOO (v2.4 S3; the web reads the same bytes in
 * `frontend/src/run/door.ts`, and both readers are held to `tests/fixtures/door-observations.json`).
 *
 * A `python` call whose summary is `run <verb>` is a call of one published engineering method;
 * its result's stdout is the bounded observation `laplace_ope/door_tail.py` prints. The reader is
 * tolerant: the excerpt keeps a long stream's first and last lines around `[…]`, so every section
 * is optional and the last `RESULT:` line is the headline of last resort.
 */
const DOOR_SUMMARY = /^run ([a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;
const DOOR_HEAD = /^([a-z][a-z0-9_]*): ok\b/;
const QUANTITY_LINE = /^ {2}(\S+) = (.*?)(?: {2}-- (.*))?$/;
const SECTION_OPEN = /^(inputs \(as given\):|inputs the owner defaulted|not set \(|quantities:|validity:|warnings:|files:|RESULT:)/;
const NUMBER = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|nan|-?inf)(?: (.+))?$/;

function quantityParts(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return { value: trimmed, unit: "" };
  const number = NUMBER.exec(trimmed);
  return number ? { value: number[1], unit: (number[2] ?? "").trim() } : { value: trimmed, unit: "" };
}

/** `{verb, headline: [{id, label, value, unit}], warnings}` of an observation, or null. */
export function doorObservation(text) {
  const lines = String(text ?? "").split("\n").map(line => line.replace(/\s+$/, ""));
  const head = DOOR_HEAD.exec(lines.find(line => line.trim()) ?? "");
  if (!head) return null;
  const cut = new Set();
  lines.forEach((line, index) => {
    if (line.trim() === "[…]") [index - 1, index, index + 1].forEach(n => cut.add(n));
  });
  const quantities = [];
  const warnings = [];
  let resultLine = "";
  let section = "";
  for (const [index, line] of lines.entries()) {
    if (index === 0 || cut.has(index)) continue;
    const open = SECTION_OPEN.exec(line);
    if (open) {
      section = open[1];
      if (section === "warnings:" && line.includes("none")) section = "";
      if (section === "RESULT:") resultLine = line.slice("RESULT:".length).trim();
      continue;
    }
    if (section === "quantities:") {
      const row = QUANTITY_LINE.exec(line);
      if (row) quantities.push({ id: row[1], label: row[3]?.trim() || row[1].replaceAll("_", " "), ...quantityParts(row[2]) });
    } else if (section === "warnings:" && /^ {2}- /.test(line)) {
      warnings.push(line.replace(/^ {2}- /, "").trim());
    }
  }
  const byId = new Map(quantities.map(quantity => [quantity.id, quantity]));
  const headline = [];
  for (const part of resultLine.split(/; (?=\S+ = )/)) {
    const row = /^(\S+) = (.*)$/.exec(part.trim());
    if (!row) continue;
    headline.push({ id: row[1], label: byId.get(row[1])?.label ?? row[1].replaceAll("_", " "), ...quantityParts(row[2]) });
  }
  // No parsable RESULT line: the last three physical quantities stand in (else the first three).
  if (!headline.length) headline.push(...quantities.filter(quantity => quantity.unit).slice(-3));
  if (!headline.length) headline.push(...quantities.slice(0, 3));
  return { verb: head[1], headline, warnings };
}

/** One qualification for both engineering rows and tool blocks; successful stdout must confirm the verb. */
export function engineeringCall(call, result) {
  const verb = call?.tool === "python" ? DOOR_SUMMARY.exec(String(call.summary ?? "").trim())?.[1] : null;
  if (!verb) return null;
  const observation = result?.status === "ok" ? doorObservation(result.stdout_excerpt) : null;
  if (result?.status === "ok" && observation?.verb !== verb) return null;
  const refusal = result && result.status !== "ok"
    ? String(result.stderr_excerpt || result.stdout_excerpt || "").trim().split("\n").filter(Boolean).slice(-3).join(" · ") : "";
  return { purpose: String(call.title ?? "").trim(), verb, observation, refusal, running: !result };
}

function doorCallsByStep(events) {
  const results = new Map();
  for (const event of events) {
    if (event?.kind === "tool_result" && typeof event.payload?.call_id === "string") {
      results.set(event.payload.call_id, event.payload);
    }
  }
  const rows = new Map();
  for (const event of events) {
    const call = event?.kind === "tool_call" ? event.payload : null;
    const door = engineeringCall(call, results.get(call?.call_id));
    if (!door) continue;
    const list = rows.get(call.step_id) ?? [];
    list.push(door);
    rows.set(call.step_id, list);
  }
  return rows;
}

function doorLine({ purpose, verb, observation, refusal, running }) {
  const said = observation
    ? observation.headline.map(quantity => `${quantity.label} ${quantity.value}${quantity.unit ? ` ${quantity.unit}` : ""}`).join(", ")
    : (refusal ? `refused: ${refusal}` : running ? "running" : "computed");
  const lines = [`  ▸ ${plainLine(purpose || verb)} — ${verb}: ${plainLine(said)}`];
  for (const warning of (observation?.warnings ?? []).slice(0, 2)) lines.push(`      ! ${plainLine(warning)}`);
  return lines.join("\n");
}

/** v5x (SPEC-r5 §3.3): the reader's word for a root capability family (`web`: the internet; `kc`: the customer's documents). */
const CAPABILITY_LABELS = Object.freeze({ web: "Web", kc: "Documents" });

/** A well-formed root `capability_tool` call as `{ label, name }` ("Web", "web_search"); null for any other call or a malformed one. */
export function capabilityCall(call) {
  if (call?.tool !== "capability_tool") return null;
  if (typeof call.family !== "string" || !Object.hasOwn(CAPABILITY_LABELS, call.family) || !isIdentifier(call.name)) return null;
  return { label: CAPABILITY_LABELS[call.family], name: call.name };
}

/** The owner's identifier shape (`laplace_ope.wire._identity`): a non-empty string of at most 200 Unicode CODE POINTS,
 * with no leading or trailing character Python's `str.strip()` removes. That set is every code point with
 * `str.isspace()` true, enumerated from CPython 3.12 (29 code points: U+0009-000D, U+001C-001F, U+0020, U+0085, U+00A0,
 * U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000); U+FEFF and U+180E are NOT in it. */
const PY_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
function isIdentifier(value) {
  return typeof value === "string" && value.length > 0 && [...value].length <= 200 && !PY_SPACE.test(value);
}

/** RunWire v4 (A8): a specialist family call (`specialist_tool`) folds under its own child row, by `step_id`;
 * v5x: a root capability call folds under its root row the same way, named "Web web_search". */
function specialistCallsByStep(events) {
  const rows = new Map();
  for (const event of events) {
    const call = event?.kind === "tool_call" ? event.payload : null;
    const capability = capabilityCall(call);
    const name = capability ? `${capability.label} ${capability.name}`
      : call?.tool === "specialist_tool" && typeof call.specialist_tool === "string" ? call.specialist_tool : null;
    if (name !== null) rows.set(call.step_id, [...(rows.get(call.step_id) ?? []), name]);
  }
  return rows;
}

function specialistCallsLine(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return `tools: ${[...counts].map(([tool, n]) => plainLine(n > 1 ? `${tool} ×${n}` : tool)).join(", ")}`;
}

/**
 * A RunWire v3 child row (v5 §4.2) prints under its delegating row with the agent's label
 * from the owner vocabulary; a main row (no `agent`) prints exactly as it always has.
 */
function childLabel(row) {
  return typeof row?.agent === "string" && Object.hasOwn(AGENT_LABELS, row.agent)
    ? `[${AGENT_LABELS[row.agent]}] ` : "";
}

export function taskLines(events, { facts = false } = {}) {
  const entries = mainTaskLines(events);
  if (facts) for (const entry of entries) {
    const row = entry.row;
    const missing = [row.status, row.cause, row.result_line].filter(value =>
      typeof value === "string" && value && !entry.line.includes(plainLine(value)));
    if (missing.length) entry.line += `\n    ${missing.map(plainLine).join(" · ")}`;
  }
  const nested = (line, row) => line.split("\n").map((part, index) =>
    index === 0 ? `    ↳ ${childLabel(row)}${part.trimStart()}` : `    ${part}`).join("\n");
  const children = entries.filter(({ row }) => childLabel(row));
  const placed = new Set();
  const lines = [];
  for (const entry of entries) {
    if (childLabel(entry.row)) continue;
    lines.push(entry.line);
    for (const child of children) {
      if (child.row.parent_step_id === entry.row.step_id) { lines.push(nested(child.line, child.row)); placed.add(child); }
    }
  }
  // A child whose delegating row is still open prints last, still labelled and nested.
  for (const child of children) if (!placed.has(child)) lines.push(nested(child.line, child.row));
  return lines;
}

function mainTaskLines(events) {
  const doors = doorCallsByStep(events);
  // The conclusion is engineering work (it prints the answer from evidence); its text is the
  // synthesis, so the row stays one line.
  const concluded = new Set(events.filter((event) => event?.kind === "tool_call" && event.payload?.tool === "conclude")
    .map((event) => event.payload.step_id));
  // Only a run that called the door tells engineering rows from execution rows; any other run
  // prints exactly as before.
  const distinguishes = doors.size > 0 || concluded.size > 0;
  const specialist = specialistCallsByStep(events);
  return events.flatMap((event) => {
    if (event?.kind !== "step_finished") return [];
    const calls = specialist.get(event.payload?.step_id);
    return rowLines(event).map(line => ({ line: calls ? `${line}\n      ${specialistCallsLine(calls)}` : line, row: event.payload }));
  });

  function rowLines(event) {
    const row = event.payload;
    if (!row || typeof row !== "object" || typeof row.step_id !== "string") return [];
    const outcome = CAUSE_WORD[row.cause] ?? row.status;
    const result = typeof row.result_line === "string" && row.result_line.trim() ? row.result_line : "";
    if (distinguishes) {
      const calls = doors.get(row.step_id);
      if (calls?.length) {
        const rest = row.status === "computed" ? [] : [`      (${plainLine(row.title)} — ${outcome})`];
        return [[...calls.map(doorLine), ...rest].join("\n")];
      }
      if (row.status === "asked" || concluded.has(row.step_id)) return [`  ▸ ${plainLine(`${row.title} — ${outcome}`)}`];
      // Execution, compressed to one line: what ran, how it ended, what it printed.
      return [`  · ${plainLine(`${row.title} — ${outcome}${result ? `: ${result}` : ""}`)}`];
    }
    const attempts = Number.isInteger(row.attempts) && row.attempts > 0
      ? ` · ${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"}` : "";
    const printed = result ? `\n    ${plainLine(result)}` : "";
    return [`  ${plainLine(`${row.title} — ${outcome}${attempts}`)}${printed}`];
  }
}

/**
 * SOURCES › ASSUMPTIONS, SPOKEN BY THIS DOOR TOO (RunWire v2 `input_rows`, CONTRACTS S1).
 *
 * One block per owner verb the turn's programs called, the LAST ledger event of the run
 * standing: what the customer stated (`your brief`), what the program assumed, what the
 * method's declared default was let stand, and how many arguments the program set from a
 * variable (no value the record can read). Rows print through `inputLines`, the same shape
 * as the legacy step inputs, so the origin words are the contract's.
 */
export function assumptionLines(events) {
  const ledger = events.filter((event) => event?.kind === "input_rows").at(-1);
  const blocks = Array.isArray(ledger?.payload?.blocks) ? ledger.payload.blocks : [];
  return blocks.flatMap((block) => {
    if (!block || typeof block.verb !== "string") return [];
    const set = Number.isInteger(block.program_set) && block.program_set > 0
      ? ` · ${block.program_set} set by the program` : "";
    const rows = Array.isArray(block.rows) ? block.rows : [];
    return [`  ${plainLine(block.verb)}${set}`, ...inputLines(rows)];
  });
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function safeArtifactName(artifact) {
  const leaf = artifact.filename.replaceAll("\\", "/").split("/").at(-1);
  if (!leaf || leaf === "." || leaf === ".." || leaf.startsWith("-") || leaf.startsWith(".")) {
    return `artifact-${artifact.cas_ref.slice("sha256:".length, "sha256:".length + 12)}`;
  }
  return leaf;
}

function terminalPresentation(value) {
  const terminalEvent = value.events.at(-1);
  if (terminalEvent?.kind !== "terminal") {
    throw new CliError("terminal_invalid", "Run record has no final terminal event");
  }
  const payload = terminalEvent.payload;
  const allowed = new Set([...TERMINAL_FIELDS, "terminal"]);
  if (Object.keys(payload).some(key => !allowed.has(key))) {
    throw new CliError("terminal_invalid", "Run terminal carries an undeclared field");
  }
  if (payload.state !== undefined && payload.terminal !== undefined
      && payload.state !== payload.terminal) {
    throw new CliError("terminal_mismatch", "Run terminal carries conflicting states");
  }
  const state = payload.state ?? payload.terminal;
  if (state !== value.terminal) {
    throw new CliError("terminal_mismatch", "Run terminal event disagrees with its record");
  }
  const syntheses = value.events.filter(event => event.kind === "synthesis").map(event => event.payload);
  const synthesis = syntheses.at(-1) ?? null;
  if (synthesis !== null && !validateSynthesis(synthesis)) {
    throw new CliError("synthesis_invalid", "Run carries malformed synthesis");
  }
  if (["ok", "partial"].includes(state)
      && (!synthesis || synthesis.terminal !== state)) {
    throw new CliError("synthesis_invalid", `Run terminal ${state} disagrees with its synthesis`);
  }
  if (payload.answer !== undefined
      && (!synthesis || payload.answer !== synthesis.answer)) {
    throw new CliError("synthesis_invalid", "Run terminal answer differs from its synthesis");
  }

  const defect = payload.defect;
  const recovery = payload.recovery;
  if (!["ok", "partial"].includes(state) && defect === undefined) {
    throw new CliError("recovery_invalid", `Run terminal ${state} carries no typed cause/recovery`);
  }
  if ((defect === undefined) !== (recovery === undefined)) {
    throw new CliError("recovery_invalid", "Run terminal cause and recovery must travel together");
  }
  if (defect !== undefined) {
    const declarations = TERMINAL_RECOVERY_DECLARATIONS[defect];
    if (!declarations || !Array.isArray(recovery) || recovery.length === 0) {
      throw new CliError("recovery_invalid", "Run terminal recovery is not owner-declared");
    }
    for (const action of recovery) {
      const fields = action && typeof action === "object" && !Array.isArray(action)
        ? Object.keys(action).sort().join(",") : "";
      const declaration = declarations.find(([capability]) => capability === action?.capability);
      const argumentsValue = action?.arguments;
      if (fields !== "arguments,capability" || !declaration || !argumentsValue
          || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)
          || Object.keys(argumentsValue).sort().join(",") !== [...declaration[1]].sort().join(",")
          || Object.values(argumentsValue).some(item => !(
            (typeof item === "string" && item.length > 0)
            || (Number.isSafeInteger(item) && item > 0)
          ))) {
        throw new CliError("recovery_invalid", "Run terminal recovery action is malformed");
      }
    }
  }
  return { state, answer: payload.answer, defect, recovery: recovery ?? [], capacity: payload.capacity };
}

/** `study_capacity` names its scope in the resource prefix (the frontend `run/terminal-note.ts` holds the same two sentences). */
const STUDY_CAPACITY_WORDS = {
  study_: "This study cannot grow further in this project; its results stay readable and downloadable.",
  run_: "This run reached its working limit; start a new run to continue.",
};
function capacityLine(defect, capacity) {
  const resource = typeof capacity?.resource === "string" ? capacity.resource : "";
  const prefix = Object.keys(STUDY_CAPACITY_WORDS).find(candidate => resource.startsWith(candidate));
  return defect === "study_capacity" && prefix ? [STUDY_CAPACITY_WORDS[prefix]] : [];
}

/** The stop's words and rule: `frontend/src/run/stop.ts` holds the same one over the same generated heads. */
const squeeze = text => String(text).split(/\s+/).filter(Boolean).join(" ");
function historicalResult(defect, state, answer, events) {
  if (!answer) return "none";
  const heads = HISTORICAL_STOP_HEADS[defect] ?? [];
  const [head, ...bullets] = answer.split("\n");
  if (!heads.includes(head) || !bullets.length || bullets.some(line => !line.startsWith("- "))) return "authored";
  // A draft the record shows the model released first is the model's, whatever it quotes.
  if (events.some(event => event.kind === "assistant_delta" && event.payload?.step !== null
      && String(event.payload?.text).startsWith(head))) return "authored";
  if (state !== "partial") return "unproven";
  const printed = new Set(events.filter(event => event.kind === "tool_result" && event.payload?.status === "ok"
    && typeof event.payload?.stdout_excerpt === "string").flatMap(event => event.payload.stdout_excerpt.split("\n").map(squeeze)));
  const proven = bullet => {
    const words = bullet.slice(2);
    for (let at = words.indexOf(": "); at >= 0; at = words.indexOf(": ", at + 1)) {
      const found = words.slice(at + 2);
      if (printed.has(found) || printed.has(`RESULT: ${found}`)) return true;
    }
    return false;
  };
  return bullets.every(proven) ? "summary" : "unproven";
}

function isRunStop(stop) {
  const sameFields = (value, names) => !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  if (!sameFields(stop, STOP_FIELDS) || !STOP_CAUSES.includes(stop.cause) || !STOP_RESULT_KINDS.includes(stop.result_kind)
      || typeof stop.source_run !== "string" || !stop.source_run
      || !(stop.parent_state_hash === null || /^[0-9a-f]{64}$/.test(stop.parent_state_hash))) return false;
  if (stop.binding === null) return stop.renews_at === null;
  return stop.cause === "plan_limit" && sameFields(stop.binding, STOP_BINDING_FIELDS)
    && STOP_BINDING_SCOPES.includes(stop.binding.scope) && STOP_PERIODS.includes(stop.binding.period)
    && [null, "free", "pro", "enterprise"].includes(stop.binding.tier)
    && Number.isSafeInteger(stop.renews_at) && stop.renews_at > 0;
}

/** What an old record's cause alone proves; a `provider_budget_exhausted` could have been the plan or the upstream. */
const HISTORICAL_CAUSE = { budget_exhausted: "run_limit", max_tokens: "output_limit", provider_route_exhausted: "route_failure" };

export function stopViewOf(events) {
  const terminal = events.at(-1);
  if (terminal?.kind !== "terminal") return null;
  const payload = terminal.payload ?? {};
  if (!HORIZON_STOP_DEFECTS.includes(payload.defect) || !["partial", "blocked"].includes(payload.state)) return null;
  if ("stop" in payload && !isRunStop(payload.stop)) throw new CliError("terminal_invalid", "Run terminal stop is not the closed record");
  const programs = new Set(events.filter(event => event.kind === "tool_call" && ["python", "replay"].includes(event.payload?.tool))
    .map(event => event.payload.call_id));
  const results = events.filter(event => event.kind === "tool_result" && programs.has(event.payload?.call_id));
  const counts = {
    computed: results.filter(event => event.payload.status === "ok").length,
    failed: results.filter(event => event.payload.status !== "ok").length,
    readOnly: events.filter(event => event.kind === "step_finished" && event.payload?.status === "read").length,
  };
  const stop = payload.stop;
  if (stop) return { typed: true, cause: stop.cause, binding: stop.binding, renewsAt: stop.renews_at, result: stop.result_kind, defect: payload.defect, ...counts };
  return { typed: false, cause: HISTORICAL_CAUSE[payload.defect] ?? null, binding: null, renewsAt: null, defect: payload.defect,
    result: historicalResult(payload.defect, payload.state, typeof payload.answer === "string" ? payload.answer : "", events), ...counts };
}

const fillWords = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function renewalDate(at) {
  const date = new Date(at * 1000);
  return `${WEEKDAY[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH[date.getUTCMonth()]}`;
}
const PLAN_NAME = { free: "Free", pro: "Pro", enterprise: "Enterprise" };

/** The stop block: no code, no plumbing. `offer` is the server's answer for this reader; without it no plan is named. */
function stopLines(view, value, offer, origin = "") {
  const model = MODEL_CATALOGUE.find(profile => profile.profile_id === value.profile)?.label ?? "The model";
  const plan = view.binding?.tier ? PLAN_NAME[view.binding.tier] : "";
  const period = view.binding?.period === "utc_month" ? "month" : "week";
  const key = view.cause === null || view.cause === "plan_limit"
    ? (!view.binding ? "limit" : view.binding.scope === "platform" ? "plan_platform" : "plan_restriction") : view.cause;
  const words = { model, plan, period };
  const result = view.result === "authored" ? STOP_WORDS.result.authored
    : view.computed ? STOP_WORDS.result.computed : STOP_WORDS.result.nothing;
  const lines = [fillWords(STOP_WORDS.heading[key], words),
    `${fillWords(STOP_WORDS.reason[key], words)} ${fillWords(result, words)}`];
  const proSteps = EXECUTION_HORIZONS.find(row => row.tier === "pro")?.max_steps;
  for (const id of offer?.actions ?? []) {
    if (id === "upgrade_plan") lines.push(`${PLAN_WORDS.pro_action}: ${origin}${STOP_ACTION_HREFS.upgrade_plan}`,
      `  ${fillWords(STOP_WORDS.action_line.upgrade_plan, { steps: String(proSteps), price: PLAN_WORDS.pro_price })}`);
    if (id === "contact_sales") lines.push(`${PLAN_WORDS.enterprise_action}: ${origin}${STOP_ACTION_HREFS.contact_sales}`, `  ${STOP_WORDS.action_line.contact_sales}`);
    if (id === "ask_owner") lines.push(view.binding?.tier === "pro" ? STOP_WORDS.action_line.ask_owner_pro : STOP_WORDS.action_line.ask_owner_free);
  }
  if (view.cause !== null && STOP_WORDS.forward[view.cause]) lines.push(STOP_WORDS.forward[view.cause]);
  if (view.renewsAt !== null) {
    lines.push(view.renewsAt <= (offer?.as_of ?? Math.floor(Date.now() / 1000)) ? STOP_WORDS.renews.renewed
      : fillWords(view.binding?.scope === "platform" ? STOP_WORDS.renews.plan : STOP_WORDS.renews.restriction, { plan, date: renewalDate(view.renewsAt) }));
  }
  if (offer ? offer.actions.includes("see_usage") : (view.cause === null || view.cause === "plan_limit")) {
    lines.push(`${STOP_WORDS.see_usage}: ${origin}${STOP_ACTION_HREFS.see_usage}`, STOP_WORDS.usage_note);
  }
  return lines.map(plainLine);
}

function stopActivity(view, artifacts) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [
    view.computed ? `${plural(view.computed, "program")} ran to the end.` : "",
    view.failed ? `${plural(view.failed, "program")} failed and computed nothing.` : "",
    view.readOnly ? `${plural(view.readOnly, "step")} only read methods or files.` : "",
    artifacts ? `${plural(artifacts, "file")} saved.` : "",
  ].filter(Boolean).join(" ");
}

function recoveryLine(action) {
  const args = Object.entries(action.arguments)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" ");
  return `Recovery: ${action.capability}${args ? ` ${args}` : ""}`;
}

export function currentTransferTables(events) {
  const candidates = new Map();
  const cleared = new Map();
  for (const event of events) {
    if (event.kind !== "engineering_projection") continue;
    const projection = event.payload;
    if (projection?.kind === "projection_clear" && projection.clear_kind === "transfer_table") {
      const ids = cleared.get(projection.node_id) ?? new Set();
      ids.add(projection.execution_id);
      cleared.set(projection.node_id, ids);
    } else if (projection?.kind === "transfer_table") {
      const rows = candidates.get(projection.node_id) ?? [];
      rows.push(projection);
      candidates.set(projection.node_id, rows);
    }
  }
  return [...candidates.entries()].flatMap(([node, rows]) => {
    const current = [...rows].reverse().find(row => !cleared.get(node)?.has(row.execution_id));
    return current ? [current] : [];
  });
}

/** The existing typed stop/cause/recovery tail, shared by canonical terminal blocks. */
export function terminalBlockLines(value) {
  const terminal = terminalPresentation(value);
  const stop = stopViewOf(value.events);
  return [`Terminal: ${plainLine(terminal.state)}`,
    ...(stop ? stopLines(stop, value) : []),
    ...(terminal.defect ? [`Cause: ${plainLine(terminal.defect)}`] : []),
    ...terminal.recovery.map(action => terminalText(recoveryLine(action)))];
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
export function runSections(value, { projectId, currentTransferIds, stopOffer, origin } = {}) {
  const terminal = value.terminal === "" ? null : terminalPresentation(value);
  const stop = terminal ? stopViewOf(value.events) : null;
  const origins = value.events.flatMap(event => event.kind === "step_finished"
    ? inputLines(event.payload?.step?.inputs ?? event.payload?.inputs) : []);
  const artifacts = runArtifacts(value.events);
  if (!artifacts.every(validateArtifact)) {
    throw new CliError("artifact_invalid", "Run carries malformed artifact metadata");
  }
  const project = projectId ? ` --project ${shellQuote(projectId)}` : "";
  const tables = currentTransferTables(value.events).filter(projection =>
    currentTransferIds?.has(projection.projection_id)).map(projection => {
    if (typeof projection.search_status !== "string" || projection.origin !== "unattributed"
        || typeof projection.validation_status !== "string" || typeof projection.withheld !== "boolean") {
      throw new CliError("projection_invalid", "Transfer table metadata is malformed");
    }
    return [`Transfer table: ${plainLine(projection.search_status)} · input origins ${projection.origin}`
      + ` · validation ${plainLine(projection.validation_status)}`
      + ` · path ${projection.withheld ? "withheld" : "shown"}`,
    `  vecteur projection get ${shellQuote(value.run_id)} ${shellQuote(projection.projection_id)}`
      + ` --output ${shellQuote("transfer-table.json")}${project}`];
  });
  const tail = [`Run: ${plainLine(value.run_id)}`];
  if (terminal && !stop) {
    tail.push(`Terminal: ${terminal.state}`);
    if (terminal.defect !== undefined) tail.push(`Cause: ${terminal.defect}`);
    tail.push(...capacityLine(terminal.defect, terminal.capacity));
    tail.push(...terminal.recovery.map(recoveryLine));
  }
  // A horizon stop: its words, before the work. Only the model's own text is printed as its answer; host words and an old
  // record's unproven text give way to what ran, in counts, never a value (planstop-r3; the web's StopSummary says the same).
  const hidden = stop && stop.result !== "authored";
  const answer = hidden ? stopActivity(stop, artifacts.length) : terminal?.answer;
  return { blocks: runBlocks(value), events: value.events, checks: hidden ? [] : publicationChecks(value.events), duration_seconds: value.duration_seconds, stop: stop ? stopLines(stop, value, stopOffer, origin) : [], answer, state: terminal?.state ?? "", tasks: taskLines(value.events, { facts: true }), origins,
    assumptions: assumptionLines(value.events), tables, artifacts: artifactRows(artifacts).map(row => ({ ...row,
      command: `vecteur artifact get ${shellQuote(row.artifact.cas_ref)} --output ${shellQuote(safeArtifactName(row.artifact))}${project}` })),
    tail };
}

/** The host's publication notes as the browser shows them (`frontend/src/run/publication.ts`), first six each: the figures the
 * run's evidence does not support as `Check: numbers not traced to a run: <figures>` (an unbound answer stays `ok`, so this line
 * is the review annotation), then each non-blank warning detail as `Check: <detail>`. The last synthesis owns them; anything
 * malformed is simply not shown. */
export function publicationChecks(events) {
  const publication = events.findLast(event => event.kind === "synthesis")?.payload?.core?.publication;
  const rows = Array.isArray(publication?.rows) ? publication.rows : [];
  const unbound = [...new Set(rows.filter(row => row?.status === "unbound" && typeof row.text === "string").map(row => row.text))].slice(0, 6);
  const warnings = Array.isArray(publication?.warnings) ? publication.warnings : [];
  return [...(unbound.length ? [`Check: numbers not traced to a run: ${unbound.map(plainLine).join(", ")}`] : []),
    ...warnings.map(item => item?.detail).filter(detail => typeof detail === "string" && detail.trim() !== "")
      .slice(0, 6).map(detail => `Check: ${plainLine(detail)}`)];
}

export function humanRun(value, { projectId, cost, currentTransferIds, stopOffer, origin, shownKeys = new Set() } = {}) {
  const run = runSections(value, { projectId, currentTransferIds, stopOffer, origin });
  return humanRunSections(run, { cost, shownKeys });
}

/** Render the supplied authoritative sections, suppressing only already printed rows. */
export function humanRunSections(run, { cost, shownKeys = new Set() } = {}) {
  const lines = [];
  if (run.stop.length) lines.push(...run.stop, "");
  if (run.answer !== undefined && run.answer !== "") lines.push(run.answer, "", ...(run.checks?.length ? [...run.checks, ""] : []));
  const remaining = run.blocks.filter(block => !shownKeys.has(block.key));
  for (const block of remaining.filter(block => ["tool", "sources", "clarification"].includes(block.kind))) lines.push(blockText(block), "");
  const shownSteps = new Set(run.blocks.filter(block => block.kind === "step" && shownKeys.has(block.key)).map(block => block.stepId));
  const tasks = shownSteps.size ? taskLines(run.events.filter(event => event.kind !== "step_finished" || !shownSteps.has(event.payload?.step_id)), { facts: true }) : run.tasks;
  if (tasks.length) lines.push("Steps:", ...tasks, "");
  if (run.origins.length) lines.push("Inputs and origins:", ...run.origins, "");
  if (run.assumptions.length) lines.push("Assumptions:", ...run.assumptions, "");
  for (const table of run.tables) lines.push(...table, "");
  if (run.artifacts.length) {
    lines.push("Artifacts:");
    for (const { artifact, command, number, sameBytesAs } of run.artifacts) {
      lines.push(`  ${terminalText(artifact.path ?? artifact.filename)} (${plainLine(artifact.kind)}, ${plainLine(artifact.id)}) · /download ${number}${sameBytesAs ? ` · same bytes as ${sameBytesAs}` : ""}`, `    ${terminalText(command)}`);
    }
    lines.push("");
  }
  lines.push(...run.tail);
  const controls = remaining.filter(block => block.kind === "control");
  if (controls.length) lines.push("", "Controls:", ...controls.map(block => blockText(block)));
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

export function progress(event) {
  if (event?.kind === "step_started") {
    const title = plainLine(event.payload?.title ?? "");
    return title.trim() ? `Starting: ${childLabel(event.payload)}${title}\n` : "Starting\n";
  }
  if (event?.kind === "artifact") {
    return `File ready: ${plainLine(event.payload.filename)}\n`;
  }
  if (event?.kind === "tool_call" && event.payload?.tool === "specialist_tool" && typeof event.payload.specialist_tool === "string") {
    // RunWire v4 (A8): each specialist family call is a live row of its own agent.
    const tool = event.payload.specialist_tool;
    const said = String(event.payload.summary ?? "").replace(new RegExp(`^${tool.replace(/[^\w]/g, "")}\\s*`), "").slice(0, 100);
    return `Specialist call: ${childLabel(event.payload)}${plainLine(tool)}${said.trim() ? ` — ${plainLine(said.trim())}` : ""}\n`;
  }
  const capability = event?.kind === "tool_call" ? capabilityCall(event.payload) : null;
  if (capability) {
    // v5x: a root capability call is a live row of the root agent, labelled by its family.
    const summary = String(event.payload.summary ?? "");
    const said = (summary.startsWith(capability.name) ? summary.slice(capability.name.length) : summary).trim().slice(0, 100);
    return `${capability.label} call: ${plainLine(capability.name)}${said ? ` — ${plainLine(said)}` : ""}\n`;
  }
  if (event?.kind === "tool_call" && event.payload?.tool === "local_exec") return `● Bash  ${plainLine(event.payload.summary)} · this computer\n`;
  if (event?.kind !== "step_finished") return "";
  const lines = inputLines(event?.payload?.step?.inputs ?? event?.payload?.inputs);
  const title = plainLine(event.payload?.step?.title ?? event.payload?.title ?? "");
  const head = title.trim() ? `Finished: ${childLabel(event.payload)}${title}\n` : "Finished\n";
  return lines.length ? `${head}${lines.join("\n")}\n` : head;
}

export function plainLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}
