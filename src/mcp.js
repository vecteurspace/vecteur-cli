import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { CliError, VecteurClient, redact } from "./client.js";
import { EVENT_KINDS, RETIRED_EVENT_KINDS, STORED_WIRE_VERSIONS, TERMINAL_STATES } from "./contract.js";
import { canonicalJson } from "./format.js";
import { artifactToFolder, materialAttach } from "./exchange.js";
import { credentialsPath } from "./credentials.js";
import { readStore, withStoreLock, writeStore } from "./store.js";

const projectInput = z.object({ project_id: z.string().min(1) }).strict();
// The composer's selection shape: one exact-extract selection per material source (the
// `selections` that vecteur_material_attach returns).
const selectionInput = z.object({
  source_handle: z.object({ cas_ref: z.string().regex(/^sha256:[0-9a-f]{64}$/), acquisition_ref: z.string().min(1) }).strict(),
  offer_id: z.string().min(1),
  selected_extract_ids: z.array(z.string().min(1)).min(1),
  method: z.literal("exact-extract"),
}).strict();
// v5 §2.5 explicit Produce: one named specialist child, started by the host before Engineering's turn. A38: Code Produce
// is off at the run door, so this tool does not offer it; the door's `produce_unavailable` words still name any entry kept off.
const produceInput = z.object({
  specialist: z.enum(["business", "knowledge"]).describe("Business, or Knowledge documents (profile nasa or esa; a document needs a completed analysis in this Project first)"),
  mode: z.string().min(1).max(64),
  target: z.string().min(1).max(256).optional(),
  profile: z.string().min(1).max(256).optional(),
  standard: z.string().min(1).max(256).optional(),
}).strict();
const submitInput = z.object({
  project_id: z.string().min(1),
  ask: z.string().min(1),
  selections: z.array(selectionInput).min(1).optional(),
  discard_pending_material: z.boolean().optional(),
  produce: produceInput.optional(),
}).strict();
const runInput = z.object({ run_id: z.string().min(1) }).strict();
const startInput = z.object({
  project_id: z.string().min(1), ask: z.string().min(1),
  selections: z.array(selectionInput).min(1).optional(),
  discard_pending_material: z.boolean().optional(),
  request_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  parent_state_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
}).strict();
const ackFields = {
  run_id: z.string().min(1), state_hash: z.string().min(1),
  accepted_at: z.number().int().safe(), requested_route_id: z.string().min(1),
};
const ackOutput = z.object(ackFields).strict();
const startOutput = z.object({ ...ackFields, parent_state_hash: z.string().nullable() }).strict();
const answerInput = z.object({
  run_id: z.string().min(1), clarification_id: z.string().min(1),
  answers: z.array(z.object({ id: z.string().min(1), selected: z.array(z.string()),
    custom: z.string().nullable().optional() }).strict()).min(1),
}).strict();
const statusOutput = z.object({
  run_id: z.string().min(1), terminal: z.union([z.enum([...TERMINAL_STATES]), z.literal("")]),
  last_seq: z.number().int().safe().min(-1), clarification: z.record(z.string(), z.json()).nullable(),
}).strict();
const eventKind = z.enum([...EVENT_KINDS, ...RETIRED_EVENT_KINDS]);
const eventOutput = z.object({
  run_id: z.string().min(1), seq: z.number().int().safe().nonnegative(),
  kind: eventKind,
  payload: z.record(z.string(), z.json()),
}).strict();
const memberOutput = z.object({
  user_id: z.string().min(1), email: z.string().min(1), display_name: z.string().min(1),
  role: z.enum(["OWNER", "EDITOR", "VIEWER"]),
}).strict();
const projectOutput = z.object({
  id: z.string().min(1), name: z.string().min(1), org_id: z.string().min(1),
  workspace_id: z.string().min(1), role: z.enum(["OWNER", "EDITOR", "VIEWER"]),
  members: z.array(memberOutput),
  created_at: z.number().int().safe(), updated_at: z.number().int().safe(),
}).strict();
const billableDimensionsOutput = z.object({
  uncached_input: z.number().int().safe().nonnegative(),
  cache_read: z.number().int().safe().nonnegative(),
  cache_write: z.number().int().safe().nonnegative(),
  output: z.number().int().safe().nonnegative(),
  cache_write_class: z.string().min(1).nullable().optional(),
  cache_write_duration_s: z.number().int().safe().nonnegative().nullable().optional(),
  provider_tier: z.string().min(1).nullable().optional(),
  long_context_band: z.string().min(1).nullable().optional(),
}).strict();
const runControlEgressOutput = z.object({
  candidate: z.number().int().safe().nonnegative(),
  call: z.number().int().safe().nonnegative(),
}).strict();
const runControlOutput = z.object({
  id: z.string().min(1),
  kind: z.enum(["steer", "answer_now"]),
  sequence: z.number().int().safe().positive(),
  state: z.enum(["queued", "claimed", "dispatched", "not_dispatched"]),
  attempt: z.number().int().safe().nonnegative().nullable(),
  step: z.number().int().safe().nonnegative().nullable(),
  egress: runControlEgressOutput.nullable(),
  text: z.string().nullable().optional(),
}).strict();
const admittedOutput = z.object({
  run_id: z.string().min(1), state_hash: z.string().min(1), result_hash: z.string(),
  requested_route_id: z.string().min(1), profile: z.string().min(1),
  stored_wire_version: z.union(STORED_WIRE_VERSIONS.map(version => z.literal(version))),
  terminal: z.union([z.enum([...TERMINAL_STATES]), z.literal("")]),
  duration_seconds: z.number().int().safe().nonnegative().nullable().optional(),
  usage: z.object({
    coverage: z.enum(["complete", "incomplete"]), provider_id: z.string().min(1),
    model_id: z.string().min(1), observed_at: z.number().int().safe().nonnegative(),
    billable_dimensions: z.array(billableDimensionsOutput).min(1),
  }).strict(),
  events: z.array(eventOutput),
  controls: z.array(runControlOutput),
}).strict().refine(value => value.terminal === ""
  ? value.result_hash === "" && value.events.at(-1)?.kind !== "terminal"
  : value.result_hash.length > 0, "Run terminal and result hash are not paired");

