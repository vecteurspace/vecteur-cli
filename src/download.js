import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { CliError } from "./errors.js";
import { canonicalJson, runSections, safeArtifactName } from "./format.js";

function defaultName(casRef) {
  return `artifact-${casRef.slice("sha256:".length, "sha256:".length + 12)}`;
}

/**
 * Stream admitted bytes to a private sibling, then publish with an atomic no-overwrite link.
 * A remote filename never reaches this path: the caller either supplies --output or receives
 * a digest-derived basename, so traversal and shell metacharacters cannot arrive from RunWire.
 */
export async function downloadArtifact(client, casRef, projectId, output) {
  return downloadTo(output ?? defaultName(casRef),
    chunk => client.artifactGet(casRef, projectId, chunk));
}

export async function downloadProjection(client, projectId, runId, projection, output) {
  return downloadTo(output ?? `transfer-table-${projection.projection_id.slice(11, 23)}.json`,
    chunk => client.projectionGet(projectId, runId, projection, chunk));
}

async function downloadTo(filename, fetchBytes) {
  const target = resolve(filename);
  const temporary = resolve(dirname(target), `.vecteur-${basename(target)}-${randomUUID()}.part`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    const result = await fetchBytes(chunk => handle.writeFile(chunk));
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new CliError("output_exists", `refusing to overwrite ${target}`);
      }
      throw error;
    }
    return { ...result, path: target };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("download_failed", `could not safely write ${target}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/**
 * File-only exchange out of Vecteur: one NEW folder holding the exact answer bytes, the canonical
 * Run record and every artifact, each digest-verified against its CAS id. Nothing is overwritten.
 */
export async function exportRun(client, run, projectId, directory) {
  const sections = runSections(run);
  if (!sections.state) throw new CliError("run_open", "Export a completed Run; this one is still open");
  const target = resolve(directory);
  try { await mkdir(target, { mode: 0o700 }); } catch (error) {
    if (error?.code === "EEXIST") throw new CliError("output_exists", `refusing to export into existing ${target}`);
    throw new CliError("export_failed", `could not create ${target}`);
  }
  const files = [];
  const write = async (name, bytes) => {
    await writeFile(join(target, name), bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: join(target, name), bytes: Buffer.byteLength(bytes) });
  };
  if (sections.answer !== undefined) await write("answer.md", sections.answer);
  await write("run.json", canonicalJson(run));
  const used = new Set(["answer.md", "run.json"]);
  for (const { artifact } of sections.artifacts) {
    let name = safeArtifactName(artifact);
    if (used.has(name)) name = `${artifact.cas_ref.slice(7, 19)}-${name}`;
    used.add(name);
    const result = await downloadArtifact(client, artifact.cas_ref, projectId, join(target, name));
    files.push({ path: result.path, bytes: result.bytes, cas_ref: artifact.cas_ref });
  }
  return { directory: target, run_id: run.run_id, terminal: run.terminal, files };
}
