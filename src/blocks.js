import { humanRun, progress } from "./format.js";

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
  const same = cache && cache.run === run && cache.count <= events.length && cache.view;
  if (same && cache.count === events.length && cache.terminal === run?.terminal) return { ...cache.view, elapsed: elapsed(run, now) };
  const view = same ? cache.view : {
    subject: run ? { kind: "vecteur_run", id: run.run_id } : null,
    answer: "", question: null, artifacts: [], steps: [], progress: "Waiting for Vecteur",
    terminal: "", transcript: "",
  };
  for (let index = same ? cache.count : 0; index < events.length; index++) {
    const event = events[index];
    if (event.kind === "synthesis") view.answer = event.payload.answer ?? "";
    if (event.kind === "clarification") view.question = event.payload.state === "requested" ? event.payload : null;
    if (event.kind === "artifact") view.artifacts.push(event.payload);
    if (["step_started", "step_finished", "task"].includes(event.kind)) view.steps.push(event);
    const line = progress(event);
    if (line) view.progress = line.trim();
  }
  view.terminal = run?.terminal ?? "";
  view.transcript = run?.terminal ? humanRun(run) : "";
  if (cache) Object.assign(cache, { run, count: events.length, terminal: run?.terminal, view });
  return { ...view, elapsed: elapsed(run, now) };
}