const artifactInput = z.object({
  project_id: z.string().min(1),
  cas_ref: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  run_id: z.string().min(1).optional(),
  artifact_id: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
}).strict();
const artifactOutput = z.object({
  path: z.string().min(1), bytes: z.number().int().safe().nonnegative(),
  cas_ref: z.string().regex(/^sha256:[0-9a-f]{64}$/), content_type: z.string().min(1), verified: z.literal(true),
}).strict();
const materialInput = z.object({
  project_id: z.string().min(1), path: z.string().min(1),
  confirm_origin: z.string().min(1),
  expected_state_hash: z.string().min(1).nullable(),
}).strict();
const materialOutput = z.object({
  project_id: z.string().min(1), project_name: z.string().min(1), destination: z.string().min(1),
  filename: z.string().min(1), bytes: z.number().int().safe().positive(),
  cas_ref: z.string().min(1), acquisition_ref: z.string().min(1), offer_id: z.string().min(1),
  extract_count: z.number().int().safe().nonnegative(),
  selections: z.array(selectionInput).min(1),
}).strict();

function success(value) {
  return {
    content: [{ type: "text", text: canonicalJson(value) }],
    structuredContent: value,
  };
}

function failure(error, lifecycle = false) {
  const code = error instanceof CliError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code : "internal_error";
  // A38: the run door's product words naming the Produce entry it keeps off (validated by the client) ride along.
  const message = code === "produce_unavailable" ? { message: error.message } : {};
  const details = Object.fromEntries((lifecycle ? ["run_id", "request_key", "parent_state_hash", "pending"] : ["run_id", "pending"])
    .filter(field => error instanceof CliError && Object.hasOwn(error, field))
    .map(field => [field, typeof error[field] === "string" ? redact(error[field]) : error[field]]));
  return {
    isError: true,
    content: [{ type: "text", text: canonicalJson({ error: { code, ...message, ...details } }) }],
  };
}

