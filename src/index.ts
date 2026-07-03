#!/usr/bin/env node
/**
 * `vecteur` — thin CLI client for the Vecteur space-engineering platform.
 * Hosted brain: the agent and physics libraries stay server-side; this ships only data shapes.
 */
import { Command } from "commander";
import { ApiError } from "./api.js";
import { loadConfig } from "./config.js";
import { login, logout, whoami } from "./commands/auth.js";
import { listProjects } from "./commands/projects.js";
import { ask } from "./commands/ask.js";
import { chat } from "./commands/chat.js";
import { VERSION } from "./version.js";
import { refreshUpdateCache, runUpdate } from "./update.js";

const program = new Command();

program
  .name("vecteur")
  .description("Vecteur CLI — run space-engineering queries against the Vecteur platform.")
  .version(VERSION)
  .option("--api-url <url>", "override API base URL (or set VECTEUR_API_URL)");

program
  .command("login")
  .description("Authenticate — browser device flow by default, or --token / --email --password")
  .option("--token <token>", "personal access token or bearer to store")
  .option("--email <email>", "email (password login)")
  .option("--password <password>", "password (password login)")
  .option("--no-browser", "print the device authorization URL without opening a browser")
  // commander maps `--no-browser` to `o.browser === false`; translate to the `noBrowser` flag login expects.
  .action(async (o) => run(() => login({ ...o, noBrowser: o.browser === false, apiUrl: program.opts().apiUrl })));

program.command("logout").description("Clear the stored token").action(() => logout());

program
  .command("update")
  .description("Update the CLI to the latest published version")
  .action(() => run(runUpdate));

program.command("whoami").description("Show the current user, token, and API").action(() => run(whoami));

program
  .command("projects")
  .alias("ls")
  .description("List your projects (same as the web app)")
  .option("--json", "raw JSON output")
  .option("--limit <n>", "max projects", (v) => parseInt(v, 10))
  .action((o) => run(() => listProjects(o)));

program
  .command("chat", { isDefault: true })
  .description("Interactive session — the current directory is your workspace (default)")
  .action(() => run(chat));

program
  .command("ask <query>")
  .description("Run an engineering query and stream the result")
  .option("--project <id>", "target project (created if omitted)")
  .option("--agent <name>", "agent to use")
  .option("--follow-up", "continue the project's conversation (preserve context)")
  .option("--file <path...>", "attach local file(s) from your workspace as context")
  .option("--json", "emit raw run-wire events")
  .option("--open", "open the full run in the browser when done")
  .action((query, o) => run(() => ask(query, o)));

program
  .command("config")
  .description("Show effective config (api url, token prefix)")
  .action(() => {
    const c = loadConfig();
    console.log(`api:   ${c.apiUrl}`);
    console.log(`token: ${c.token ? (c.tokenPrefix ?? "set") + "…" : "(none)"}`);
  });

async function run(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`✗ ${e.hint()}`);
      process.exitCode = e.status === 401 ? 2 : e.status === 403 ? 3 : 1;
    } else {
      console.error(`✗ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}

// Keep the update cache warm for all commands (throttled once/day); `chat` shows the notice in-TUI.
void refreshUpdateCache();

program.parseAsync(process.argv);
