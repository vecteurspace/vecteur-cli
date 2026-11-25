import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import { CliError } from "./errors.js";
import { downloadArtifact } from "./download.js";
import { runArtifacts } from "./blocks.js";

// The run door's material cap (backend asgi.MAX_MATERIAL_BYTES): one figure everywhere.
export const MAX_MATERIAL_BYTES = 16 * 1024 * 1024;
export const TEXT_MEDIA = { ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ...Object.fromEntries(['.py', '.m', '.jl', '.r', '.c', '.h', '.cpp', '.f90', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.tex', '.rst', '.oem', '.e', '.tle', '.tdm', '.sp3', '.czml', '.xml'].map(ext => [ext, 'text/plain'])) };
export const MEDIA = { ...TEXT_MEDIA, ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const SECRET = /vct_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./;
export function scanString(text, refusal = "Credential-shaped content refused; nothing uploaded") {
  if (SECRET.test(text)) throw new CliError("secret_suspected", refusal);
}
// Include invisible marks such as variation selectors and the combining grapheme joiner.
const withoutControls = text => text.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, c => /[\t\r\n]/.test(c) ? c : '');
export function scanNormalized(text, refusal) {
  scanString(text, refusal);
  scanString(withoutControls(text), refusal);
}

export const SOURCE_NAME_REFUSAL = "File name resembles a credential. Rename it before uploading.";

// Match the runner's single segment and 200-byte limit before percent-encoding for the backend.
export function attachmentName(path) {
  const localName = basename(path);
  scanNormalized(localName, SOURCE_NAME_REFUSAL);
  const name = localName.split("\\").at(-1)
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  scanNormalized(name, SOURCE_NAME_REFUSAL);
  if (Buffer.byteLength(name) <= 200) return name;

  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 ? name.slice(dot) : "";
  const clip = (text, budget) => new TextDecoder("utf-8").decode(Buffer.from(text).subarray(0, budget), { stream: true }).trimEnd();
  const budget = 200 - Buffer.byteLength(suffix);
  const stem = budget > 0 && suffix ? clip(name.slice(0, dot), budget) : "";
  const bounded = stem ? stem + suffix : clip(name, 200);
  scanNormalized(bounded, SOURCE_NAME_REFUSAL);
  return bounded;
}

const inside = (root, path) => path === root || path.startsWith(root + sep);

/** A path the caller named, resolved against the working folder; it may not leave that folder. */
async function contained(cwd, name, { leaf }) {
  const root = await realpath(cwd);
  const target = resolve(root, name);
  const parent = await realpath(leaf ? dirname(target) : target).catch(() => {
    throw new CliError("path_invalid", "Path does not exist inside the working folder");
  });
  if (!inside(root, parent)) throw new CliError("path_outside_folder", "Path leaves the working folder");
  return leaf ? join(parent, basename(target)) : parent;
}

/** Digest-verified artifact download (the `vecteur run export` verifier) into the working folder. */
export async function artifactToFolder(client, { projectId, casRef, runId, artifactPath, output, cwd, signal }) {
  if (!casRef) {
    if (!runId || !artifactPath) throw new CliError("usage_invalid", "Give cas_ref, or run_id with artifact_path");
    const run = await client.runGet(runId, signal);
    const found = runArtifacts(run.events).find(artifact => artifact.path === artifactPath);
    if (!found) throw new CliError("artifact_unavailable", "Run has no such artifact");
    casRef = found.cas_ref;
  }
  const target = await contained(cwd, output ?? `artifact-${String(casRef).slice(7, 19)}`, { leaf: true });
  const result = await downloadArtifact(client, casRef, projectId, target);
  return { path: result.path, bytes: result.bytes, cas_ref: casRef, content_type: result.content_type, verified: true };
}

/** The CLI --attach selection: every offered extract, in canonical order. */
export async function selectSource(client, projectId, source, signal) {
  const offer = source.offer ?? await client.inputOffer(projectId, source, signal);
  if (!offer.extracts.length) throw new CliError("extraction_unavailable", "This file has no selectable extracts");
  return { source_handle: { cas_ref: source.cas_ref, acquisition_ref: source.acquisition_ref },
    offer_id: offer.id, selected_extract_ids: offer.extracts.map(extract => extract.id).sort(), method: "exact-extract" };
}

/**
 * Upload one local file as Project material through the same inputs door as `/attach`. The
 * destination is disclosed and must be confirmed verbatim; a foreign, read-only or moved-on
 * Project refuses before any byte leaves.
 */
export async function materialAttach(client, { projectId, path, confirmOrigin, expectedStateHash, cwd, signal }) {
  const origin = client.config.origin;
  if (confirmOrigin !== origin) throw new CliError("destination_unconfirmed", `Upload goes to ${origin}; confirm that origin`);
  const project = await client.projectGet(projectId, signal);
  if (project.role === "VIEWER") throw new CliError("role_forbidden", "Editor access is required to attach material");
  const newest = await client.projectNewestRun(projectId, signal);
  if ((newest?.state_hash ?? null) !== expectedStateHash) {
    throw new CliError("project_stale", "Project head moved; read the latest run and retry");
  }
  const filename = await contained(cwd, path, { leaf: false });
  const sourceName = attachmentName(resolve(cwd, path));
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MATERIAL_BYTES) {
      throw new CliError("attachment_invalid", "Select one non-empty file no larger than 16 MiB");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new CliError("attachment_changed", "File changed while reading; select it again");
    }
  } finally { await handle.close(); }
  const media = MEDIA[extname(filename).toLowerCase()] ?? "application/octet-stream";
  const source = await client.inputAdd(projectId, bytes, media, { sourceName, signal });
  const selection = await selectSource(client, projectId, source, signal);
  return {
    project_id: projectId, project_name: project.name, destination: origin, filename: sourceName || "attachment",
    bytes: bytes.length, cas_ref: source.cas_ref, acquisition_ref: source.acquisition_ref,
    offer_id: selection.offer_id, extract_count: selection.selected_extract_ids.length, selections: [selection],
  };
}
