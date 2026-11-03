import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CliError } from "./errors.js";
import { shellQuote } from "./format.js";

/**
 * Stage-2 bridge to the user's own generalist CLI, through the existing `vecteur mcp` server only.
 * The vendor binary is unmodified and keeps its own login and billing; Vecteur never reads its
 * credentials. Setup is the vendor's own `mcp add`; a handoff passes a per-invocation MCP
 * configuration and changes no persistent vendor configuration.
 */
export const VENDORS = Object.freeze({ claude: "Claude Code", codex: "Codex" });

/** The exact installed launcher for a one-off handoff; the PATH launcher survives updates for setup. */
export function executingServer() {
  return { command: process.execPath, args: [realpathSync(fileURLToPath(new URL("../bin/vecteur.js", import.meta.url))), "mcp"] };
}

export function vendorArgv(vendor, mode, server = { command: "vecteur", args: ["mcp"] }) {
  if (!Object.hasOwn(VENDORS, vendor)) throw new CliError("usage_invalid", "Choose claude or codex");
  if (vendor === "claude") return mode === "setup"
    ? ["claude", "mcp", "add", "--scope", "user", "vecteur", "--", server.command, ...server.args]
    : ["claude", "--mcp-config", JSON.stringify({ mcpServers: { vecteur: { type: "stdio", ...server } } })];
  return mode === "setup" ? ["codex", "mcp", "add", "vecteur", "--", server.command, ...server.args]
    : ["codex", "-c", `mcp_servers.vecteur.command=${JSON.stringify(server.command)}`,
      "-c", `mcp_servers.vecteur.args=${JSON.stringify(server.args)}`];
}

export const shellLine = argv => argv.map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : shellQuote(part)).join(" ");

/** Run the vendor in this terminal; resolve with its exit code. A missing binary is a typed refusal. */
export function runVendor(argv, env = process.env) {
  // Ctrl+C belongs to the vendor while it owns the terminal; this process only waits.
  const ignore = () => {}; process.on("SIGINT", ignore);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });
    child.once("error", error => reject(error?.code === "ENOENT"
      ? new CliError("vendor_unavailable", `${argv[0]} is not installed or not on PATH. Install ${VENDORS[argv[0]]}, sign in with it, then run:\n  ${shellLine(argv)}`)
      : new CliError("vendor_failed", `${argv[0]} could not start: ${error?.code ?? "spawn failed"}`)));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }).finally(() => process.off("SIGINT", ignore));
}
