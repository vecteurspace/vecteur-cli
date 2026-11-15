import { progress, plainLine, terminalText, terminalBlockLines } from "./format.js";
import { EVENT_KINDS } from "./contract.js";

function elapsed(run, now) {
  if (!run) return null;
  const accepted = run.accepted_at;
  // Both owner duration and live age start at admission, never at local follow/restart.
  // Live age uses the client wall clock; invalid/future anchors are unavailable.
  const seconds = run.terminal ? run.duration_seconds
    : Number.isSafeInteger(accepted) && accepted >= 0 && accepted <= now / 1000
      ? Math.floor(now / 1000 - accepted) : null;
  if (!Number.isSafeInteger(seconds) || seconds < 0) return "Elapsed unavailable";
  const pad = value => String(value).padStart(2, "0");
  return "Elapsed " + (seconds >= 3600 ? `${Math.floor(seconds / 3600)}:` : "")
    + `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

/** The wire owns the facts; this is the turn as a reader sees it. */
export function runView(run, now = Date.now()) {
  const events = run?.events ?? [];
  let progressLine = "Waiting for Vecteur";
  for (const event of events) { const line = progress(event); if (line) progressLine = line.trim(); }
  return {
    subject: run ? { kind: "vecteur_run", id: run.run_id } : null,
    answer: events.findLast(event => event.kind === "synthesis")?.payload.markdown ?? "",
    artifacts: runArtifacts(events), progress: progressLine, terminal: run?.terminal ?? "",
    blocks: runBlocks(run), elapsed: elapsed(run, now),
  };
}

/** Current revision per path. */
export function runArtifacts(events = []) {
  const rows = new Map();
  for (const event of events) if (event.kind === "artifact") {
    const prior = rows.get(event.payload.path);
    if (!prior || event.payload.revision >= prior.revision) rows.set(event.payload.path, event.payload);
  }
  return [...rows.values()];
}

export function artifactRows(artifacts) {
  const first = new Map();
  return artifacts.map((artifact, index) => {
    const number = index + 1, sameBytesAs = first.get(artifact.cas_ref) ?? null;
    if (!sameBytesAs) first.set(artifact.cas_ref, number);
    return { artifact, number, sameBytesAs };
  });
}

/** Pure, replay-safe projection: one block per tool call (with its result once it arrived), one for the terminal,
 * and one for any event kind this build does not know. A block is committed once nothing before it is still running. */
export function runBlocks(run) {
  if (!run) return [];
  const events = [...(run.events ?? [])].sort((a, b) => a.seq - b.seq);
  const closed = events.some(event => event.kind === "terminal");
  const byCall = new Map(), blocks = [];
  for (const event of events) {
    const payload = event.payload;
    if (event.kind === "tool_call") {
      if (byCall.has(payload.call_id)) continue; // a reconnect may replay a prefix
      const block = { kind: "tool", key: `${run.run_id}:${payload.call_id}`, seq: event.seq, call: payload, result: null };
      byCall.set(payload.call_id, block); blocks.push(block);
    } else if (event.kind === "tool_result") {
      const block = byCall.get(payload.call_id);
      if (block && !block.result) block.result = payload;
    } else if (event.kind === "terminal") {
      blocks.push({ kind: "terminal", key: `${run.run_id}:terminal`, seq: event.seq, state: payload.state,
        lines: terminalBlockLines({ ...run, terminal: payload.state }) });
    } else if (!EVENT_KINDS.includes(event.kind)) {
      blocks.push({ kind: "unknown", key: `${run.run_id}:unknown:${event.seq}`, seq: event.seq, eventKind: String(event.kind) });
    }
  }
  let waiting = false, number = 0;
  for (const block of blocks) {
    waiting ||= block.kind === "tool" && !block.result && !closed;
    block.committed = !waiting;
    block.number = ++number;
  }
  return blocks;
}

const TOOL_LABEL = tool => String(tool).charAt(0).toUpperCase() + String(tool).slice(1);

/** `{tool, title, status, rows}`; `full` adds the call's input and the result excerpt. */
export function blockContent(block, { full = false } = {}) {
  if (block.kind === "terminal") return { title: `Terminal: ${block.state}`, rows: block.lines, status: block.state };
  if (block.kind === "unknown") return { title: `Unknown event kind: ${block.eventKind}`, rows: ["This CLI cannot read it; next: vecteur update"], status: "unknown" };
  const { call, result } = block;
  const status = result ? (result.ok ? "ok" : "failed") : block.committed ? "no result recorded" : "running";
  const rows = [];
  if (full) {
    rows.push(`Call: ${call.call_id}`, `Input: ${JSON.stringify(call.input)}`);
    if (result) rows.push(`${status} · ${result.bytes} B`, `Output excerpt:\n${result.excerpt || "(empty)"}`);
  } else if (result && !result.ok) {
    // A failed call's last line is usually its cause.
    const cause = result.excerpt.split("\n").filter(line => line.trim()).at(-1);
    if (cause) rows.push(cause);
  }
  return { tool: TOOL_LABEL(call.tool), title: call.title, status, rows };
}

/** Human text for plain/dumb and /details: one line per call, never JSON or terminal escape sequences. */
export function blockText(block, options = {}) {
  const content = blockContent(block, options);
  const head = `[${content.status}] ${content.tool ? content.tool + " " : ""}${content.title}`;
  const rows = content.rows.map(terminalText);
  return `${plainLine(head)}${rows.length ? ": " + rows.join("\n  ") : ""}`;
}