function tool(server, name, description, inputSchema, outputSchema, call, lifecycle = false) {
  server.registerTool(name, { description, inputSchema, outputSchema }, async (input, context) => {
    try {
      return success(await call(input, context));
    } catch (error) {
      return failure(error, lifecycle);
    }
  });
}

export function createVecteurMcpServer(client = new VecteurClient(), shutdownSignal = undefined) {
  const server = new McpServer({ name: "vecteur", version: "0.1.0" });
  // Upload is not admission. Pending material lives in the private local store beside the login,
  // so a restarted server still refuses a submit/start that omits it. It is kept until a submit/start
  // succeeds, including after refusals, unless the caller deliberately discards this Project's material.
  const origin = client.config.origin, file = join(dirname(credentialsPath()), "mcp-pending.json");
  const pendingStore = () => {
    const value = readStore(file) ?? { version: 1, pending: {} };
    if (value.version !== 1 || !value.pending || typeof value.pending !== "object") throw new CliError("store_unreadable", `${file} is not a pending-material store; bytes preserved`);
    return value;
  };
  const updatePending = change => withStoreLock(file, () => { const value = pendingStore(); change(value.pending); writeStore(file, value); });
  // One entry per Project and bytes: re-attaching the same file replaces its handle (the recovery after a restart).
  const materialKey = (projectId, casRef) => canonicalJson([origin, projectId, casRef]);
  const withMaterial = async (projectId, selections, discardPendingMaterial, call) => {
    const pending = Object.entries(pendingStore().pending).filter(([, value]) => value.origin === origin && value.projectId === projectId);
    const selected = new Set((selections ?? []).map(value => canonicalJson([value.source_handle.cas_ref, value.source_handle.acquisition_ref])));
    if (discardPendingMaterial) {
      if (pending.length) updatePending(store => { for (const [key] of pending) delete store[key]; });
    } else if (pending.some(([, value]) => !selected.has(canonicalJson([value.cas_ref, value.acquisition_ref])))) {
      // Name what is pending: a session that lost the selections re-attaches that file rather than discarding blind.
      throw Object.assign(new CliError("selection_required", "Pass the attached material's returned selections to submit or start"),
        { pending: pending.map(([, value]) => value.cas_ref) });
    }
    const result = await call();
    // The Run is admitted: a store failure now must not read as a refusal (a retry would admit a second Run).
    // A leftover entry fails closed on the next call, where the caller can re-attach or discard.
    if (!discardPendingMaterial && pending.length) try { updatePending(store => {
      for (const [key, value] of pending) if (store[key]?.nonce === value.nonce) delete store[key];
    }); } catch { /* fail closed: the entry stays pending */ }
    return result;
  };
  const signal = (context) => shutdownSignal
    ? AbortSignal.any([context.mcpReq.signal, shutdownSignal]) : context.mcpReq.signal;

  tool(server, "vecteur_project_get", "Get one PAT-bound Vecteur project.", projectInput, projectOutput,
    ({ project_id: projectId }, context) => client.projectGet(projectId, signal(context)));

  tool(server, "vecteur_run_submit",
    "Submit an ask and return its terminal record. Pass vecteur_material_attach's returned selections verbatim; omitting this Project's pending material refuses, also after a server restart (attach again for its selections). Set discard_pending_material=true to forget this Project's pending material and use only the supplied selections (or none). For long Runs use vecteur_run_start and poll vecteur_run_status.",
    submitInput, admittedOutput, async ({ project_id: projectId, ask, selections, discard_pending_material, produce }, context) => {
      const progressToken = context.mcpReq._meta?.progressToken;
      const onEvent = progressToken === undefined ? null : (event) => context.mcpReq.notify({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: event.seq + 1,
            message: event.kind,
          },
        });
      return withMaterial(projectId, selections, discard_pending_material, () => client.runSubmit(projectId, ask, onEvent, signal(context), undefined, selections,
        produce === undefined ? undefined : { kind: "produce", ...produce }));
    });

  tool(server, "vecteur_run_get", "Get one Vecteur run record, including an open run.", runInput, admittedOutput,
    ({ run_id: runId }, context) => client.runGet(runId, signal(context)));

  tool(server, "vecteur_run_events", "Validate run events against its direct record.", runInput,
    admittedOutput, ({ run_id: runId }, context) => client.runEvents(runId, null, signal(context)));

  tool(server, "vecteur_run_start", "Admit without waiting. Pass attached material's returned selections verbatim; omitting this Project's pending material refuses, also after a server restart (attach again for its selections). Set discard_pending_material=true to forget this Project's pending material and use only the supplied selections (or none). Freeze request_key, ask and parent_state_hash (null for no head) for retries. Detaching never cancels.",
    startInput, startOutput, ({ project_id, ask, request_key, parent_state_hash, selections, discard_pending_material }, context) =>
      withMaterial(project_id, selections, discard_pending_material, () => client.runStart(project_id, ask, {
        requestKey: request_key, parentStateHash: parent_state_hash, selections, signal: signal(context),
      })), true);
  tool(server, "vecteur_run_status", "Poll one bounded Run record; preserve its terminal and latest requested clarification verbatim.",
    runInput, statusOutput, ({ run_id }, context) => client.runStatus(run_id, signal(context)), true);
  tool(server, "vecteur_clarification_answer", "Answer the requested clarification with wire answers, including multi-select and custom text. Stale or duplicate answers refuse.",
    answerInput, ackOutput, ({ run_id, clarification_id, answers }, context) =>
      client.clarificationAnswer(run_id, clarification_id, answers, signal(context)), true);

  const cwd = process.cwd();
  tool(server, "vecteur_artifact_get",
    "Download one run artifact into the server's working folder (never outside it), verified against its sha256 CAS id. Give cas_ref, or run_id with artifact_id. Never overwrites.",
    artifactInput, artifactOutput, ({ project_id: projectId, cas_ref: casRef, run_id: runId, artifact_id: artifactId, output }, context) =>
      artifactToFolder(client, { projectId, casRef, runId, artifactId, output, cwd, signal: signal(context) }));

  tool(server, "vecteur_material_attach",
    `Upload one local file to ${client.config.origin}. Pass the returned selections verbatim to vecteur_run_submit or vecteur_run_start for this Project; upload alone is not Run admission. Requires confirm_origin equal to that origin and expected_state_hash equal to the current head (null if none).`,
    materialInput, materialOutput, async ({ project_id: projectId, path, confirm_origin: confirmOrigin, expected_state_hash: expectedStateHash }, context) => {
      const result = await materialAttach(client, { projectId, path, confirmOrigin, expectedStateHash, cwd, signal: signal(context) });
      updatePending(store => { for (const { source_handle: handle } of result.selections) store[materialKey(projectId, handle.cas_ref)] = {
        origin, projectId, cas_ref: handle.cas_ref, acquisition_ref: handle.acquisition_ref, nonce: randomUUID() }; });
      return result;
    });

  return server;
}

export function serveVecteurMcp() {
  const shutdown = new AbortController();
  const handle = serveStdio(() => createVecteurMcpServer(undefined, shutdown.signal), {
    onerror(error) {
      process.stderr.write(`mcp_transport_error: ${redact(error?.message ?? "MCP transport failed")}\n`);
    },
  });

  let closing;
  function close() {
    if (!closing) {
      shutdown.abort();
      closing = handle.close().catch((error) => {
        process.stderr.write(`mcp_close_error: ${redact(error?.message ?? "MCP close failed")}\n`);
        process.exitCode = 1;
      });
    }
    return closing;
  }

  process.stdin.once("end", () => { void close(); });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void close(); });
  }
}
