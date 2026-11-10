import { withAdmissionLock, admissionIntent, admissionResolved, unresolvedAdmissions, selectInvocationFiles } from "./localfiles.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  ARTIFACT_MEDIA_TYPES, EVENT_KINDS, OWNER_CONTRACT_IDENTITY, RETIRED_EVENT_KINDS, validateAdmitted,
  validateCliRelease, validateCustomerCostProjection, validateDeviceAuthorization, validateLimitDenial,
  validatePatCreated, validateProject, validateRunAck, validateAccount, validateQuotaDenial,
  RECOVERY_ACTIONS, validateRunStopOffer, validateRunControl, validateSource, validateSourceOffer,
  AGENT_LABELS, CHILD_WIRE_VERSIONS, SPECIALIST_TOOL_WIRE_VERSION, LOCAL_EXEC_WIRE_VERSION, STORED_WIRE_VERSIONS, WIRE_READER_HEADER, WIRE_READER_VERSION, WIRE_VERSION_UNSUPPORTED,
} from "./contract.js";
import { credentialsPath, readCredentials } from "./credentials.js";
import { readStore, writeStore } from "./store.js";
import { CliError } from "./errors.js";
import { canonicalJson, capabilityCall } from "./format.js";

// Re-exported so every existing importer keeps its one import site; `errors.js` owns the type.
export { CliError };

const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_ORIGIN = "https://vecteur.space";
const TOKEN_PATTERN = /vct_[A-Za-z0-9_-]{20,}/g;
const TOKEN_SHAPE = /^vct_[A-Za-z0-9_-]{43}$/;
const RELEASE_TIMEOUT = Symbol("release-timeout");
const RESPONSE_ACTIVITY = Symbol("response-activity");
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_EVENTS = 10_000;
const CAS_REF_SHAPE = /^sha256:([0-9a-f]{64})$/;
const STATE_HASH_SHAPE = /^[0-9a-f]{64}$/;


/** The one shape of a design head, so `--parent` and the head read cannot disagree. */
export function isStateHash(value) {
  return typeof value === "string" && STATE_HASH_SHAPE.test(value);
}

export const isRequestKey = value => typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);

export function validateAnswers(answers) {
  if (!Array.isArray(answers) || !answers.length || !answers.every(answer =>
    answer && typeof answer === "object" && !Array.isArray(answer)
    && Object.keys(answer).every(key => ["id", "selected", "custom"].includes(key))
    && typeof answer.id === "string" && answer.id.length > 0
    && Array.isArray(answer.selected) && answer.selected.every(item => typeof item === "string")
    && (answer.custom === undefined || answer.custom === null || typeof answer.custom === "string"))) {
    throw new CliError("answers_invalid", "Expected an array of {id, selected: string[], custom?: string|null}");
  }
  return answers;
}

/**
 * A failure after the acknowledgement names the admitted Run, which may still be running:
 * retrying the submit would now continue its head and admit a second, billable turn.
 */
export function admittedFailure(error, runId) {
  if (!(error instanceof CliError)) return error;
  if (error.code === "pat_expired") {
    return new CliError("pat_expired",
      `credential expired after Run ${runId} was admitted; next: vecteur login; then: vecteur run get ${runId}`, { run_id: runId });
  }
  return new CliError(error.code,
    `Run ${runId} was admitted and may still be running; next: vecteur run get ${runId}`, { run_id: runId });
}

export function redact(value) {
  return String(value).replace(TOKEN_PATTERN, "[REDACTED]");
}

function refuseSecretValue(value) {
  if (/vct_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(value))) {
    throw new CliError("secret_response_refused", "Public API response contains credential-shaped data");
  }
  return value;
}

function canonicalOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("origin_invalid", "origin must be an absolute public origin");
  }
  const lexicalLoopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(raw);
  if ((url.protocol !== "https:" && !lexicalLoopback) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("origin_invalid", "origin must be HTTPS or an exact loopback HTTP origin");
  }
  return url.origin;
}

function originKey(raw) {
  const stripped = String(raw).replace(/\/+$/, "");
  try { return new URL(stripped).origin; } catch { return stripped; }
}

/**
 * Where a run gets its origin and its token, in one place.
 *
 * Origin precedence is `--origin` > `VECTEUR_BASE_URL` > the store's current origin. The
 * environment token still wins, because that is how CI and a container pass a credential
 * and neither should have to write a file to do it. `VECTEUR_TOKEN` is the CI path and is
 * never written or cleared by login or logout.
 *
 * A stored login does not lend its token to a different origin named by `--origin` or
 * `VECTEUR_BASE_URL`: a token minted for one deployment silently pointed at another is a
 * credential leak with a good explanation.
 */
/**
 * The one origin rule: `--origin` > `VECTEUR_BASE_URL` > the store's current origin > the
 * public product. `login` resolved it separately and reached a different answer on an empty
 * machine — it fell back to the product, `configuration` fell back to the empty string — which
 * is what two owners of one rule always eventually do.
 */
export function resolveOrigin(env = process.env, stored = undefined, originFlag = undefined) {
  const saved = stored === undefined && !env.VECTEUR_TOKEN ? readCredentials(env) : stored;
  return canonicalOrigin(
    originFlag ?? env.VECTEUR_BASE_URL ?? saved?.current ?? DEFAULT_ORIGIN);
}

/** The one timeout rule, so a bound the client enforces is not re-stated by its caller. */
export function requestTimeout(env = process.env) {
  const timeout = Number(env.VECTEUR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
    throw new CliError("timeout_invalid", "VECTEUR_TIMEOUT_MS must be 100 to 120000");
  }
  return timeout;
}

/** The one token-shape rule, so `login` and `configuration` cannot disagree about a credential. */
export function isTokenShaped(value) {
  return TOKEN_SHAPE.test(value);
}

export function configuration(env = process.env, stored = undefined, originFlag = undefined) {
  // THE CI PATH DOES NOT READ THE STORE. `VECTEUR_TOKEN` is how a container and a CI job hand
  // over a credential, and neither has a store; reading one anyway meant an unreadable file on
  // the machine broke a run that never needed it — `credentials_unreadable` for a credential
  // the environment had already supplied.
  const saved = env.VECTEUR_TOKEN
    ? null
    : (stored === undefined ? readCredentials(env) : stored);
  const named = originFlag ?? env.VECTEUR_BASE_URL;

  // A STORED TOKEN GOES TO THE ORIGIN IT WAS STORED FOR, AND NOWHERE ELSE.
  if (!env.VECTEUR_TOKEN && saved && named && !Object.hasOwn(saved.logins, originKey(named))) {
    throw new CliError("origin_mismatch",
      `the stored login is for ${saved.current} and ${originFlag !== undefined ? "--origin" : "VECTEUR_BASE_URL"} names `
      + `${named} — set VECTEUR_TOKEN for that origin, or log in to it`);
  }

  const origin = resolveOrigin(env, saved, originFlag);
  const token = env.VECTEUR_TOKEN ?? saved?.logins?.[originKey(origin)]?.token ?? "";

  if (!isTokenShaped(token)) {
    throw new CliError("token_invalid", saved
      ? "the stored login does not hold one personal access token — run `vecteur login` again"
      : "no login found: run `vecteur login`, or set VECTEUR_TOKEN");
  }
  return { origin, token, timeout: requestTimeout(env),
    projectId: saved?.logins?.[originKey(origin)]?.project_id };
}

