import { STORAGE_GB } from "./contract.js";
import { CliError } from "./errors.js";

/** Resolve only server-authorized objects. Ids take precedence over names. */
export function resolveNamed(rows, value, kind) {
  const byId = rows.find(row => row.id === value);
  if (byId) return byId;
  const matches = rows.filter(row => row.name === value);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new CliError(`${kind}_ambiguous`,
    `${value} matches multiple ${kind}s: ${matches.map(row => row.id).join(", ")}; use an id`);
  throw new CliError(`${kind}_not_found`,
    `${value} is not an authorized ${kind}; available: ${describe(rows)}`);
}

const describe = rows => rows.map(row => `${row.name} (${row.id})`).join(", ") || "none";

export function resolveWorkspace(account, value) {
  const rows = account.workspaces;
  if (value !== undefined) return resolveNamed(rows, value, "workspace").id;
  if (rows.length === 1) return rows[0].id;
  throw new CliError("workspace_required", `Choose --workspace <name-or-id>: ${describe(rows)}`);
}

export async function resolveRunProject(client, explicitId) {
  if (explicitId !== undefined) return explicitId;
  const selected = client.config.projectId;
  if (!selected) throw new CliError("project_selection_required",
    "Select a Project with `vecteur project use <name-or-id>` after persistent login, or pass --project <id>");
  const projects = await client.projectList();
  if (!projects.some(project => project.id === selected)) {
    throw new CliError("project_not_found",
      `Selected Project ${selected} is no longer authorized; run \`vecteur project use <name-or-id>\``);
  }
  return selected;
}

export function humanProjects(value) {
  const rows = value.projects.map(project =>
    `${project.id === value.selected_project_id ? "*" : " "} ${project.name} (${project.id}) ${project.role}`);
  const allowance = value.active_projects;
  const summary = value.storage.state === "unavailable" ? "Storage figure unavailable"
    : `Storage: ${storageBytes(value.storage.projects.reduce((sum, project) => sum + project.working_bytes + project.object_bytes, 0))} in visible projects · ${value.storage.state}`;
  return [...rows, `Active projects: ${allowance.current} / ${allowance.maximum ?? "Contract limit"}`, summary].join("\n") + "\n";
}

function storageBytes(bytes) {
  return bytes < STORAGE_GB ? `${bytes} B` : `${Number((bytes / STORAGE_GB).toFixed(2))} GB`;
}
