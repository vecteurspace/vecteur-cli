import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { CliError, VecteurClient, redact } from "./client.js";
import { EVENT_KINDS, RETIRED_EVENT_KINDS, TERMINAL_STATES } from "./contract.js";
import { canonicalJson } from "./format.js";

const projectInput = z.object({ project_id: z.string().min(1) }).strict();
const submitInput = z.object({
  project_id: z.string().min(1),
  ask: z.string().min(1),
}).strict();
const runInput = z.object({ run_id: z.string().min(1) }).strict();
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
  stored_wire_version: z.union([z.literal(1), z.literal(2)]),
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

function success(value) {
  return {
    content: [{ type: "text", text: canonicalJson(value) }],
    structuredContent: value,
  };
}

function failure(error) {
  const code = error instanceof CliError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code : "internal_error";
  return {
    isError: true,
    content: [{ type: "text", text: canonicalJson({ error: { code } }) }],
  };
}

function tool(server, name, description, inputSchema, outputSchema, call) {
  server.registerTool(name, { description, inputSchema, outputSchema }, async (input, context) => {
    try {
      return success(await call(input, context));
    } catch (error) {
      return failure(error);
    }
  });
}

export function createVecteurMcpServer(client = new VecteurClient(), shutdownSignal = undefined) {
  const server = new McpServer({ name: "vecteur", version: "0.1.0" });
  const signal = (context) => shutdownSignal
    ? AbortSignal.any([context.mcpReq.signal, shutdownSignal]) : context.mcpReq.signal;

  tool(server, "vecteur_project_get", "Get one PAT-bound Vecteur project.", projectInput, projectOutput,
    ({ project_id: projectId }, context) => client.projectGet(projectId, signal(context)));

  tool(server, "vecteur_run_submit",
    "Submit one project turn that continues the Project's current head and return its terminal record.",
    submitInput, admittedOutput, async ({ project_id: projectId, ask }, context) => {
      const progressToken = context.mcpReq._meta?.progressToken;
      const onEvent = progressToken === undefined ? null : (event) => context.mcpReq.notify({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: event.seq + 1,
            message: event.kind,
          },
        });
      return client.runSubmit(projectId, ask, onEvent, signal(context));
    });

  tool(server, "vecteur_run_get", "Get one Vecteur run record, including an open run.", runInput, admittedOutput,
    ({ run_id: runId }, context) => client.runGet(runId, signal(context)));

  tool(server, "vecteur_run_events", "Validate run events against its direct record.", runInput,
    admittedOutput, ({ run_id: runId }, context) => client.runEvents(runId, null, signal(context)));

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