export function shouldOpenBrowser(noBrowser, env = process.env) {
  if (noBrowser) return false;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

export function delay(ms, signal = undefined) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      reject(new CliError("request_cancelled", "Waiting was cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export async function waitForDeviceAuthorization(client, grant, { sleep = delay, now = Date.now, signal } = {}) {
  if (!validateDeviceAuthorization(grant)) {
    throw new CliError("device_authorization_invalid", "Server returned malformed owner data");
  }
  const intervalMs = grant.interval * 1000;
  while (true) {
    if (now() >= grant.expires_at * 1000) {
      throw new CliError("device_expired", "This code has expired");
    }
    try {
      const polled = await client.devicePoll(grant.device_code, signal);
      if (validatePatCreated(polled)) return polled;
      if (polled && polled.status === "authorization_pending") {
        await sleep(intervalMs, signal);
        continue;
      }
      throw new CliError("device_poll_invalid", "Server returned malformed owner data");
    } catch (error) {
      if (error instanceof CliError && error.code === "device_slow_down") {
        await sleep(intervalMs, signal);
        continue;
      }
      throw error;
    }
  }
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...fields].sort().join("\n")) {
    throw new CliError(code, "Server returned malformed owner data");
  }
  return value;
}

const CHILD_AGENTS = Object.keys(AGENT_LABELS).filter(agent => agent !== "engineering");
const STORED_WIRE_VERSION_HEADER = "X-Vecteur-Stored-Wire-Version";

/**
 * RunWire v3 (v5 spec §4.1): a child row names its agent and the main row that delegated it,
 * and exists only on a record the owner served at version 3 -- read from the record, never
 * guessed from the rows. OPE owns the full nesting law; this reader refuses what it cannot
 * render honestly: an unknown agent, a parent it never saw, or a child row on a v1/v2 record.
 */
export function validateChildRows(events, storedVersion) {
  const check = rowGuard(storedVersion);
  events.forEach(check);
  return events;
}

/**
 * The same law, one event at a time: the streaming path runs it BEFORE it forwards a live event, and a reconnect
 * seeds it with the events already received so the row context survives. A v5x `capability_tool` call must name
 * an existing ROOT row and carry a closed family, an identifier and no child metadata at all.
 */
export function rowGuard(storedVersion) {
  if (!STORED_WIRE_VERSIONS.includes(storedVersion)) {
    throw new CliError("run_invalid", "Server returned an unknown stored RunWire version");
  }
  const opened = new Map();
  return (event) => {
    if (event.kind === "tool_call" && event.payload?.tool === "local_exec" && storedVersion < LOCAL_EXEC_WIRE_VERSION) throw new CliError("run_invalid", "Local command requires RunWire v5");
    if (event.kind === "tool_call" && event.payload?.tool === "capability_tool") {
      const payload = event.payload;
      if (!capabilityCall(payload) || ["agent", "parent_step_id", "specialist_tool"].some(key => Object.hasOwn(payload, key))
          || opened.get(payload.step_id) !== null) {
        throw new CliError("run_invalid", "Server returned a malformed capability call");
      }
      return;
    }
    if (event.kind === "tool_call" && event.payload?.tool === "specialist_tool") {
      // RunWire v4 (A8): a specialist family call, only on a v4 record, under an open row of its own agent.
      const { agent, step_id: stepId, specialist_tool: tool } = event.payload;
      if (storedVersion < SPECIALIST_TOOL_WIRE_VERSION || !CHILD_AGENTS.includes(agent)
          || opened.get(stepId) !== agent || typeof tool !== "string" || !tool) {
        throw new CliError("run_invalid", "Server returned a malformed specialist call");
      }
      return;
    }
    if (event.kind !== "step_started" && event.kind !== "step_finished") return;
    const { agent, parent_step_id: parent, step_id: stepId } = event.payload;
    const child = agent !== undefined || parent !== undefined;
    if (!child) {
      if (event.kind === "step_started" && !opened.has(stepId)) opened.set(stepId, null);
      return;
    }
    if (!CHILD_WIRE_VERSIONS.includes(storedVersion) || !CHILD_AGENTS.includes(agent) || typeof parent !== "string"
        || opened.get(parent) !== null || (event.kind === "step_started" && opened.has(stepId))) {
      throw new CliError("run_invalid", "Server returned a malformed child row");
    }
    if (event.kind === "step_started") opened.set(stepId, agent);
  };
}

export function validateEvent(value, runId, expectedSeq) {
  exactObject(value, ["run_id", "seq", "kind", "payload"], "event_invalid");
  if (value.run_id !== runId || !Number.isInteger(value.seq) || value.seq !== expectedSeq ||
      !(EVENT_KINDS.includes(value.kind) || RETIRED_EVENT_KINDS.includes(value.kind)) ||
      !value.payload || typeof value.payload !== "object" ||
      Array.isArray(value.payload)) {
    throw new CliError("event_sequence_invalid", `Expected event sequence ${expectedSeq}`);
  }
  if (value.payload.evidence_dag !== undefined) {
    validateEvidenceDag(value.payload.evidence_dag, runId);
  }
  return value;
}

