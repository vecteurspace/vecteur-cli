/** Wire v6 as this door reads it: one run is one turn; an event is `{run_id, seq, kind, payload}`.
 * The vocabularies are the owner's (`contract.js`, generated); the payload shapes below follow `runner/wire.py`.
 * Anything this reader does not know is refused by name, never rendered as a success. */
import { EVENT_KINDS, STORED_WIRE_VERSIONS, TERMINAL_DEFECTS, TERMINAL_STATES, TOOL_KINDS } from "./contract.js";
import { CliError } from "./errors.js";

const CAS_REF = /^sha256:[0-9a-f]{64}$/;
const STATE_HASH = /^[0-9a-f]{64}$/;
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;

export const isStateHash = value => typeof value === "string" && STATE_HASH.test(value);

/** One check per kind; a payload may carry more than these fields, never less. */
const PAYLOADS = {
  assistant_delta: p => typeof p.text === "string",
  tool_call: p => text(p.call_id) && TOOL_KINDS.includes(p.tool) && typeof p.title === "string" && object(p.input),
  tool_result: p => text(p.call_id) && typeof p.ok === "boolean" && typeof p.excerpt === "string" && count(p.bytes),
  synthesis: p => typeof p.markdown === "string",
  artifact: p => text(p.path) && count(p.revision) && CAS_REF.test(p.cas_ref) && text(p.media_type) && count(p.bytes) && text(p.kind),
  study: p => CAS_REF.test(p.cas_ref),
  review: p => CAS_REF.test(p.cas_ref) && text(p.verdict),
  terminal: p => (p.defect === undefined || TERMINAL_DEFECTS.includes(p.defect)) && (p.usage === null || object(p.usage)),
};

/** The runner numbers a run's events from 1 (runner/store.py `append`) and resumes after the Last-Event-ID it is sent. */
export const FIRST_EVENT_SEQ = 1;

export function validateEvent(value, runId, expectedSeq) {
  if (!object(value) || Object.keys(value).sort().join(",") !== "kind,payload,run_id,seq") {
    throw new CliError("event_invalid", "Server returned malformed owner data");
  }
  if (value.run_id !== runId || value.seq !== expectedSeq) {
    throw new CliError("event_sequence_invalid", `Expected event sequence ${expectedSeq}`);
  }
  if (!EVENT_KINDS.includes(value.kind)) {
    throw new CliError("event_kind_unknown", `Run event ${expectedSeq} has a kind this CLI does not know (${String(value.kind).slice(0, 40)}); next: vecteur update`);
  }
  if (value.kind === "terminal" && object(value.payload) && !TERMINAL_STATES.includes(value.payload.state)) {
    throw new CliError("terminal_state_unknown", `Run ended in a state this CLI does not know (${String(value.payload.state).slice(0, 40)}); next: vecteur update`);
  }
  if (!object(value.payload) || !PAYLOADS[value.kind](value.payload)) {
    throw new CliError("event_invalid", `Run event ${expectedSeq} (${value.kind}) is malformed`);
  }
  return value;
}

/** The run record: an open run has no terminal and no result hash; a closed one has both, and its last event says the same state. */
export function validateRun(value, runId = value?.run_id) {
  const invalid = why => new CliError("run_invalid", `Server returned malformed run record (${why})`);
  if (!object(value) || !text(value.run_id) || value.run_id !== runId) throw invalid("identity");
  if (!isStateHash(value.state_hash)) throw invalid("state_hash");
  if (typeof value.result_hash !== "string" || typeof value.terminal !== "string" || !Array.isArray(value.events)) throw invalid("shape");
  if (value.stored_wire_version !== undefined && !STORED_WIRE_VERSIONS.includes(value.stored_wire_version)) {
    throw new CliError("wire_version_unsupported", "this Run is stored in a wire version this CLI cannot read; next: vecteur update");
  }
  if (value.duration_seconds !== undefined && value.duration_seconds !== null && !count(value.duration_seconds)) throw invalid("duration_seconds");
  value.events.forEach((event, index) => validateEvent(event, value.run_id, FIRST_EVENT_SEQ + index));
  const last = value.events.at(-1);
  if (value.events.some((event, index) => event.kind === "terminal" && index !== value.events.length - 1)) throw invalid("events after terminal");
  if (value.terminal === "") {
    if (value.result_hash !== "" || last?.kind === "terminal") throw invalid("open run carries a result");
    return value;
  }
  if (!TERMINAL_STATES.includes(value.terminal)) {
    throw new CliError("terminal_state_unknown", `Run ended in a state this CLI does not know (${value.terminal.slice(0, 40)}); next: vecteur update`);
  }
  if (!value.result_hash) throw invalid("terminal without result_hash");
  if (last?.kind !== "terminal") throw new CliError("terminal_invalid", "Run record has no final terminal event");
  if (last.payload.state !== value.terminal) throw new CliError("terminal_mismatch", "Run terminal event disagrees with its record");
  return value;
}
