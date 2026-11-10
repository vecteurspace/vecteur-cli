import { humanRun, progress, plainLine, terminalText, taskLines, terminalBlockLines, engineeringCall, capabilityCall } from "./format.js";

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

/** RunWire owns the facts. Optional session cache projects only newly appended events. */
export function runView(run, cache, now = Date.now()) {
  const events = run?.events ?? [];
  const same = cache && cache.run === run && cache.runId === run?.run_id && cache.events === events && cache.count <= events.length && cache.view;
  if (same && cache.count === events.length && cache.terminal === run?.terminal) {
    return { ...cache.view, blocks: [...cache.view.eventBlocks, ...controlBlocks(run, cache.view.eventBlocks.length)], elapsed: elapsed(run, now) };
  }
  const view = same ? cache.view : {
    subject: run ? { kind: "vecteur_run", id: run.run_id } : null,
    answer: "", question: null, artifacts: [], steps: [], progress: "Waiting for Vecteur",
    terminal: "", transcript: "",
  };
  for (let index = same ? cache.count : 0; index < events.length; index++) {
    const event = events[index];
    if (event.kind === "synthesis") view.answer = event.payload.answer ?? "";
    if (event.kind === "clarification") view.question = event.payload.state === "requested" ? event.payload : null;
    if (["step_started", "step_finished", "task"].includes(event.kind)) view.steps.push(event);
    const line = progress(event);
    if (line) view.progress = line.trim();
  }
  view.terminal = run?.terminal ?? "";
  view.artifacts = runArtifacts(events);
  view.eventBlocks = eventBlocks(run);
  view.transcript = run?.terminal ? humanRun(run) : "";
  if (cache) Object.assign(cache, { run, runId: run?.run_id, events, count: events.length, terminal: run?.terminal, view });
  return { ...view, blocks: [...view.eventBlocks, ...controlBlocks(run, view.eventBlocks.length)], elapsed: elapsed(run, now) };
}


