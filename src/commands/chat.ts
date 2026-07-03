/**
 * chat: an interactive, workspace-aware REPL — the Claude-Code-like experience.
 *
 * The current directory IS the workspace (bound to a persistent project so returning resumes
 * context). You converse multi-turn; the server-side Vecteur agent answers, streaming its steps.
 * `@path` mentions attach local files (sandboxed to cwd). Slash commands manage the session.
 * The brain stays server-side (Connected model) — the CLI is a thin, local, streaming client.
 */
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { login } from "./auth.js";
import { refreshUpdateCache, updateNoticeFromCache } from "../update.js";
import { streamTurn, webBase, buildLocalContextQuery, openBrowser } from "../runner.js";
import { handleSlashCommand, parseMentions, renameProject, resolveWorkspaceProject, titleFromPrompt } from "../session.js";

const DIM = "\x1b[2m", RESET = "\x1b[0m", CYAN = "\x1b[36m", BOLD = "\x1b[1m";

export async function chat(): Promise<void> {
  let cfg = loadConfig();
  if (!cfg.token) {
    // Force login first, then drop into the session — but only interactively; a piped/non-TTY
    // invocation can't complete the device flow, so it still fails fast with guidance.
    if (process.stdin.isTTY) {
      console.log(`${DIM}You're not signed in — let's log in first.${RESET}\n`);
      await login({});
      cfg = loadConfig();
    }
    if (!cfg.token) {
      console.error("Not logged in. Run `vecteur login` first.");
      process.exitCode = 1;
      return;
    }
  }
  const { id: project, created } = await resolveWorkspaceProject();
  const cwd = process.cwd();
  // Refresh the update cache (throttled to once/day) so the notice shows this run, not next.
  await refreshUpdateCache();
  const updateNotice = updateNoticeFromCache();
  const useInk =
    Boolean(process.stdout.isTTY) &&
    (process.stdout.columns ?? 0) >= 60 &&
    (process.stdout.rows ?? 0) >= 10 &&
    Boolean(process.stdin.isTTY);

  if (useInk) {
    const [{ render }, { createElement }, { App }] = await Promise.all([
      import("ink"),
      import("react"),
      import("../ui/App.js"),
    ]);
    const instance = render(
      createElement(App, {
        project,
        cwd,
        created,
        userLabel: cfg.tokenPrefix ?? "user",
        updateNotice,
      }),
    );
    await instance.waitUntilExit();
    return;
  }

  console.log(`${BOLD}Vecteur${RESET} ${DIM}— space-engineering agent in your terminal${RESET}`);
  console.log(`${DIM}workspace: ${cwd}${RESET}`);
  console.log(`${DIM}project:   ${project}${created ? " (new)" : ""}  ·  /help for commands${RESET}`);
  if (updateNotice) console.log(`\x1b[33m${updateNotice}${RESET}`);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${CYAN}› ${RESET}` });
  let turns = 0;
  let lastTaskId: string | undefined; // threads multi-turn context to the next turn
  rl.prompt();

  // `for await…of` consumes lines with backpressure — works for both an interactive TTY and
  // piped/scripted input (the async body pauses input until each turn finishes).
  for await (const rawLine of rl) {
    const raw = rawLine.trim();
    if (!raw) {
      rl.prompt();
      continue;
    }

    if (raw.startsWith("/")) {
      const result = await handleSlashCommand(raw, { project, cwd });
      if (result.exit) break;
      if (result.clear) console.clear();
      if (result.open) void openBrowser(result.open);
      if (result.reset) {
        turns = 0;
        lastTaskId = undefined;
      }
      if (result.output) console.log(result.output);
      rl.prompt();
      continue;
    }

    const { text, files } = parseMentions(raw);
    let query: string;
    try {
      query = buildLocalContextQuery(text, files.length ? files : undefined);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      rl.prompt();
      continue;
    }

    process.stdout.write(`${DIM}▸ thinking…${RESET}\n`);
    const res = await streamTurn({
      project,
      query,
      followUp: turns > 0,
      contextTaskId: lastTaskId,
      onStep: (s) => process.stdout.write(`${DIM}  · ${s}${RESET}\n`),
    });
    if (res.failed) console.error(`✗ ${res.failed}`);
    else {
      console.log("\n" + (res.answer ?? "(no answer)") + "\n");
      if (res.sawVisual) console.log(`${DIM}(visual artifacts — see ${webBase()}/projects/${project})${RESET}`);
      // First prompt in a freshly-created project becomes its title (self-describing in the web app).
      if (created && turns === 0) void renameProject(project, titleFromPrompt(raw));
      lastTaskId = res.taskId;
      turns++;
    }
    rl.prompt();
  }

  rl.close();
  console.log(`${DIM}bye${RESET}`);
}