function evidenceReplayInvalid(message) {
  throw new CliError("evidence_replay_invalid", `EvidenceDAG ${message}`);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export function validateEvidenceDag(value, runId) {
  if (!exactKeys(value, ["id", "schema_version", "run_id", "nodes", "edges"])) {
    evidenceReplayInvalid("shape is invalid");
  }
  if (value.schema_version !== "evidence-dag.v1" || value.run_id !== runId ||
      typeof value.id !== "string" || !value.id || !Array.isArray(value.nodes) ||
      !Array.isArray(value.edges)) {
    evidenceReplayInvalid("identity or arrays are invalid");
  }
  const digest = createHash("sha256").update(canonicalJson({
    schema_version: value.schema_version, run_id: value.run_id,
    nodes: value.nodes, edges: value.edges,
  }).trimEnd(), "utf8").digest("hex");
  if (value.id !== `evidence-dag:sha256:${digest}`) evidenceReplayInvalid("id seal is invalid");
  return value;
}

/**
 * The material a submit selects: the composer's exact shape (one exact-extract selection per
 * attached source, both lists in source order). Absent keeps the Project's carried sources.
 */
export function submissionMaterial(selections) {
  if (selections === undefined) return { attachments: [] };
  const key = (s) => `${s.source_handle.cas_ref}\n${s.source_handle.acquisition_ref}`;
  if (!Array.isArray(selections) || selections.length === 0 || !selections.every(s =>
    exactKeys(s, ["source_handle", "offer_id", "selected_extract_ids", "method"])
    && exactKeys(s.source_handle, ["cas_ref", "acquisition_ref"])
    && /^sha256:[0-9a-f]{64}$/.test(s.source_handle.cas_ref) && typeof s.source_handle.acquisition_ref === "string"
    && s.source_handle.acquisition_ref.length > 0 && typeof s.offer_id === "string" && s.offer_id.length > 0
    && Array.isArray(s.selected_extract_ids) && s.selected_extract_ids.length > 0
    && s.selected_extract_ids.every(id => typeof id === "string" && id.length > 0)
    && new Set(s.selected_extract_ids).size === s.selected_extract_ids.length
    && s.method === "exact-extract") || new Set(selections.map(key)).size !== selections.length) {
    throw new CliError("selection_invalid",
      "Each selection is {source_handle, offer_id, selected_extract_ids, method: exact-extract}, one per source");
  }
  const sorted = [...selections].sort((a, b) => key(a).localeCompare(key(b))).map(s => ({
    source_handle: { cas_ref: s.source_handle.cas_ref, acquisition_ref: s.source_handle.acquisition_ref },
    offer_id: s.offer_id, selected_extract_ids: [...s.selected_extract_ids].sort(), method: s.method,
  }));
  return { attachments: sorted.map(s => ({ ...s.source_handle })), selections: sorted };
}

export async function parseSse(response, runId, onEvent = null, startSeq = 0, guard = null) {
  if (!Number.isSafeInteger(startSeq) || startSeq < 0 || startSeq >= MAX_EVENTS) {
    throw new CliError("cursor_invalid", "Event cursor is outside the supported history bound");
  }
  if (!response.body) throw new CliError("sse_invalid", "Event response has no body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let total = 0;
  const events = [];
  let terminalSeen = false;
  const reader = response.body.getReader();
  const signal = response["vecteurAbortSignal"];
  try {
    while (true) {
      let result;
      if (signal) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        let rejectAbort;
        const aborted = new Promise((_, reject) => {
          rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", rejectAbort, { once: true });
        });
        try { result = await Promise.race([reader.read(), aborted]); }
        finally { signal.removeEventListener("abort", rejectAbort); }
      } else result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      response[RESPONSE_ACTIVITY]?.();
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new CliError("response_too_large", "Event response exceeds limit");
      try { buffer += decoder.decode(chunk, { stream: true }); }
      catch { throw new CliError("sse_invalid", "Event stream is not UTF-8"); }
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary).replace(/\r/g, "");
        if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
          throw new CliError("sse_invalid", "SSE frame exceeds limit");
        }
        buffer = buffer.slice(boundary + 2);
        if (!frame || frame.startsWith(":")) continue;
        if (terminalSeen) throw new CliError("terminal_invalid", "Event stream contains data after terminal");
        const lines = frame.split("\n");
        if (lines.length !== 3 || !lines[0].startsWith("id:") ||
            !lines[1].startsWith("event:") || !lines[2].startsWith("data:")) {
          throw new CliError("sse_invalid", "Event stream contains malformed framing");
        }
        const id = lines[0].slice(3).trim();
        const kind = lines[1].slice(6).trim();
        let value;
        try { value = JSON.parse(lines[2].slice(5).trimStart()); }
        catch { throw new CliError("event_invalid", "Event stream contains malformed JSON"); }
        if (id !== String(startSeq + events.length) || kind !== value.kind) {
          throw new CliError("sse_invalid", "SSE metadata disagrees with event data");
        }
        events.push(validateEvent(refuseSecretValue(value), runId, startSeq + events.length));
        guard?.(events.at(-1));
        await onEvent?.(events.at(-1));
        if (startSeq + events.length > MAX_EVENTS) throw new CliError("response_too_large", "Event count exceeds limit");
        terminalSeen = events.at(-1).kind === "terminal";
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        throw new CliError("sse_invalid", "SSE partial frame exceeds limit");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new CliError("sse_invalid", "Event stream ended with a partial frame");
    return events;
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the read/validation error from an errored stream. */ }
    finally { reader.releaseLock(); }
  }
}

