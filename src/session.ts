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
  // Provisional, unique title until the first prompt renames it: "<dir> · <datetime>".
  // The directory tells you where it came from; the timestamp keeps same-named dirs distinct.
  const dir = basename(cwd) || "workspace";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const proj = await api<{ id: string }>("/api/v1/projects", {
    method: "POST",
    body: { name: `${dir} · ${stamp}` },
  });
  setWorkspaceProject(cwd, proj.id);
  return { id: proj.id, created: true };
}

/** A short, human project title from the user's first prompt (collapsed + capped to 60 chars). */
export function titleFromPrompt(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

/** Rename a project (best-effort — a nicer title must never break or block a turn). */
export async function renameProject(projectId: string, name: string): Promise<void> {
  if (!name) return;
  try {
    await api(`/api/v1/projects/${projectId}`, { method: "PUT", body: { name } });
  } catch {
    /* ignore — title is cosmetic */
  }
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
  { name: "usage", desc: "show remaining AI usage, forecast and granted pools" },
  { name: "files", desc: "list files in this workspace directory" },
  { name: "project", desc: "show the project bound to this directory" },
  { name: "open", desc: "open this workspace's run in the web app" },
  { name: "new", desc: "start a fresh conversation" },
  { name: "clear", desc: "clear the transcript" },
  { name: "help", desc: "show this help" },
  { name: "exit", desc: "quit" },
];

/** 1,000 usage units ≈ 1 minute — same vocabulary as the web app and MCP. */
export function unitsAsTime(units: number): string {
  if (units < 0) return "unlimited";
  const minutes = Math.round(units / 1000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${String(rem).padStart(2, "0")}m`;
}

interface SubscriptionUsage {
  account_type?: string;
  credit_balance_eur?: number;
  usage_framing?: {
    daily_used_pct: number | null;
    monthly_used_pct: number | null;
    prompts_left_today: number | null;
  } | null;
  tokens?: {
    daily_used: number;
    daily_limit: number;
    monthly_used: number;
    monthly_limit: number;
  };
  grants?: Array<{
    label?: string;
    remaining_units?: number;
    shared_member_count?: number;
    expires_at?: string;
  }>;
  forecast?: {
    projected_pct_of_limit?: number;
    depletion_date?: string | null;
  } | null;
}

export function formatUsage(sub: SubscriptionUsage): string {
  const lines: string[] = [];
  const t = sub.tokens;
  const f = sub.usage_framing;
  lines.push(`plan: ${(sub.account_type ?? "free").toUpperCase()}`);
  // Percent/prompt framing first (same vocabulary as web); time as fallback.
  if (f && f.daily_used_pct !== null) {
    const prompts =
      f.prompts_left_today !== null ? ` · ≈ ${f.prompts_left_today.toLocaleString()} prompts left` : "";
    lines.push(`today:      ${f.daily_used_pct}% used${prompts}`);
    if (f.monthly_used_pct !== null) lines.push(`this month: ${f.monthly_used_pct}% used`);
  } else if (t) {
    const dailyLeft = Math.max(0, t.daily_limit - t.daily_used);
    const monthlyLeft = Math.max(0, t.monthly_limit - t.monthly_used);
    lines.push(
      `today:      ${unitsAsTime(t.daily_used)} used · ≈ ${unitsAsTime(dailyLeft)} left of ${unitsAsTime(t.daily_limit)}`,
    );
    lines.push(
      `this month: ${unitsAsTime(t.monthly_used)} used · ≈ ${unitsAsTime(monthlyLeft)} left of ${unitsAsTime(t.monthly_limit)}`,
    );
  }
  if (sub.forecast) {
    const f = sub.forecast;
    const pct = f.projected_pct_of_limit != null ? `~${f.projected_pct_of_limit}% of your monthly allowance by month-end` : "";
    const dep = f.depletion_date ? ` · runs out ~${f.depletion_date}` : "";
    if (pct || dep) lines.push(`forecast:   ${pct}${dep}`);
  }
  for (const g of sub.grants ?? []) {
    const shared =
      (g.shared_member_count ?? 0) > 1 ? ` · shared with ${g.shared_member_count}` : "";
    const exp = g.expires_at ? ` · expires ${g.expires_at.slice(0, 10)}` : "";
    lines.push(`granted:    ${unitsAsTime(g.remaining_units ?? 0)} left (${g.label ?? "grant"})${shared}${exp}`);
  }
  if (typeof sub.credit_balance_eur === "number") {
    lines.push(`credits:    €${sub.credit_balance_eur.toFixed(2)}`);
  }
  return lines.map((l) => `  ${l}`).join("\n");
}

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
  if (name === "usage") {
    try {
      const sub = await api<Parameters<typeof formatUsage>[0]>("/api/v1/billing/subscription");
      return { output: formatUsage(sub) };
    } catch (e) {
      return { output: `could not load usage (${(e as Error).message})` };
    }
  }
  return { output: `unknown command: /${name} (/help)` };
}
