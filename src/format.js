import {
  ORIGIN_KINDS, ORIGIN_WORD, TERMINAL_FIELDS, TERMINAL_RECOVERY_DECLARATIONS,
  validateArtifact, validateSynthesis,
} from "./contract.js";
import { CliError } from "./errors.js";

/** Terminal presentation only; exact copy and JSON paths retain the original bytes. */
export const terminalText = value => String(value ?? "").replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f-\x9f]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\t/g, "    ");

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

/** The door calls of each row, by `step_id`: `{purpose, verb, observation, refusal}` in call order. */
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
    const verb = call?.tool === "python" ? DOOR_SUMMARY.exec(String(call.summary ?? "").trim())?.[1] : null;
    if (!verb) continue;
    const result = results.get(call.call_id);
    const observation = result?.status === "ok" ? doorObservation(result.stdout_excerpt) : null;
    if (result?.status === "ok" && observation?.verb !== verb) continue; // free code that opened with `# run x_y`
    const refusal = result && result.status !== "ok"
      ? String(result.stderr_excerpt || result.stdout_excerpt || "").trim().split("\n").filter(Boolean).slice(-3).join(" · ") : "";
    const list = rows.get(call.step_id) ?? [];
    list.push({ purpose: String(call.title ?? "").trim(), verb, observation, refusal, running: !result });
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

export function taskLines(events) {
  const doors = doorCallsByStep(events);
  // The conclusion is engineering work (it prints the answer from evidence); its text is the
  // synthesis, so the row stays one line.
  const concluded = new Set(events.filter((event) => event?.kind === "tool_call" && event.payload?.tool === "conclude")
    .map((event) => event.payload.step_id));
  // Only a run that called the door tells engineering rows from execution rows; any other run
  // prints exactly as before.
  const distinguishes = doors.size > 0 || concluded.size > 0;
  return events.flatMap((event) => {
    if (event?.kind !== "step_finished") return [];
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
  });
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
  return { state, answer: payload.answer, defect, recovery: recovery ?? [] };
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

/** One projection of a Run record; plain text and the rich terminal both render these sections. */
export function runSections(value, { projectId, currentTransferIds } = {}) {
  const terminal = value.terminal === "" ? null : terminalPresentation(value);
  const origins = value.events.flatMap(event => event.kind === "step_finished"
    ? inputLines(event.payload?.step?.inputs ?? event.payload?.inputs) : []);
  const artifacts = value.events.filter(event => event.kind === "artifact").map(event => event.payload);
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
  if (terminal) {
    tail.push(`Terminal: ${terminal.state}`);
    if (terminal.defect !== undefined) tail.push(`Cause: ${terminal.defect}`);
    tail.push(...terminal.recovery.map(recoveryLine));
  }
  return { answer: terminal?.answer, state: terminal?.state ?? "", tasks: taskLines(value.events), origins,
    assumptions: assumptionLines(value.events), tables, artifacts: artifacts.map(artifact => ({ artifact,
      command: `vecteur artifact get ${shellQuote(artifact.cas_ref)} --output ${shellQuote(safeArtifactName(artifact))}${project}` })),
    tail };
}

export function humanRun(value, { projectId, cost, currentTransferIds } = {}) {
  const run = runSections(value, { projectId, currentTransferIds });
  const lines = [];
  if (run.answer !== undefined) lines.push(run.answer, "");
  if (run.tasks.length) lines.push("Steps:", ...run.tasks, "");
  if (run.origins.length) lines.push("Inputs and origins:", ...run.origins, "");
  if (run.assumptions.length) lines.push("Assumptions:", ...run.assumptions, "");
  for (const table of run.tables) lines.push(...table, "");
  if (run.artifacts.length) {
    lines.push("Artifacts:");
    for (const { artifact, command } of run.artifacts) {
      lines.push(`  ${artifact.filename} (${artifact.kind}, ${artifact.id})`, `    ${command}`);
    }
    lines.push("");
  }
  lines.push(...run.tail);
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
    return title.trim() ? `Starting: ${title}\n` : "Starting\n";
  }
  if (event?.kind === "artifact") {
    return `File ready: ${plainLine(event.payload.filename)}\n`;
  }
  if (event?.kind !== "step_finished") return "";
  const lines = inputLines(event?.payload?.step?.inputs ?? event?.payload?.inputs);
  const title = plainLine(event.payload?.step?.title ?? event.payload?.title ?? "");
  const head = title.trim() ? `Finished: ${title}\n` : "Finished\n";
  return lines.length ? `${head}${lines.join("\n")}\n` : head;
}

function plainLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}