export class VecteurClient {
  constructor(config = configuration(), fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, { body, rawBody, contentType, idempotencyKey, accept, acceptEncoding, signal,
    lastEventId, anonymousReadiness = false } = {}) {
    if (anonymousReadiness && (method !== "GET" || path !== "/api/ready" || body !== undefined || rawBody !== undefined)) {
      throw new CliError("request_invalid", "Anonymous compatibility inspection is restricted to readiness");
    }
    if (body !== undefined && rawBody !== undefined) throw new CliError("request_invalid", "Choose JSON or raw bytes");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const overallTimer = setTimeout(() => controller.abort(), this.config.timeout);
    // THE IDLE WINDOW CATCHES A DEAD CONNECTION, NOT A THINKING AGENT.
    //
    // Five seconds is right for a request/response call: nothing legitimate is silent that long.
    // It is wrong for the RUN EVENT STREAM, where silence between events is the agent working —
    // `run submit` waits for a whole turn, and every turn that thought for more than five
    // seconds died as `request_timeout: Public API request timed out`, which reads as a dead
    // endpoint. That is every engineering ask, on a released door, and no environment variable
    // could widen it because `VECTEUR_TIMEOUT_MS` was capped by this same `min`.
    //
    // A stream is still BOUNDED — by `overallTimer`, which no branch here changes. What goes is
    // the assumption that a quiet socket is a broken one, which only ever held for the calls
    // that answer immediately.
    const idleMs = accept === "text/event-stream"
      ? this.config.timeout
      : Math.min(this.config.timeout, 5_000);
    let idleTimer;
    const activity = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleMs);
    };
    activity();
    try {
      const response = await this.fetchImpl(`${this.config.origin}${path}`, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...(!anonymousReadiness ? { "X-Vecteur-Client": OWNER_CONTRACT_IDENTITY } : {}),
          ...(!anonymousReadiness && this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(rawBody === undefined ? {} : { "Content-Type": contentType ?? "application/octet-stream" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(accept ? { Accept: accept } : {}),
          ...(acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {}),
          ...(lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) }),
          // RunWire v3 (v5 §4.1): this reader reads every declared stored version; without the
          // header the origin treats a client as a v2 reader and refuses a child-enabled Run.
          ...(!anonymousReadiness ? { [WIRE_READER_HEADER]: String(WIRE_READER_VERSION) } : {}),
        },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const abortBody = () => response.body?.cancel().catch(() => {});
      controller.signal.addEventListener("abort", abortBody, { once: true });
      response[RESPONSE_ACTIVITY] = activity;
      response["vecteurAbortSignal"] = controller.signal;
      response[RELEASE_TIMEOUT] = () => {
        controller.signal.removeEventListener("abort", abortBody);
        signal?.removeEventListener("abort", cancel);
        clearTimeout(overallTimer); clearTimeout(idleTimer);
      };
      if (response.headers.get("X-Vecteur-Contract") === null) {
        throw new CliError(
          "origin_not_vecteur",
          `origin ${this.config.origin}; cause=missing_vecteur_contract; next: pass the Vecteur origin with --origin`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new CliError("redirect_refused", "Public API redirects are refused");
      }
      if (!response.ok) {
        let code = `http_${response.status}`;
        let ownerMessage = "";
        let refused = null;
        let admission = null;
        try {
          // THE GUARD RUNS ON REFUSALS TOO. It sat on the success path alone, so a 401 whose
          // body carried `vct_…` was read for its `error.code` and reported as `pat_revoked`:
          // the one exception to the guard is an HTTP 201 from the device poll, and an error
          // is not it. A credential in a refusal is still a credential the door leaked.
          const body = refuseSecretValue(parseOwnerJson(await boundedText(response)));
          const error = body.error;
          if (error && typeof error === "object" && !Array.isArray(error)) {
            const candidate = error.code;
            if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)) {
              code = candidate;
            }
            // Only the owner's explicit marker makes a refusal final for its submission key.
            if (error.admission === "refused") admission = "refused";
            if (candidate === "project_quota_exhausted") {
              if (!validateQuotaDenial(error.quota) || typeof error.message !== "string"
                  || !error.message.length || /[\r\n\0]/.test(error.message)) {
                throw new CliError("quota_invalid", "Server returned malformed Project quota data");
              }
              const actions = error.quota.recovery.map(id => {
                if (!Object.hasOwn(RECOVERY_ACTIONS, id) || !RECOVERY_ACTIONS[id].href) {
                  throw new CliError("recovery_action_invalid", `Unknown Project recovery action: ${id}`);
                }
                const action = RECOVERY_ACTIONS[id];
                return `${action.label}: ${new URL(action.href, this.config.origin).href}`;
              });
              const quota = error.quota;
              ownerMessage = `${error.message}; ${quota.current} of ${quota.maximum} active projects used on the ${quota.tier} plan`
                + (actions.length ? `; next: ${actions.join("; ")}` : "");
            }
            if (candidate === "customer_cost_exhausted") {
              if (!validateLimitDenial(error.limit)) {
                throw new CliError("customer_cost_invalid", "Server returned malformed customer-cost refusal");
              }
              const limit = error.limit;
              const binding = `${limit.binding_scope.kind}:${limit.binding_scope.scope.type}:${limit.binding_scope.scope.id}`;
              const reset = new Date(limit.reset_at * 1000).toISOString().replace(".000Z", "Z");
              ownerMessage = `Customer cost limit reached; binding=${binding}; reset=${reset} UTC; next=${limit.recovery.join(",")}`;
            }
            if (candidate === WIRE_VERSION_UNSUPPORTED) {
              ownerMessage = "this Run is stored in a RunWire version this CLI cannot read; next: vecteur update";
            }
            if (["pat_expired", "pat_invalid", "pat_revoked"].includes(candidate)) {
              ownerMessage = "credential is expired or revoked; next: vecteur login";
            }
            if (candidate === "pat_ancestry_inactive") {
              ownerMessage = "seat or Organization is inactive; next: contact your Organization owner or Vecteur support";
            }
            // A38: the run door names the Produce entry it keeps off, in product words; the CLI holds no copy of the table.
            if (candidate === "produce_unavailable" && typeof error.message === "string" && error.message.length > 0
                && error.message.length <= 512 && !/[\r\n\0]/.test(error.message)) {
              ownerMessage = error.message;
            }
            if (
              candidate === "client_outdated"
              && Object.keys(error).sort().join("\n") === "code\nmessage"
              && typeof error.message === "string"
              && error.message.length > 0
              && error.message.length <= 512
              && !/[\r\n\0]/.test(error.message)
            ) {
              try { ownerMessage = refuseSecretValue(error.message); } catch {}
            }
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          if (error instanceof CliError && [
            "secret_response_refused", "quota_invalid", "recovery_action_invalid", "customer_cost_invalid",
          ].includes(error.code)) refused = error;
        }
        if (refused) throw refused;
        const failure = new CliError(
          code,
          ownerMessage || `Public API refused request with HTTP ${response.status}`,
        );
        failure.status = response.status;
        if (admission) failure.admission = admission;
        throw failure;
      }
      return response;
    } catch (error) {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(overallTimer); clearTimeout(idleTimer);
      if (error?.name === "AbortError") {
        if (signal?.aborted) throw new CliError("request_cancelled", "Public API request was cancelled");
        throw new CliError("request_timeout",
          `origin ${this.config.origin}; cause=timeout; next: check the network and retry`);
      }
      if (error instanceof CliError) throw error;
      throw new CliError("request_failed",
        `origin ${this.config.origin}; cause=transport; next: check the network and --origin`);
    }
  }

  async projectList(signal = undefined) {
    const value = await this.#json("GET", "/api/projects", { signal });
    if (!Array.isArray(value) || !value.every(validateProject)) {
      throw new CliError("projects_invalid", "Server returned malformed Project list");
    }
    return value;
  }

  async readiness(signal = undefined) {
    const response = await this.request("GET", "/api/ready", { signal, anonymousReadiness: true });
    try {
      const body = refuseSecretValue(parseOwnerJson(await boundedText(response)));
      if (body.status !== "ready") throw new CliError("origin_not_ready", "Origin did not report readiness");
      const contract = response.headers.get("X-Vecteur-Contract");
      if (!/^api-sha256:[a-f0-9]{64};run-wire-sha256:[a-f0-9]{64}$/.test(contract)) throw new CliError("origin_not_vecteur", "Invalid origin contract");
      const cli = body.cli ?? null;
      if (cli && (!validateCliRelease(cli) || !/^\d+\.\d+\.\d+$/.test(cli.version)
          || cli.contract !== contract || (cli.integrity !== null && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(cli.integrity)))) {
        throw new CliError("release_invalid", "Origin returned invalid CLI release metadata");
      }
      const compatible = contract === OWNER_CONTRACT_IDENTITY;
      let requiredVersion = cli?.version ?? null;
      if (!compatible && !cli) {
        // Older releases expose their pin only in the bounded 426 recovery. Inspect it
        // through the same read-only route, with client identity but NEVER a credential.
        const publicClient = new VecteurClient({ ...this.config, token: undefined }, this.fetchImpl);
        try {
          const legacy = await publicClient.request("GET", "/api/ready", { signal });
          await legacy.body?.cancel(); legacy[RELEASE_TIMEOUT]?.();
        } catch (error) {
          if (error.code !== "client_outdated") throw error;
          requiredVersion = /This origin requires Vecteur CLI (\d+\.\d+\.\d+)\./.exec(error.message)?.[1] ?? null;
        }
      }
      return { contract, compatible, cli, requiredVersion };
    } finally { response[RELEASE_TIMEOUT]?.(); }
  }

  async projectCreate(name, workspaceId, signal = undefined, idempotencyKey = undefined) {
    const value = await this.#json("POST", "/api/projects", {
      body: { name, workspace_id: workspaceId }, signal, idempotencyKey,
    });
    if (!validateProject(value) || value.workspace_id !== workspaceId) {
      throw new CliError("project_invalid", "Server returned malformed project data");
    }
    return value;
  }

  async projectGet(projectId, signal = undefined) {
    const value = await this.#json("GET", `/api/projects/${encodeURIComponent(projectId)}`, { signal });
    if (!validateProject(value) || value.id !== projectId) {
      throw new CliError("project_invalid", "Server returned malformed project data");
    }
    return value;
  }

  async projectRename(projectId, name, signal = undefined) {
    const value = await this.#json("PATCH", `/api/projects/${encodeURIComponent(projectId)}`, { body: { name }, signal });
    if (!validateProject(value) || value.id !== projectId) throw new CliError("project_invalid", "Malformed renamed Project");
    return value;
  }

  /** Body and key are frozen by the caller before any admission I/O. */
  async runAdmit(projectId, body, idempotencyKey, signal = undefined) {
    const value = await this.#json("POST", `/api/projects/${encodeURIComponent(projectId)}/runs`, {
      body, idempotencyKey, signal,
    });
    if (!validateRunAck(value)) throw new CliError("run_ack_invalid", "Server returned malformed run acknowledgement");
    return value;
  }

  async runCancel(runId, signal = undefined) {
    const value = await this.#json("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`, { signal });
    if (!validateRunAck(value) || value.run_id !== runId) throw new CliError("run_ack_invalid", "Malformed cancellation acknowledgement");
    return value;
  }

  async runControl(runId, control, signal = undefined) {
    const value = await this.#json("POST", `/api/runs/${encodeURIComponent(runId)}/controls`, { body: control, signal });
    if (!validateRunControl(value) || value.id !== control.id) throw new CliError("control_invalid", "Malformed control acknowledgement");
    return value;
  }

  async localExec(runId, body, requestId = null) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2500);
    try { return await this.#json("POST", `/api/runs/${encodeURIComponent(runId)}/local-exec${requestId ? '/'+encodeURIComponent(requestId) : ''}`, { body, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async runControls(runId, signal = undefined) {
    const value = await this.#json("GET", `/api/runs/${encodeURIComponent(runId)}/controls`, { signal });
    if (!exactKeys(value, ["controls"]) || !Array.isArray(value.controls) || value.controls.length > 32
        || !value.controls.every(validateRunControl) || new Set(value.controls.map(c => c.id)).size !== value.controls.length
        || value.controls.some((c, i) => i > 0 && c.sequence <= value.controls[i - 1].sequence)) {
      throw new CliError("control_invalid", "Malformed controls projection");
    }
    return value.controls;
  }

  async clarificationAnswer(runId, questionId, answers, signal = undefined) {
    const value = await this.#json("POST", `/api/runs/${encodeURIComponent(runId)}/clarifications/${encodeURIComponent(questionId)}/answer`,
      { body: { answers }, signal });
    if (!validateRunAck(value) || value.run_id !== runId) throw new CliError("run_ack_invalid", "Malformed answer acknowledgement");
    return value;
  }

  async inputAdd(projectId, bytes, contentType, signal = undefined) {
    const value = await this.#json("POST", `/api/projects/${encodeURIComponent(projectId)}/inputs`, {
      rawBody: bytes, contentType, signal,
    });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!validateSource(value) || value.sha256 !== digest || value.cas_ref !== `sha256:${digest}`
        || value.size !== bytes.byteLength) throw new CliError("source_invalid", "Uploaded source identity differs from the selected bytes");
    if (value.offer) this.validateOffer(projectId, value, value.offer);
    return value;
  }

  async inputOffer(projectId, source, signal = undefined) {
    const query = new URLSearchParams({ cas_ref: source.cas_ref, acquisition_ref: source.acquisition_ref });
    const offer = await this.#json("GET", `/api/projects/${encodeURIComponent(projectId)}/inputs/extraction-offer?${query}`, { signal });
    return this.validateOffer(projectId, source, offer);
  }

  validateOffer(projectId, source, offer) {
    if (!validateSourceOffer(offer) || offer.project_id !== projectId
        || offer.source_handle.cas_ref !== source.cas_ref || offer.source_handle.acquisition_ref !== source.acquisition_ref) {
      throw new CliError("source_offer_invalid", "Extraction offer differs from the selected source");
    }
    return offer;
  }

  async deviceMint(signal = undefined) {
    const value = await this.#json("POST", "/api/auth/device", { body: {}, signal });
    if (!validateDeviceAuthorization(value)) {
      throw new CliError("device_authorization_invalid", "Server returned malformed owner data");
    }
    return value;
  }

  async devicePoll(deviceCode, signal = undefined) {
    return this.#json("POST", "/api/auth/device/poll", { body: { device_code: deviceCode }, signal });
  }

  async accountMe(signal = undefined) {
    const value = await this.#json("GET", "/api/auth/me", { signal });
    if (!validateAccount(value)) throw new CliError("account_invalid", "Server returned malformed owner data");
    return value;
  }

  async credentialSelfRevoke(signal = undefined) {
    return this.#json("DELETE", "/api/credentials/self", { signal });
  }

  async customerCost(projectId, signal = undefined) {
    const query = new URLSearchParams({ scope: "project", scope_id: projectId, period: "utc_month" });
    const value = await this.#json("GET", `/api/customer-cost?${query}`, { signal });
    if (!validateCustomerCostProjection(value) || value.scope.type !== "project"
        || value.scope.id !== projectId) {
      throw new CliError("customer_cost_invalid", "Server returned malformed customer-cost projection");
    }
    return value;
  }

  async artifactGet(casRef, projectId, onChunk, signal = undefined) {
    const identity = CAS_REF_SHAPE.exec(casRef);
    if (!identity || typeof projectId !== "string" || !projectId
        || typeof onChunk !== "function") {
      throw new CliError("artifact_invalid", "artifact get requires an admitted sha256 CAS id and Project");
    }
    const query = new URLSearchParams({ project_id: projectId });
    const response = await this.request(
      "GET", `/api/artifacts/${encodeURIComponent(casRef)}?${query}`, {
        acceptEncoding: "identity", signal,
      },
    );
    try {
      const contentType = response.headers.get("content-type");
      if (!Object.values(ARTIFACT_MEDIA_TYPES).includes(contentType)) {
        throw new CliError("artifact_invalid", "Server returned an undeclared artifact media type");
      }
      const contentEncoding = response.headers.get("content-encoding");
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        throw new CliError("artifact_invalid", "Server returned encoded artifact bytes");
      }
      const declared = response.headers.get("content-length");
      if (declared === null || !/^(?:0|[1-9][0-9]*)$/.test(declared)
          || !Number.isSafeInteger(Number(declared))) {
        throw new CliError("artifact_invalid", "Server returned an invalid artifact length");
      }
      if (!response.body) throw new CliError("artifact_invalid", "Server returned no artifact bytes");
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        response[RESPONSE_ACTIVITY]?.();
        bytes += chunk.byteLength;
        if (bytes > Number(declared)) {
          throw new CliError("artifact_invalid", "Artifact bytes exceed the declared length");
        }
        digest.update(chunk);
        await onChunk(chunk);
      }
      if (bytes !== Number(declared)) {
        throw new CliError("artifact_invalid", "Artifact bytes differ from the declared length");
      }
      if (digest.digest("hex") !== identity[1]) {
        throw new CliError("artifact_invalid", "Artifact bytes differ from the admitted digest");
      }
      return { cas_ref: casRef, project_id: projectId, content_type: contentType, bytes };
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("request_failed",
        `origin ${this.config.origin}; cause=artifact_transport; next: check the network and retry`);
    } finally {
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
      response[RELEASE_TIMEOUT]?.();
    }
  }

  async projectionGet(projectId, runId, projection, onChunk, signal = undefined) {
    const ref = projection?.payload_ref;
    if (typeof projectId !== "string" || !projectId || typeof runId !== "string" || !runId
        || projection?.kind !== "transfer_table" || projection?.run_id !== runId
        || projection?.project_id !== projectId
        || !/^projection-[0-9a-f]{64}$/.test(projection?.projection_id ?? "")
        || ref?.schema !== "vecteur.owner-transfer-table.v1"
        || ref?.media_type !== "application/vnd.vecteur.owner-transfer-table+json"
        || !/^[0-9a-f]{64}$/.test(ref?.payload_sha256 ?? "")
        || typeof onChunk !== "function") {
      throw new CliError("projection_invalid", "projection get requires a sealed transfer table on this Run");
    }
    const route = `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`
      + `/projections/${encodeURIComponent(projection.projection_id)}/payload`;
    const response = await this.request("GET", route, {
      accept: ref.media_type, acceptEncoding: "identity", signal,
    });
    try {
      if (response.headers.get("content-type")?.split(";", 1)[0] !== ref.media_type
          || (response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
        throw new CliError("projection_invalid", "Server returned the wrong projection media type");
      }
      const disposition = response.headers.get("x-vecteur-projection-disposition");
      if (disposition !== "current" && disposition !== "historical") {
        throw new CliError("projection_invalid", "Server returned no valid projection disposition");
      }
      const declared = response.headers.get("content-length");
      if (declared === null || !/^(?:0|[1-9][0-9]*)$/.test(declared)
          || Number(declared) > 256 * 1024 || !response.body) {
        throw new CliError("projection_invalid", "Projection byte length is invalid");
      }
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        response[RESPONSE_ACTIVITY]?.();
        bytes += chunk.byteLength;
        if (bytes > Number(declared)) throw new CliError("projection_invalid", "Projection exceeds its declared size");
        digest.update(chunk);
        await onChunk(chunk);
      }
      if (bytes !== Number(declared) || digest.digest("hex") !== ref.payload_sha256) {
        throw new CliError("projection_invalid", "Projection bytes differ from RunWire");
      }
      return { projection_id: projection.projection_id, project_id: projectId,
        run_id: runId, content_type: ref.media_type, bytes, disposition };
    } finally {
      response[RELEASE_TIMEOUT]?.();
    }
  }

  /**
   * The Project's newest Run from the owner page — the record the web chains on
   * (`CanvasPage.vue` designHead). Its public `state_hash` is the design head once the Run is
   * terminal. An empty page with a cursor is a newest Run this login may not see, not an empty
   * Project, so it refuses rather than let the caller guess null.
   */
  async projectNewestRun(projectId, signal = undefined) {
    const page = await this.projectHistory(projectId, { limit: 1, signal });
    const newest = page?.runs?.[0];
    if (!newest && page.next_before !== null) {
      throw new CliError("project_head_hidden",
        `the newest Run in Project ${projectId} is not visible to this login; nothing was submitted; `
        + "next: continue in the web app, or pass --parent <state-hash>");
    }
    // Client-local presentation overlay, as in the web transcript. Never write this
    // timestamp into the immutable RunWire response or send it back to the server.
    return newest ? { ...newest.response, accepted_at: newest.accepted_at, ask: newest.request.ask } : null;
  }

  async projectHistory(projectId, { limit = 25, before, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new CliError("limit_invalid", "History page must contain 1–25 Runs");
    const query = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
    const page = await this.#json("GET", `/api/projects/${encodeURIComponent(projectId)}/runs?${query}`, { signal });
    if (!exactKeys(page, ["runs", "next_before"]) || !Array.isArray(page.runs) || page.runs.length > limit
        || (page.next_before !== null && typeof page.next_before !== "string")
        || page.runs.some(row => row?.request?.project_id !== projectId || typeof row.request.ask !== "string"
          || !validateAdmitted(row.response) || !isStateHash(row.response.state_hash))) {
      throw new CliError("project_runs_invalid", "Server returned malformed Project run history");
    }
    for (const row of page.runs) row.response.events.forEach((event, seq) => validateEvent(event, row.response.run_id, seq));
    return page;
  }

  /** One bounded admission. Callers own the key; neither timeout nor conflict generates another. */
  async runStart(projectId, ask, { requestKey, parentStateHash, attachments, selections, signal, intent, executor } = {}) {
    let parent = parentStateHash;
    try {
      if (!isRequestKey(requestKey)) throw new CliError("request_key_invalid", "request_key must be 8–64 letters, digits, _ or -");
      if (parent !== undefined && parent !== null && !isStateHash(parent)) throw new CliError("parent_invalid", "Expected a state hash or null");
      if (parent === undefined) parent = (await this.projectNewestRun(projectId, signal))?.state_hash ?? null;
      let material = submissionMaterial(selections);
      if (attachments !== undefined) {
        if (!Array.isArray(attachments) || !attachments.every(handle => exactKeys(handle, ["cas_ref", "acquisition_ref"])
            && /^sha256:[0-9a-f]{64}$/.test(handle.cas_ref) && typeof handle.acquisition_ref === "string" && handle.acquisition_ref.length)) {
          throw new CliError("selection_invalid", "Attachments must be source handles");
        }
        if (selections !== undefined && canonicalJson(attachments) !== canonicalJson(material.attachments)) {
          throw new CliError("selection_invalid", "Attachments must match the exact-extract selections");
        }
        material = { ...material, attachments };
      }
      const body = { ask, ...material, parent_state_hash: parent, ui_context: null,
        ...(intent === undefined ? {} : { intent }), ...(executor ? { local_exec: executor.descriptor } : {}) };
      return await withAdmissionLock(() => this.#startAdmission(projectId, body, requestKey, signal), this.localEnv ?? process.env);
    } catch (error) { throw this.#startFailure(error, requestKey, parent); }
  }

  #startFailure(error, key, parent) {
    if (!(error instanceof CliError)) throw error;
    if (["idempotency_conflict", "submission_mismatch"].includes(error.code)) {
      error = new CliError("admission_unresolved",
        "This request key could not be reconciled; inspect the Project history before submitting another request");
    }
    error.request_key = key;
    error.parent_state_hash = parent;
    return error;
  }

  async #startAdmission(projectId, body, key, signal) {
    const env = this.localEnv ?? process.env;
    const id = body.local_exec ? null : admissionIntent(this.config.origin, projectId, key, body, env);
    try {
      const ack = await this.runAdmit(projectId, body, key, signal);
      if (!validateRunAck(ack)) throw new CliError("run_ack_invalid", "Server returned malformed run acknowledgement");
      if (id) admissionResolved(id, env);
      return { ...ack, parent_state_hash: body.parent_state_hash };
    } catch (error) {
      if (id && (error.admission === "refused" || ["state_fork", "state_busy"].includes(error.code))) admissionResolved(id, env);
      if (error instanceof CliError && ["state_fork", "state_busy"].includes(error.code)) {
        throw await this.#admissionRefused(error.code, projectId, body.parent_state_hash, signal);
      }
      throw error;
    }
  }

  /** CLI-only request freezing. The immutable file owns retries; no file read/selection occurs on reuse. */
  async runStartLocal(projectId, ask, { requestKey, parentStateHash, paths = [], cwd = process.cwd(), signal } = {}) {
    const env = this.localEnv ?? process.env;
    let parent = parentStateHash;
    try {
      if (!isRequestKey(requestKey)) throw new CliError("request_key_invalid", "request_key must be 8–64 letters, digits, _ or -");
      if (parent !== undefined && parent !== null && !isStateHash(parent)) throw new CliError("parent_invalid", "Expected a state hash or null");
      const intent = { origin: this.config.origin, project_id: projectId, ask,
        parent_state_hash: parent ?? null, paths: [...new Set(paths.map(path => resolve(cwd, path)))].sort() };
      const file = join(dirname(credentialsPath(env)), `request-${createHash("sha256").update(requestKey).digest("hex")}.json`);
      return await withAdmissionLock(async () => {
        // Convenience deliberately does not recover a body from disk or guess a Run from history.
        const saved = readStore(file);
        if (saved) {
          if (parent === undefined || canonicalJson(saved.intent) !== canonicalJson(intent)) {
            throw new CliError("request_key_reused", "This request key already names a different ask, parent, Project or attachment set");
          }
          if (saved.version !== 1 || saved.request_key !== requestKey || saved.body?.ask !== ask
              || saved.body?.local_exec !== undefined
              || saved.body?.parent_state_hash !== parent || saved.body?.ui_context !== null
              || canonicalJson(submissionMaterial(saved.body?.selections)) !== canonicalJson({
                attachments: saved.body?.attachments, ...(saved.body?.selections ? { selections: saved.body.selections } : {}) })) {
            throw new CliError("request_file_invalid", "The frozen request is malformed; reconcile through Project history");
          }
          return this.#startAdmission(projectId, saved.body, requestKey, signal);
        }
        if (parent === undefined) parent = (await this.projectNewestRun(projectId, signal))?.state_hash ?? null;
        if (unresolvedAdmissions(this.config.origin, projectId, env).some(row => row.key === requestKey)) {
          throw new CliError("admission_unresolved", "No frozen request file is available; reconcile this key through Project history");
        }
        const selections = paths.length ? await selectInvocationFiles(this, projectId, paths, { cwd, env, signal }) : undefined;
        const body = { ask, ...submissionMaterial(selections), parent_state_hash: parent, ui_context: null };
        if (parentStateHash !== undefined) {
          // writeStore fsyncs complete 0600 bytes; link publishes without replacing an existing key.
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            writeStore(temporary, { version: 1, request_key: requestKey, intent, body });
            try { linkSync(temporary, file); }
            catch (error) {
              if (error.code === "EEXIST") throw new CliError("request_key_reused", "A request file already exists for this key; its bytes were preserved");
              throw error;
            }
            const fd = openSync(dirname(file), "r");
            try { fsyncSync(fd); } finally { closeSync(fd); }
          } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
        }
        return this.#startAdmission(projectId, body, requestKey, signal);
      }, env);
    } catch (error) { throw this.#startFailure(error, requestKey, parent); }
  }

  /** The legacy blocking door retains its success record and error prose. */
  async runSubmit(projectId, ask, onEvent = null, signal = undefined, parentStateHash = undefined,
    selections = undefined, intent = undefined, executor = undefined) {
    const value = await this.runStart(projectId, ask, { requestKey: randomUUID(), parentStateHash, selections, signal, intent, executor });
    try {
      const pump = executor?.pump(value.run_id).catch(() => executor.stop());
      try { return await this.runEvents(value.run_id, onEvent, signal); }
      finally { executor?.stop(); await pump; }
    } catch (error) {
      throw admittedFailure(error, value.run_id);
    }
  }

  async runStatus(runId, signal = undefined) {
    const record = await this.runGet(runId, signal);
    const latest = record.events.filter(event => event.kind === "clarification").at(-1)?.payload;
    return { run_id: record.run_id, terminal: record.terminal, last_seq: record.events.at(-1)?.seq ?? -1,
      clarification: latest?.state === "requested" ? latest : null };
  }

  async #admissionRefused(code, projectId, sent, signal) {
    let newest;
    try { newest = await this.projectNewestRun(projectId, signal); } catch { newest = undefined; }
    if (code === "state_busy" && newest?.terminal === "") {
      const run = newest.run_id;
      const question = newest.events.filter((event) => event.kind === "clarification").at(-1);
      const waiting = question?.payload?.state === "requested"
        ? ` [waiting for an answer: ${this.config.origin}/dashboard/${encodeURIComponent(projectId)}?run=${encodeURIComponent(run)}]`
        : "";
      return new CliError(code, `Run ${run} is still open in Project ${projectId}${waiting}; `
        + `nothing was admitted; next: vecteur run get ${run}`);
    }
    if (code === "state_fork" && newest !== undefined) {
      const moved = newest?.state_hash ?? null;
      return new CliError(code, `Project ${projectId} head is ${moved}, this submit sent ${sent}; `
        + "nothing was admitted; next: " + (moved === null ? "submit again without --parent"
          : `submit again to continue ${moved}, or pass --parent ${moved}`));
    }
    return new CliError(code, `nothing was admitted to Project ${projectId}; next: submit again`);
  }

  /** What this reader may do about a stopped Run. The server decides; a failed read names no plan and never fails the Run. */
  async stopOffer(runId, signal = undefined) {
    try {
      const value = await this.#json("GET", `/api/runs/${encodeURIComponent(runId)}/stop-offer`, { signal });
      return validateRunStopOffer(value) && value.run_id === runId ? value : null;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return null;
    }
  }

  /** The authenticated measurement door. Measurement never fails the reader's run. */
  async stopEvent(runId, body, signal = undefined) {
    try { await this.#json("POST", `/api/runs/${encodeURIComponent(runId)}/stop-offer/events`, { signal, body }); } catch (error) { if (error?.name === "AbortError") throw error; }
  }

  async runGet(runId, signal = undefined) {
    const value = await this.#json("GET", `/api/runs/${encodeURIComponent(runId)}`, { signal });
    if (!validateAdmitted(value) || value.run_id !== runId) {
      throw new CliError("run_invalid", "Server returned malformed run record");
    }
    value.events.forEach((event, seq) => validateEvent(event, runId, seq));
    validateChildRows(value.events, value.stored_wire_version);
    return value;
  }

  async runEvents(runId, onEvent = null, signal = undefined, priorEvents = []) {
    priorEvents.forEach((event, seq) => validateEvent(event, runId, seq));
    if (priorEvents.length > MAX_EVENTS) throw new CliError("response_too_large", "Event count exceeds limit");
    if (priorEvents.at(-1)?.kind === "terminal") {
      const direct = await this.runGet(runId, signal);
      if (JSON.stringify(priorEvents) !== JSON.stringify(direct.events)) {
        throw new CliError("record_mismatch", "Event stream disagrees with direct replay");
      }
      return direct;
    }
    const response = await this.request("GET", `/api/runs/${encodeURIComponent(runId)}/events`, {
      accept: "text/event-stream",
      signal,
      lastEventId: priorEvents.length ? priorEvents.length - 1 : undefined,
    });
    let events;
    let streamedVersion;
    try {
      const type = response.headers.get("content-type")?.split(";", 1)[0];
      if (type !== "text/event-stream") {
        throw new CliError("sse_invalid", "Event route is not an SSE stream");
      }
      streamedVersion = Number(response.headers.get(STORED_WIRE_VERSION_HEADER));
      if (!STORED_WIRE_VERSIONS.includes(streamedVersion)) {
        throw new CliError("sse_invalid", "Event stream declares no known stored RunWire version");
      }
      const guard = rowGuard(streamedVersion);
      priorEvents.forEach(guard);
      events = [...priorEvents, ...await parseSse(response, runId, onEvent, priorEvents.length, guard)];
    } catch (error) {
      if (error?.name === "AbortError") {
        if (signal?.aborted) throw new CliError("request_cancelled", "Following the Run was detached");
        throw new CliError("request_timeout",
          `origin ${this.config.origin}; cause=timeout; next: check the network and retry`);
      }
      if (error instanceof TypeError) throw new CliError("request_failed", "Event connection lost; reconnect to the same Run");
      throw error;
    } finally {
      response[RELEASE_TIMEOUT]?.();
    }
    if (events.length === 0 || events.at(-1).kind !== "terminal") {
      throw new CliError("terminal_invalid", "Event stream has no final terminal event");
    }
    const direct = await this.runGet(runId, signal);
    if (JSON.stringify(events) !== JSON.stringify(direct.events)
        || streamedVersion !== direct.stored_wire_version) {
      throw new CliError("record_mismatch", "Event stream disagrees with direct replay");
    }
    const eventTerminal = events.at(-1).payload.state ?? events.at(-1).payload.terminal;
    if (eventTerminal !== direct.terminal) {
      throw new CliError("terminal_mismatch", "Terminal event disagrees with direct record");
    }
    return direct;
  }

  async #json(method, path, options) {
    const response = await this.request(method, path, options);
    try {
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
        throw new CliError("response_invalid", "Public API response is not JSON");
      }
      try {
        const value = parseOwnerJson(await boundedText(response));
        // Sole exception to refuseSecretValue: HTTP 201 from POST /api/auth/device/poll,
        // accepted only after exact validation of the owner PatCreated shape. Pending
        // polls, every other status and every other route keep the guard.
        if (method === "POST" && path === "/api/auth/device/poll" && response.status === 201) {
          if (!validatePatCreated(value)) {
            throw new CliError("pat_created_invalid", "Server returned malformed owner data");
          }
          return value;
        }
        return refuseSecretValue(value);
      }
      catch (error) {
        if (error?.name === "AbortError") {
          throw new CliError("request_timeout", "Public API request timed out");
        }
        if (error instanceof CliError) throw error;
        throw new CliError("response_invalid", "Public API returned malformed JSON");
      }
    } finally {
      response[RELEASE_TIMEOUT]?.();
    }
  }
}

async function boundedText(response) {
  if (!response.body) throw new CliError("response_invalid", "Public API response has no body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    response[RESPONSE_ACTIVITY]?.();
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new CliError("response_too_large", "Public API response exceeds limit");
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new CliError("response_invalid", "Public API response is not UTF-8");
  }
}

function parseOwnerJson(text) {
  let inString = false;
  let escaped = false;
  let outside = "";
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      outside += " ";
    } else if (character === '"') {
      inString = true; outside += " ";
    } else outside += character;
  }
  for (const match of outside.matchAll(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      throw new CliError("response_invalid", "Public API response contains an unsafe number");
    }
  }
  return JSON.parse(text);
}
