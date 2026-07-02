/**
 * ask: one-shot — run an engineering query and stream the answer. A thin wrapper over the
 * shared runner (same streaming path the interactive `chat` REPL uses).
 */
import { loadConfig } from "../config.js";
import { buildLocalContextQuery, openBrowser, streamTurn, webBase } from "../runner.js";

interface AskOpts {
  project?: string;
  agent?: string;
  followUp?: boolean;
  file?: string[];
  json?: boolean;
  open?: boolean;
}

export async function ask(query: string, opts: AskOpts): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error("Not logged in. Run `vecteur login` first.");
    process.exitCode = 1;
    return;
  }
  if (!opts.project) {
    console.error('A project is required: `vecteur ask "…" --project <id>` (or use `vecteur` for an interactive session).');
    process.exitCode = 1;
    return;
  }

  const effectiveQuery = buildLocalContextQuery(query, opts.file);
  if (!opts.json) console.error("▸ running…");
  const res = await streamTurn({
    project: opts.project,
    query: effectiveQuery,
    followUp: opts.followUp,
    agent: opts.agent,
    json: opts.json,
    onStep: opts.json ? undefined : (s) => process.stderr.write(`  · ${s}\n`),
  });

  if (opts.json) return;
  if (res.failed) {
    console.error(`✗ ${res.failed}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n" + (res.answer ?? "(no answer)"));
  const link = `${webBase()}/projects/${opts.project}`;
  console.log(`\nView the full run (globe, tables, provenance): ${link}`);
  if (res.sawVisual) console.log("(this run produced visual artifacts best seen in the web view)");
  if (opts.open) void openBrowser(link);
}
