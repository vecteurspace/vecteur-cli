/** projects: list the user's projects (same projects the web app shows — coherence). */
import { api } from "../api.js";

interface Project {
  id: string;
  name?: string;
  slug?: string;
  updated_at?: string;
}

interface ProjectList {
  projects?: Project[];
  items?: Project[];
  total?: number;
}

export async function listProjects(opts: { json?: boolean; limit?: number }): Promise<void> {
  const res = await api<ProjectList>("/api/v1/projects", {
    query: { limit: opts.limit ?? 20 },
  });
  const projects = res.projects ?? res.items ?? [];
  if (opts.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (projects.length === 0) {
    console.log("No projects yet. Start one with `vecteur ask \"…\"`.");
    return;
  }
  for (const p of projects) {
    const when = p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 10) : "";
    console.log(`${p.id}  ${when}  ${p.name ?? p.slug ?? ""}`);
  }
}
