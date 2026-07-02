/**
 * chat: an interactive, workspace-aware REPL — the Claude-Code-like experience.
 *
 * The current directory IS the workspace (bound to a persistent project so returning resumes
 * context). You converse multi-turn; the server-side Vecteur agent answers, streaming its steps.
 * `@path` mentions attach local files (sandboxed to cwd). Slash commands manage the session.
 * The brain stays server-side (Connected model) — the CLI is a thin, local, streaming client.
 */
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { api } from "../api.js";
import { loadConfig, getWorkspaceProject, setWorkspaceProject } from "../config.js";
import { streamTurn, webBase, buildLocalContextQuery, openBrowser } from "../runner.js";

const DIM = "\x1b[2m", RESET = "\x1b[0m", CYAN = "\x1b[36m", BOLD = "\x1b[1m";

async function resolveWorkspaceProject(): Promise<{ id: string; created: boolean }> {
  const cwd = process.cwd();
  const bound = getWorkspaceProject(cwd);
  if (bound) return { id: bound, created: false };
  const name = basename(cwd) || "workspace";
  const proj = await api<{ id: string }>("/api/v1/projects", {
    method: "POST",
    body: { name: `${name} (CLI)` },
  });
  setWorkspaceProject(cwd, proj.id);
  return { id: proj.id, created: true };
}

/** Split a line into the prompt text and any @path file mentions. */
function parseMentions(line: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = line.replace(/(?:^|\s)@(\S+)/g, (_m, p: string) => {
    // Strip trailing sentence punctuation so "@spec.md?" resolves to "spec.md".
    const path = p.replace(/[?.,;:!)]+$/, "");
    files.push(path);
    return ` ${path}`; // keep the (cleaned) path visible in the prompt text
  });
  return { text: text.trim(), files };
}

const HELP = `
Commands:
  @path             attach a local file as context (e.g. "explain @mission.md")
  /files            list files in this workspace directory
  /project          show the project bound to this directory
  /open             open this workspace's run in the web app
  /new              start a fresh conversation (new context)
  /clear            clear the screen
  /help             show this help
  /exit  (or Ctrl-D) quit
`;

export async function chat(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error("Not logged in. Run `vecteur login` first.");
    process.exitCode = 1;
    return;
  }
  let { id: project, created } = await resolveWorkspaceProject();
  const cwd = process.cwd();

  console.log(`${BOLD}Vecteur${RESET} ${DIM}— space-engineering agent in your terminal${RESET}`);
  console.log(`${DIM}workspace: ${cwd}${RESET}`);
  console.log(`${DIM}project:   ${project}${created ? " (new)" : ""}  ·  /help for commands${RESET}\n`);

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
      const [cmd] = raw.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "quit") break;
      else if (cmd === "help") console.log(HELP);
      else if (cmd === "clear") console.clear();
      else if (cmd === "project") console.log(`project ${project}  (dir: ${cwd})`);
      else if (cmd === "open") void openBrowser(`${webBase()}/projects/${project}`);
      else if (cmd === "new") {
        turns = 0;
        lastTaskId = undefined;
        console.log(`${DIM}started a fresh conversation${RESET}`);
      } else if (cmd === "files") {
        const files = await api<{ files?: unknown[] }>(
          `/api/v1/projects/${project}/workspace/files`,
        ).catch(() => ({ files: [] as unknown[] }));
        console.log((files.files ?? []).map((f: any) => `  ${f.name ?? f}`).join("\n") || "  (none)");
      } else console.log(`unknown command: /${cmd} (/help)`);
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
      lastTaskId = res.taskId;
      turns++;
    }
    rl.prompt();
  }

  rl.close();
  console.log(`${DIM}bye${RESET}`);
}
