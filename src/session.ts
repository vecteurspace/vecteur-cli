import { basename } from "node:path";
import { api } from "./api.js";
import { getWorkspaceProject, setWorkspaceProject } from "./config.js";
import { webBase } from "./runner.js";

export interface SlashCommand {
  name: string;
  desc: string;
}

export interface SlashCommandResult {
  output?: string;
  clear?: boolean;
  reset?: boolean;
  exit?: boolean;
  open?: string;
}

export async function resolveWorkspaceProject(): Promise<{ id: string; created: boolean }> {
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
export function parseMentions(line: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = line.replace(/(?:^|\s)@(\S+)/g, (_m, p: string) => {
    // Strip trailing sentence punctuation so "@spec.md?" resolves to "spec.md".
    const path = p.replace(/[?.,;:!)]+$/, "");
    files.push(path);
    return ` ${path}`; // keep the (cleaned) path visible in the prompt text
  });
  return { text: text.trim(), files };
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "files", desc: "list files in this workspace directory" },
  { name: "project", desc: "show the project bound to this directory" },
  { name: "open", desc: "open this workspace's run in the web app" },
  { name: "new", desc: "start a fresh conversation" },
  { name: "clear", desc: "clear the transcript" },
  { name: "help", desc: "show this help" },
  { name: "exit", desc: "quit" },
];

export const HELP = `
Commands:
  @path             attach a local file as context (e.g. "explain @mission.md")
${SLASH_COMMANDS.map((cmd) => `  /${cmd.name.padEnd(15)} ${cmd.desc}`).join("\n")}
`;

export async function handleSlashCommand(
  cmd: string,
  ctx: { project: string; cwd: string },
): Promise<SlashCommandResult> {
  const name = cmd.replace(/^\/+/, "").trim().split(/\s+/)[0] ?? "";
  if (name === "exit" || name === "quit") return { exit: true };
  if (name === "help") return { output: HELP };
  if (name === "clear") return { clear: true };
  if (name === "project") return { output: `project ${ctx.project}  (dir: ${ctx.cwd})` };
  if (name === "open") return { open: `${webBase()}/projects/${ctx.project}` };
  if (name === "new") return { reset: true, output: "started a fresh conversation" };
  if (name === "files") {
    const files = await api<{ files?: unknown[] }>(
      `/api/v1/projects/${ctx.project}/workspace/files`,
    ).catch(() => ({ files: [] as unknown[] }));
    const output = (files.files ?? []).map((f: any) => `  ${f.name ?? f}`).join("\n") || "  (none)";
    return { output };
  }
  return { output: `unknown command: /${name} (/help)` };
}