/** Current revision per logical path; content identity never removes a destination. */
export function runArtifacts(events = []) {
  const rows = new Map();
  for (const event of events) if (event.kind === "artifact") {
    const artifact = event.payload;
    const key = artifact.path ? `path:${artifact.path}` : `id:${artifact.id}`;
    const prior = rows.get(key);
    if (!prior || (artifact.revision ?? 0) >= (prior.revision ?? 0)) rows.set(key, artifact);
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

const tuple = (run, step, call) => JSON.stringify([run, step ?? null, call ?? null]);
const sourceRead = call => call.tool === "sources" && /^(context_list$|extraction:)/.test(call.summary ?? "");

/** Pure, replay-safe projection. Only the complete event prefix may leave the live region.
 * Controls have no event anchor: they follow in a separate section and stay live until terminal.
 * Payloads are never decorated/mutated, so machine JSON remains the owner's exact record.
 */
export function runBlocks(run) {
  const blocks = eventBlocks(run);
  return [...blocks, ...controlBlocks(run, blocks.length)];
}

function eventBlocks(run) {
  if (!run) return [];
  const events = [...(run.events ?? [])].sort((a, b) => a.seq - b.seq);
  const terminal = events.find(event => event.kind === "terminal");
  const calls = new Map(), byCall = new Map(), questions = new Map(), seen = new Set(), blocks = [];
  let fold = null;
  const closeFold = () => { if (fold) fold.closed = true; fold = null; };
  for (const event of events) {
    const payload = event.payload;
    if (event.kind === "tool_call") {
      const key = tuple(run.run_id, payload.step_id, payload.call_id);
      if (calls.has(key)) continue; // a reconnect may replay a prefix
      const call = { key, seq: event.seq, call: payload, result: null };
      calls.set(key, call); byCall.set(payload.call_id, call);
      if (sourceRead(payload)) {
        if (!fold || fold.stepId !== payload.step_id) {
          closeFold();
          fold = { kind: "sources", key, seq: event.seq, stepId: payload.step_id, calls: [], closed: false };
          blocks.push(fold);
        }
        fold.calls.push(call);
      } else {
        closeFold();
        blocks.push({ kind: "tool", key, seq: event.seq, stepId: payload.step_id, calls: [call] });
      }
    } else if (event.kind === "tool_result") {
      const call = byCall.get(payload.call_id);
      if (call && !call.result) call.result = payload;
    } else if (event.kind === "step_finished" || event.kind === "clarification") {
      closeFold();
      // Each clarification transition is immutable, with the original questions available on resolution.
      if (event.kind === "clarification" && payload.state === "requested") questions.set(payload.id, payload);
      const question = event.kind === "clarification" ? questions.get(payload.id) : null;
      const key = tuple(run.run_id, payload.step_id ?? payload.id, `${event.kind}:${event.seq}`);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push({ kind: event.kind === "clarification" ? "clarification" : "step",
        key, seq: event.seq, stepId: payload.step_id, payload, ...(question ? { question } : {}) });
    } else if (event.kind === "terminal") {
      closeFold();
      blocks.push({ kind: "terminal", key: tuple(run.run_id, null, "terminal"), seq: event.seq,
        state: payload.state ?? payload.terminal, lines: terminalBlockLines({ ...run, terminal: payload.state ?? payload.terminal }) });
    }
  }
  let waiting = false, number = 0;
  for (const block of blocks) {
    const complete = !block.calls || block.calls.every(call => call.result || terminal)
      && (block.kind !== "sources" || block.closed || terminal);
    waiting ||= !complete;
    block.committed = !waiting;
    block.number = ++number;
  }
  return blocks;
}

function controlBlocks(run, number) {
  return [...(run?.controls ?? [])].sort((a, b) => a.sequence - b.sequence).map(control => ({
    kind: "control", key: tuple(run.run_id, null, `control:${control.id}`),
    sequence: control.sequence, payload: control, committed: !!run.terminal, number: ++number,
  }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function sourceSummary(calls) {
  const extracts = new Set(), files = new Set();
  for (const { call, result } of calls) {
    if (result?.status !== "ok" || result.files_changed?.length) return null;
    let data;
    try { data = JSON.parse(result.stdout_excerpt); } catch { return null; }
    if (!data || typeof data !== "object" || Array.isArray(data)
        || data.extracts !== undefined && !Array.isArray(data.extracts)) return null;
    // Count extracts actually read, rather than those merely offered/selected by context_list.
    for (const extract of data.extracts ?? []) {
      const handle = extract?.source_handle;
      if (typeof extract?.id !== "string" || typeof handle?.cas_ref !== "string"
          || typeof handle?.acquisition_ref !== "string") return null;
      extracts.add(extract.id);
      files.add(JSON.stringify([handle.cas_ref, handle.acquisition_ref]));
    }
    if (call.summary !== "context_list" && !Array.isArray(data.extracts)) return null;
  }
  return extracts.size && files.size ? `Read ${plural(extracts.size, "extract")} from ${plural(files.size, "file")}` : null;
}

export function blockContent(block, { full = false } = {}) {
  if (block.kind === "terminal") return { title: `Terminal: ${block.state}`, rows: block.lines, status: block.state };
  if (block.kind === "step") {
    const row = block.payload;
    const rows = taskLines([{ kind: "step_finished", payload: row }]);
    // The existing engineering wording may paraphrase a cause; keep the typed facts too.
    if (row.cause) rows.push(`${plainLine(row.status)} · Cause: ${plainLine(row.cause)}`);
    return { title: "Step", status: row.status, rows };
  }
  if (block.kind === "control") {
    const c = block.payload;
    return { title: c.kind === "answer_now" ? "Answer now" : "Steer", status: c.state,
      rows: [c.state, ...(c.text ? [c.text] : [])] };
  }
  if (block.kind === "clarification") {
    const q = block.payload, source = block.question ?? q;
    const rows = [q.state];
    for (const question of source.questions ?? []) {
      rows.push(question.question);
      for (const choice of question.options ?? []) rows.push(`${choice.id ?? choice.value ?? ""} ${choice.label ?? choice}`);
    }
    if (q.answers) rows.push(`Answers: ${JSON.stringify(q.answers)}`);
    return { title: "Clarification", status: q.state, rows };
  }
  const { call } = block.calls[0];
  const engineering = !!engineeringCall(call, block.calls[0].result);
  const capability = capabilityCall(call);
  const tool = call.tool === "local_exec" ? "Bash" : engineering ? "Run" : call.tool === "python" ? "Python" : call.tool === "sources" ? "Sources"
    : capability ? `${capability.label} ${capability.name}` : call.tool;
  const status = block.calls.some(item => !item.result) ? block.committed ? "no result recorded" : "running"
    : block.calls.find(item => item.result.status !== "ok")?.result.status ?? "ok";
  const rows = [], preview = [];
  const previewTail = status !== "ok";
  const folded = block.kind === "sources" ? sourceSummary(block.calls) : null;
  if (folded && !full) return { tool, title: call.tool === "local_exec" ? `${call.summary} · this computer` : call.title ?? "", status, rows: [`${folded} · ok`], preview: [] };
  if (folded) rows.push(folded);
  for (const item of block.calls) {
    const c = item.call, r = item.result;
    const state = r?.status ?? (block.committed ? "no result recorded" : "running");
    const exit = r?.exit_code !== undefined && r.exit_code !== null ? ` · exit ${r.exit_code}` : "";
    const seconds = r?.seconds !== undefined && r.seconds !== null ? ` · ${r.seconds}s` : "";
    if (engineering && (r || !block.committed)) rows.push(...taskLines([
      { kind: "tool_call", payload: c }, ...(r ? [{ kind: "tool_result", payload: r }] : []),
      { kind: "step_finished", payload: { step_id: c.step_id, title: c.title, status: "computed" } },
    ]));
    rows.push(`${state}${exit}${seconds}`);
    for (const file of r?.files_changed ?? []) rows.push(`wrote ${file.path} (${file.bytes} B)`);
    if (r?.status === "denied" && r.stderr_excerpt) rows.push(r.stderr_excerpt);
    if (full) {
      rows.push(`Call: ${c.call_id}`, `Title: ${c.title ?? ""}`, `Summary: ${c.summary ?? ""}`);
      if (r?.stdout_ref) rows.push(`stdout_ref: ${r.stdout_ref}`);
      if (r) rows.push(`stdout excerpt:\n${r.stdout_excerpt || "(empty)"}`, `stderr excerpt:\n${r.stderr_excerpt || "(empty)"}`);
    } else if (!folded && !engineering) {
      // A failed call often carries its only explanation on stderr.
      const text = (r?.status === "ok" ? r.stdout_excerpt : r?.stderr_excerpt || r?.stdout_excerpt) ?? "";
      if (text) preview.push(...terminalText(text).split("\n").filter(line => line.trim()));
    }
  }
  return { tool, title: call.tool === "local_exec" ? `${call.summary} · this computer` : call.title ?? "", status, rows, preview, previewTail, excerpt: preview.length > 0 };
}

/** Human text for plain/dumb and /details, never JSON or terminal escape sequences. */
export function blockText(block, options = {}) {
  const content = blockContent(block, options);
  const head = `[${content.status ?? ""}] ${content.tool ? content.tool + " " : ""}${content.title}`;
  const rows = content.rows.map(terminalText);
  const preview = content.preview ?? [];
  if (preview.length) {
    rows.push(...(content.previewTail ? preview.slice(-3) : preview.slice(0, 3)));
    rows.push(preview.length > 3 ? "… output excerpt truncated · ctrl+o for the full block" : "output excerpt · ctrl+o for the full block");
  }
  return `${plainLine(head)}${rows.length ? ": " + rows.join("\n  ") : ""}`;
}
