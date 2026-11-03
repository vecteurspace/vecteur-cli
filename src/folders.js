import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep, parse } from "node:path";
import { credentialsPath } from "./credentials.js";
import { CliError } from "./errors.js";
import { readStore, withStoreLock, writeStore } from "./store.js";

export const UNSIGNED_ACCOUNT = "local:unsigned";

const MAX_DRAFT_BYTES = 256 * 1024;
const DRAFT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const identity = path => {
  const real = realpathSync(path);
  const stat = statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new CliError("folder_invalid", "The session needs a directory");
  return { path: real, device: String(stat.dev), inode: String(stat.ino) };
};
export function broadRoot(path, home, { platform = process.platform, mounts, stat = statSync } = {}) {
  const folder = realpathSync(path);
  if (folder === realpathSync(home)) return "home";
  if (folder === parse(folder).root) return "filesystem root";
  if (platform === "linux") {
    const text = mounts ?? readFileSync("/proc/self/mountinfo", "utf8");
    const roots = text.split("\n").map(line => line.split(" ")[4]?.replace(/\\([0-7]{3})/g,
      (_, octal) => String.fromCharCode(parseInt(octal, 8))));
    if (roots.includes(folder)) return "mount root";
  }
  return stat(folder).dev !== stat(dirname(folder)).dev ? "mount root" : null;
}

const contains = (root, child) => {
  const path = relative(root, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

function readRegistry(file) {
  const value = readStore(file);
  if (value === null) return { version: 1, folders: {} };
  if (value.version !== 1) throw new CliError("store_version_unsupported",
    "Folder registry version is unsupported; install the matching CLI. Existing bytes were preserved.");
  if (!value.folders || typeof value.folders !== "object" || Array.isArray(value.folders)
      || Object.values(value.folders).some(row => !row || typeof row !== "object"
        || typeof row.origin !== "string" || typeof row.accountId !== "string"
        || typeof row.folder?.path !== "string" || typeof row.folder?.device !== "string"
        || typeof row.folder?.inode !== "string")
      || (value.logins !== undefined && (!value.logins || typeof value.logins !== "object" || Array.isArray(value.logins)
        || Object.entries(value.logins).some(([key, id]) => !/^[a-f0-9]{64}$/.test(key) || typeof id !== "string" || !id)))) {
    throw new CliError("store_unreadable", "Folder registry is invalid; existing bytes were preserved");
  }
  for (const row of Object.values(value.folders)) {
    row.drafts ??= {};
    if (row.draft && row.draftAt > Date.now() - DRAFT_LIFETIME_MS) {
      row.drafts.legacy ??= { text: row.draft, at: row.draftAt, revision: String(row.draftAt) };
    }
    delete row.draft; delete row.draftAt;
    if (!row.drafts || typeof row.drafts !== "object" || Array.isArray(row.drafts)
        || Object.values(row.drafts).some(draft => !draft || typeof draft.text !== "string"
          || typeof draft.revision !== "string" || !Number.isFinite(draft.at))) {
      throw new CliError("store_unreadable", "Saved drafts are invalid; existing bytes were preserved");
    }
    for (const [id, draft] of Object.entries(row.drafts)) {
      if (!draft.text || draft.at <= Date.now() - DRAFT_LIFETIME_MS) delete row.drafts[id];
    }
  }
  return value;
}


/** Metadata only: a Project binding is never a local filesystem grant. */
export class FolderRegistry {
  constructor({ origin, accountId, cwd = process.cwd(), env = process.env }) {
    if (!origin || !accountId) throw new CliError("folder_identity_invalid", "Origin and account are required");
    this.origin = origin;
    this.accountId = accountId;
    this.folder = identity(cwd);
    this.home = env.HOME || homedir();
    this.file = join(dirname(credentialsPath(env)), "folders.json");
    this.key = createHash("sha256").update(JSON.stringify([origin, accountId, this.folder.path])).digest("hex");
    this.lastDraft = ""; this.draftRef = null;
    try {
      const newest = this.state().drafts[0];
      if (newest) this.selectDraft(newest.id);
    } catch (error) { if (error.code !== "folder_replaced") throw error; }
  }

  static forCredential({ origin, token, env = process.env, cwd = process.cwd() }) {
    const file = join(dirname(credentialsPath(env)), "folders.json");
    const accountId = readRegistry(file).logins?.[createHash("sha256").update(JSON.stringify([origin, token])).digest("hex")];
    return typeof accountId === "string" && accountId
      ? new FolderRegistry({ origin, accountId, cwd, env }) : null;
  }

  requireAccount() {
    if (this.accountId === UNSIGNED_ACCOUNT) throw new CliError("login_required", "Unsigned drafts cannot bind a Project or authorize work");
  }

  rememberLogin(token) {
    this.requireAccount();
    withStoreLock(this.file, () => {
      const store = this.#read();
      store.logins ??= {};
      store.logins[createHash("sha256").update(JSON.stringify([this.origin, token])).digest("hex")] = this.accountId;
      writeStore(this.file, store);
    });
  }

  #read() { return readRegistry(this.file); }

  #update(change) {
    return withStoreLock(this.file, () => {
      const store = this.#read();
      const row = store.folders[this.key] ?? { origin: this.origin, accountId: this.accountId, folder: this.folder };
      if (row.folder.device !== this.folder.device || row.folder.inode !== this.folder.inode) {
        throw new CliError("folder_replaced", "This directory was replaced. Unlink its old identity before continuing.");
      }
      const result = change(row, store);
      store.folders[this.key] = row;
      writeStore(this.file, store);
      return result;
    });
  }

  binding() {
    if (this.accountId === UNSIGNED_ACCOUNT) return null;
    const entries = Object.values(this.#read().folders).filter(row =>
      row.origin === this.origin && row.accountId === this.accountId && (row.projectId || row.unlinked)
      && contains(row.folder.path, this.folder.path));
    entries.sort((a, b) => b.folder.path.length - a.folder.path.length);
    const row = entries[0];
    if (!row || row.unlinked) return null;
    let current;
    try { current = identity(row.folder.path); } catch { return { ...row, state: "folder_missing" }; }
    return { ...row, state: current.device === row.folder.device && current.inode === row.folder.inode
      ? "bound" : "folder_replaced" };
  }

  broadRoot() { return broadRoot(this.folder.path, this.home); }

  bind(projectId, { confirmHome = false, confirmBroad = confirmHome } = {}) {
    this.requireAccount();
    if (typeof projectId !== "string" || !projectId) throw new CliError("project_invalid", "Choose a Project first");
    const broad = this.broadRoot();
    if (broad && !confirmBroad) {
      throw new CliError(broad === "home" ? "home_binding_confirmation" : "root_binding_confirmation",
        `Linking this ${broad} applies to its descendants. Type ${this.folder.path} to confirm.`);
    }
    return this.#update(row => {
      if (row.pendingCreate || row.pendingRun) {
        throw new CliError("operation_unresolved", "Resolve the pending submission before relinking");
      }
      row.projectId = projectId;
      delete row.unlinked;
      delete row.pendingCreate;
    });
  }

  unlink() {
    return withStoreLock(this.file, () => {
      const store = this.#read();
      const row = store.folders[this.key];
      if (row?.pendingCreate || row?.pendingRun) throw new CliError("operation_unresolved",
        "Reconcile the pending submission before unlinking; its identity must survive");
      store.folders[this.key] = { ...row, origin: this.origin, accountId: this.accountId, folder: this.folder, unlinked: true };
      delete store.folders[this.key].projectId;
      writeStore(this.file, store);
    });
  }

  reserveCreation(name, workspaceId) {
    this.requireAccount();
    return this.#update(row => {
      if (row.projectId) return { projectId: row.projectId };
      // Both first senders share the already frozen payload, even if their asks differ.
      row.pendingCreate ??= { key: randomUUID(), name, workspaceId };
      return structuredClone(row.pendingCreate);
    });
  }

  completeCreation(key, projectId) {
    this.#update(row => {
      if (row.projectId === projectId && !row.pendingCreate) return;
      if (row.pendingCreate?.key !== key || typeof projectId !== "string" || !projectId) {
        throw new CliError("creation_mismatch", "Project creation identity changed");
      }
      row.projectId = projectId;
      delete row.unlinked;
      delete row.pendingCreate;
    });
  }

  state() {
    const row = this.#read().folders[this.key];
    if (row && (row.folder.device !== this.folder.device || row.folder.inode !== this.folder.inode)) {
      throw new CliError("folder_replaced", "Directory identity changed; /unlink acknowledges the new folder. Pending submissions must be resolved from the original folder.");
    }
    const drafts = Object.entries(row?.drafts ?? {}).map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.at - a.at);
    return { draft: this.lastDraft, drafts,
      pendingCreate: row?.pendingCreate ?? null, pendingRun: row?.pendingRun ?? null };
  }

  transferDraftTo(destination, text) {
    destination.requireAccount();
    if (this.accountId !== UNSIGNED_ACCOUNT || destination.origin !== this.origin
        || destination.folder.path !== this.folder.path) throw new CliError("draft_scope_invalid", "Draft transfer scope differs");
    this.saveDraft(text);
    destination.newDraft(); destination.saveDraft(text);
    this.saveDraft(""); // Conditional revision consumption preserves a concurrent newer source edit.
  }

  newDraft() { this.draftRef = null; this.lastDraft = ""; }

  selectDraft(id) {
    const selected = this.state().drafts.find(row => row.id === id);
    if (!selected) throw new CliError("draft_unavailable", "This saved draft changed; restart to reload it");
    this.draftRef = { id, revision: selected.revision }; this.lastDraft = selected.text;
    return selected.text;
  }

  saveDraft(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_DRAFT_BYTES) {
      throw new CliError("draft_too_large", `Draft exceeds ${MAX_DRAFT_BYTES} bytes; attach a file instead`);
    }
    if (text === this.lastDraft) return;
    const next = this.#update(row => {
      row.drafts ??= {};
      const matches = this.draftRef && row.drafts[this.draftRef.id]?.revision === this.draftRef.revision;
      if (!text) {
        if (matches) delete row.drafts[this.draftRef.id];
        return null;
      }
      if (!matches && Object.keys(row.drafts).length >= 20) throw new CliError("drafts_full",
        "20 saved drafts already exist. Recover and clear an older draft before saving another.");
      const id = matches ? this.draftRef.id : randomUUID(), revision = randomUUID();
      row.drafts[id] = { text, revision, at: Date.now() };
      return { id, revision };
    });
    this.draftRef = next; this.lastDraft = text;
  }

  reserveRun(projectId, body, draftRef = this.draftRef) {
    this.requireAccount();
    return this.#update(row => {
      if (row.pendingRun) throw new CliError("submission_pending", "Another submission needs reconciliation before a new ask");
      row.pendingRun = { key: randomUUID(), projectId, body: structuredClone(body), draftRef: structuredClone(draftRef) };
      return structuredClone(row.pendingRun);
    });
  }

  finishRunAdmission(key) {
    this.#update(row => {
      if (!row.pendingRun) return; // Another terminal may have persisted the same validated ACK.
      if (row.pendingRun?.key !== key) throw new CliError("submission_mismatch", "Submission identity changed");
      const ref = row.pendingRun.draftRef;
      if (ref && row.drafts?.[ref.id]?.revision === ref.revision) delete row.drafts[ref.id];
      if (ref && this.draftRef?.id === ref.id && this.draftRef.revision === ref.revision) {
        this.lastDraft = ""; this.draftRef = null;
      }
      delete row.pendingRun;
    });
  }

  rejectRunAdmission(key) {
    this.#update(row => {
      if (row.pendingRun?.key !== key) throw new CliError("submission_mismatch", "Submission identity changed");
      delete row.pendingRun;
    });
  }
}
