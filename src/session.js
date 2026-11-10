import { Executor } from "./executor.js";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { VecteurClient, CliError, configuration, delay, isTokenShaped, requestTimeout,
  resolveOrigin, shouldOpenBrowser, waitForDeviceAuthorization } from "./client.js";
import { readCredentials, writeCredentials, clearCredentials } from "./credentials.js";
import { FolderRegistry, UNSIGNED_ACCOUNT } from "./folders.js";
import { runView } from "./blocks.js";
import { produceIntent } from "./produce.js";
import { downloadArtifact, exportRun } from "./download.js";
import { humanRun, runSections, safeArtifactName, stopViewOf, turnFooter, terminalText, proposalReview, adoptionHint } from "./format.js";
import { localProcessEnv, withLocalLock, withAdmissionLock, executionGrant, checkGrantLive, qualify, currentGrant, createGrant, prepareConsent, checkConsent, endGrants, pinCheck, selectionMetadata,
  readConfined, recordUpload, discover, nameOffers, tombstoned, writeNewConfined,
  reconcileWrites, reconcileAdmissions, inspectTarget, observeTargetMetadata, observeTargets, proposals, proposalName, writeProposalConfined, downloadLocalArtifact } from './localfiles.js';
import { artifactRows } from './blocks.js';
import { ARTIFACT_MEDIA_TYPES, CATALOGUE_ENVELOPE_SHA256, MODEL_CATALOGUE, PRODUCT_ROUTES } from "./contract.js";
import { openBrowser } from "./browser.js";

const PACKAGE_MARKER = ".vecteur-package.json";
const FLAG = /^-{1,2}[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9_.:-]+)?$/;
const WORD = /^[A-Za-z0-9_.:\/-]+$/;
const commandDisplay = command => JSON.stringify(command).replace(/[\p{Cc}\p{Cf}]/gu,
  character => character.split('').map(unit => '\\u'+unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));

/** The folder holding kc.json: the package folder itself, or the one directory an unzipped archive made in it. */
async function packageRoot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => entry.isFile() && entry.name === "kc.json")) return directory;
  const dirs = entries.filter(entry => entry.isDirectory());
  if (dirs.length === 1) {
    const inner = join(directory, dirs[0].name);
    if ((await readdir(inner)).includes("kc.json")) return inner;
  }
  throw new CliError("package_invalid", "No kc.json in the package folder; unzip the package there first");
}

/** The approved process template: `python -m pytest` plus plain flags and paths inside the package. */
export function approvedTemplate(manifest, root) {
  const argv = manifest?.test;
  if (!Array.isArray(argv) || argv[0] !== "python" || argv[1] !== "-m" || argv[2] !== "pytest") {
    throw new CliError("template_unapproved", "The declared test command must be: python -m pytest [flags] [paths]");
  }
  for (const item of [...argv.slice(3), ...(manifest.paths ?? [])]) {
    if (typeof item !== "string" || isAbsolute(item) || item.split(/[\\/]/).includes("..")
        || relative(root, resolve(root, item)).startsWith("..")) {
      throw new CliError("path_escape", `"${item}" leaves the package folder`);
    }
    if (!FLAG.test(item) && !WORD.test(item.replace(/\*/g, ""))) {
      throw new CliError("template_unapproved", `"${item}" is not a plain flag or path`);
    }
  }
  return argv;
}

export const NEW_FOLDER = "New folder — send an ask or /link an existing Project";
const AUTH_ERRORS = new Set(["pat_expired", "pat_invalid", "pat_revoked"]);
const MAX_QUIET_ROTATIONS = 30; // 30 x 120 s request bound: one hour of silence
const TRANSIENT = new Set(["request_failed", "request_timeout", "terminal_invalid"]);

/** One cloud session, two real renderers. It owns no terminal, device or native-agent runtime. */
export class Session extends EventEmitter {
  constructor({ cwd = process.cwd(), env = process.env, origin, noBrowser = false, offline = false, clientFactory = config => new VecteurClient(config) } = {}) {
    super();
    this.cwd = cwd; this.env = env; this.noBrowser = noBrowser; this.clientFactory = clientFactory;
    this.origin = resolveOrigin(env, undefined, origin);
    this.status = "Starting"; this.draft = ""; this.project = null; this.run = null; this.binding = null;
    this.attachments = []; this.model = null; this.closed = false; this.busy = false;
    this.followController = null; this.prompt = null; this.generation = 0;
    this.lifecycle = new AbortController();
    this.offline = offline; this.loginGeneration = 0; this.promptGeneration = 0;
  }

  view(now = Date.now()) {
    const canEdit = this.project?.role !== "VIEWER";
    const activity = !canEdit && this.status === "Waiting for your answer" ? "Waiting for an editor" : this.status;
    this.projectionCache ??= {};
    const projection = runView(this.run, this.projectionCache, now);
    const requested = this.model ?? "auto";
    const modelLabel = MODEL_CATALOGUE.find(row => row.profile_id === requested)?.label
      ?? PRODUCT_ROUTES.find(row => row.route_id === requested)?.label ?? requested;
    const bound = this.binding?.state === "bound" && this.binding.projectId === this.project?.id;
    return { origin: this.origin, folder: bound ? relative(this.binding.folder.path, this.cwd) || "." : this.cwd,
      account: this.account, project: this.project,
      projectLabel: this.project?.name ?? (this.binding ? "Linked Project unavailable" : "New Project on first send"),
      status: activity + (canEdit ? "" : " · Read-only — Viewer") + (projection.terminal ? ` · ${projection.elapsed}` : ""), draft: this.draft, prompt: this.prompt, busy: this.busy,
      offline: this.offline, issue: this.issue, login: this.loginChallenge, release: this.release,
      // First use: signed in and online, the folder resolved to no binding/Project/Run, nothing pending.
      firstUse: !!this.account && !this.offline && !this.busy && !this.project && !this.run && this.status === NEW_FOLDER,
      attachments: this.attachments.map(item => ({ path: item.rel ?? item.path, size: item.size ?? item.bytes.length })),
      egress: this.attachments.length ? `Upload ${this.attachments.map(item => `${item.rel ?? item.path} (${item.size ?? item.bytes.length} B)`).join(", ")} to ${this.project?.name ?? "a new Project"} on ${this.origin}` : null,
      lead: "Laplace", location: "Vecteur cloud", model: modelLabel,
      run: projection, available: { submit: !this.offline && !!this.account && canEdit && !this.busy && !this.run?.open,
        cancel: !this.offline && !!this.account && canEdit && !!this.run?.open, steer: !this.offline && !!this.account && canEdit && !!this.run?.open && !projection.question,
        localExecution: false, nativeAgent: false } };
  }

  change() { if (!this.closed) this.emit("change", this.view()); }
  message(text, kind = "info", extra = {}) { if (!this.closed) this.emit("message", { ...extra, id: randomUUID(), kind, text }); }
  report(error) {
    if (["action_cancelled", "session_closed"].includes(error.code)) { this.status = "Cancelled — draft kept"; this.change(); return; }
    if (AUTH_ERRORS.has(error.code)) this.account = null;
    const recovery = AUTH_ERRORS.has(error.code) ? " — /login; draft and Run kept"
      : TRANSIENT.has(error.code) ? " — /resume; draft and submission identity kept"
        : ["device_expired", "device_denied"].includes(error.code) ? " — /login starts again; draft kept" : "";
    this.status = `${error.code ?? "session_error"}: ${error.message}${recovery}`;
    if (this.issue?.code === error.code) this.issue.count++;
    else this.issue = { code: error.code, text: this.status, count: 1 };
    this.change();
  }

  async choose(title, options, { typed = false, multiple = false, liveTitle } = {}) {
    if (this.prompt) throw new CliError("prompt_busy", "Answer the current question first");
    return new Promise((resolveChoice, reject) => {
      this.prompt = { id: ++this.promptGeneration, title: liveTitle ?? title, card: liveTitle ? title : undefined, options, typed, multiple };
      this.resolvePrompt = answer => { this.prompt = null; this.resolvePrompt = null; this.rejectPrompt = null; this.change(); resolveChoice(answer); };
      this.rejectPrompt = reject;
      this.change();
    });
  }

  cancelPrompt() {
    const reject = this.rejectPrompt;
    this.prompt = null; this.resolvePrompt = null; this.rejectPrompt = null; this.change();
    reject?.(new CliError("action_cancelled", "Action cancelled; draft kept"));
  }

  cancelLogin() {
    this.loginGeneration++; this.loginController?.abort(); this.loginChallenge = null;
  }

  workOffline() {
    this.executor?.stop(); this.execAllowed = false;
    this.cancelLogin(); this.cancelPrompt(); this.followController?.abort(); this.generation++;
    this.offline = true; this.issue = null;
    if (!this.registry) {
      const saved = this.env.VECTEUR_TOKEN ? null : readCredentials(this.env);
      const token = this.signedOut ? null : this.env.VECTEUR_TOKEN ?? saved?.logins?.[this.origin]?.token;
      this.registry = token ? FolderRegistry.forCredential({ origin: this.origin, token, env: this.env, cwd: this.cwd }) : null;
      if (this.registry && !this.draft) this.draft = this.registry.state().draft;
      if (!this.registry) this.unsignedDraft();
    }
    this.status = this.run?.open ? "Offline draft — the cloud Run continues; /resume to reconnect" : "Offline draft — /login when ready";
    this.change();
  }

  answerPrompt(text) {
    if (!this.prompt) return false;
    const { options, typed, multiple } = this.prompt;
    if (multiple) {
      const indices = text.trim().split(/[\s,]+/).map(Number);
      if (indices.some(index => !Number.isInteger(index) || index < 1 || index > options.length)
          || new Set(indices).size !== indices.length) {
        this.message("Enter choice numbers separated by commas, for example 1,3."); return true;
      }
      this.resolvePrompt(indices.map(index => options[index - 1].value)); return true;
    }
    const selected = typed ? text : options[Number(text) - 1]?.value;
    if (selected === undefined) { this.message("Enter one of the numbered choices."); return true; }
    this.resolvePrompt(selected); return true;
  }

  async transition(action) {
    if (this.closed) throw new CliError("session_closed", "Session closed");
    if (this.busy || this.prompt) throw new CliError("session_busy", "Finish the current action first; your draft is kept");
    this.busy = true; this.change();
    try { return await action(); }
    finally { this.busy = false; this.change(); }
  }

  unsignedDraft({ restore = true } = {}) {
    if (this.registry) return;
    this.registry = new FolderRegistry({ origin: this.origin, accountId: UNSIGNED_ACCOUNT, cwd: this.cwd, env: this.env });
    if (this.draft || !restore) this.registry.newDraft();
    else this.draft = this.registry.state().draft;
  }

  initialize(options = {}) { return this.transition(async () => {
    try { return await this.initializeAccount(options); }
    finally { this.loginController = null; }
  }); }

  async initializeAccount({ login = false } = {}) {
    if (this.offline && !login) { this.workOffline(); return; }
    this.cancelLogin(); const generation = this.loginGeneration;
    const controller = new AbortController(); this.loginController = controller;
    const current = () => !this.closed && !this.offline && generation === this.loginGeneration && !controller.signal.aborted;
    this.offline = false; this.issue = null;
    const saved = this.env.VECTEUR_TOKEN ? null : readCredentials(this.env);
    let token = this.signedOut ? null : this.env.VECTEUR_TOKEN ?? saved?.logins?.[this.origin]?.token;
    let transferUnsigned = login;
    if (!isTokenShaped(token)) this.unsignedDraft();
    const publicClient = this.clientFactory({ origin: this.origin, timeout: Math.min(3_000, requestTimeout(this.env)) });
    this.status = "Checking connection"; this.change();
    try { this.release = await publicClient.readiness(controller.signal); }
    catch (error) {
      if (!current()) return;
      if (!this.registry) {
        this.registry = FolderRegistry.forCredential({ origin: this.origin, token, env: this.env, cwd: this.cwd });
        if (this.registry && this.draft) this.registry.newDraft();
        else if (this.registry) this.draft = this.registry.state().draft;
        else this.unsignedDraft({ restore: false });
      }
      throw error;
    }
    if (!current()) return;
    if (!this.release.compatible) throw new CliError("client_outdated",
      `This origin requires ${this.release.requiredVersion || this.release.cli ? `Vecteur CLI ${this.release.requiredVersion ?? this.release.cli.version}` : "a different CLI contract"}. /update checks this installation; /offline keeps your draft.`);
    if (login || !isTokenShaped(token)) {
      this.status = "Sign in to Vecteur"; this.change();
      const action = login ? "login" : await this.choose(`Sign in to ${this.origin}?`, [
        { label: "Sign in through your browser", value: "login" }, { label: "Keep drafting offline", value: "offline" },
      ]);
      if (!current()) return;
      if (action !== "login") { this.workOffline(); return; }
      transferUnsigned = true; this.followController?.abort(); this.generation++; this.account = null;
      try {
        const grant = await publicClient.deviceMint(controller.signal);
        if (!current()) return;
        this.loginChallenge = grant; this.status = "Waiting for browser approval — Esc works offline"; this.change();
        this.message(`Sign in: ${grant.verification_uri_complete}\nCode: ${grant.user_code}`);
        if (shouldOpenBrowser(this.noBrowser, this.env)) {
          void openBrowser(grant.verification_uri_complete).then(ok => {
            if (current() && !ok) { this.status = "Browser could not open — use the approval URL above"; this.change(); }
          });
        }
        const result = await waitForDeviceAuthorization(publicClient, grant, { signal: controller.signal });
        if (!current()) return;
        const previous = saved?.logins?.[this.origin]?.token;
        if (previous) {
          try { await this.clientFactory({ origin: this.origin, token: previous, timeout: requestTimeout(this.env) }).credentialSelfRevoke(controller.signal); }
          catch (error) { if (!AUTH_ERRORS.has(error.code)) throw error; }
          if (!current()) return;
        }
        writeCredentials({ origin: this.origin, token: result.token }, this.env);
        this.env = { ...this.env }; delete this.env.VECTEUR_TOKEN;
        token = result.token; this.signedOut = false;
        this.client = this.clientFactory({ origin: this.origin, token: result.token, timeout: requestTimeout(this.env) });
      } catch (error) { if (!current()) return; throw error; }
      finally { if (generation === this.loginGeneration) { this.loginChallenge = null; this.status = "Loading account"; this.change(); } }
    } else {
      this.followController?.abort(); this.generation++; this.account = null; this.client = this.clientFactory(configuration(this.env, saved, this.origin));
    }
    const previousAccount = this.registry?.accountId ?? this.account?.id;
    let account;
    try { account = await this.client.accountMe(controller.signal); }
    catch (error) {
      if (!current()) return;
      // This cache restores only an account-scoped draft, never authorization or Project data.
      if (!this.registry && (TRANSIENT.has(error.code) || AUTH_ERRORS.has(error.code))) {
        this.registry = FolderRegistry.forCredential({ origin: this.origin, token, env: this.env, cwd: this.cwd });
        if (this.draft && this.registry) this.registry.newDraft();
        else if (this.registry) this.draft = this.registry.state().draft;
        else this.unsignedDraft({ restore: false });
      }
      this.account = null;
      this.status = `${error.code}: offline or unavailable — draft kept; /resume to reconnect`;
      this.change(); throw error;
    }
    if (!current()) return;
    if (account.id === UNSIGNED_ACCOUNT) throw new CliError("account_invalid", "Reserved local draft identity cannot authenticate");
    const unsigned = previousAccount === UNSIGNED_ACCOUNT ? this.registry : null;
    if (previousAccount && previousAccount !== account.id && !(unsigned && transferUnsigned)) {
      clearTimeout(this.draftTimer); this.registry?.saveDraft(this.draft); this.draft = "";
      this.followController?.abort(); this.generation++; this.run = null; this.project = null; this.binding = null; this.attachments = [];
      this.model = null; this.projectName = null; this.lastPrintedRun = null;
    }
    this.account = account;
    this.activeCredential = { kind: this.env.VECTEUR_TOKEN ? 'environment' : 'stored', token };
    const newRegistry = !this.registry || this.registry.accountId !== account.id;
    if (newRegistry) this.registry = new FolderRegistry({ origin: this.origin, accountId: account.id, cwd: this.cwd, env: this.env });
    if (newRegistry && this.draft) {
      if (unsigned && transferUnsigned) unsigned.transferDraftTo(this.registry, this.draft);
      else this.registry.newDraft();
    }
    this.registry.rememberLogin(token);
    this.client.localEnv = this.env;
    try {
      qualify();
      const reports = await withLocalLock(() => reconcileWrites(this.env), this.env);
      for (const report of reports) if (report.remains.length) this.message(`Local save recovery: ${JSON.stringify(report)}`);
    } catch (error) { if (error.code !== 'platform_unqualified') throw error; }

    this.cwd = this.registry.folder.path;
    if (!this.draft) {
      const drafts = this.registry.state().drafts;
      if (newRegistry && new Set(drafts.map(row => row.text)).size > 1) {
        const id = await this.choose("Recover a saved draft", drafts.map(row => ({
          label: `${new Date(row.at).toISOString()} · ${row.text.slice(0, 100)}`, value: row.id,
        })));
        if (!current()) return;
        this.draft = this.registry.selectDraft(id);
      } else this.draft = this.registry.state().draft;
    }
    this.change(); // Publish the account/draft boundary before any more asynchronous reads.
    const projects = await this.client.projectList(controller.signal);
    if (!current()) return;
    this.projects = projects;
    const binding = this.registry.binding(); this.binding = binding;
    this.provenance = "binding";
    if (binding && binding.state !== "bound") {
      this.status = "Folder identity changed — /unlink before relinking"; this.change(); return;
    }
    if (binding) {
      this.project = this.projects.find(project => project.id === binding.projectId) ?? null;
      if (!this.project) { this.status = "Linked Project unavailable — /project or /unlink"; this.change(); return; }
    }
    this.status = this.project ? "Ready" : NEW_FOLDER;
    const pending = this.registry.state();
    if (pending.pendingRun || pending.pendingCreate) {
      this.followController?.abort(); this.generation++; this.run = null;
      if (pending.pendingRun) this.project = this.projects.find(row => row.id === pending.pendingRun.projectId) ?? null;
      this.status = "Submission interrupted — /resume reconciles the same request";
      this.change(); return;
    }
    this.change();
    if (this.project) await this.scanLocalTargets();
    await this.loadNewest();
  }

  async loadNewest() {
    if (this.project) {
      this.followController?.abort(); const generation = ++this.generation;
      const newest = await this.client.projectNewestRun(this.project.id);
      if (this.closed || generation !== this.generation) return;
      if (newest) {
        this.run = { ...newest, open: !newest.terminal };
        if (newest.run_id !== this.lastPrintedRun && newest.ask !== undefined) this.message(newest.ask, "user");
        if (this.run.open) {
          this.status = runView(this.run, this.projectionCache).question ? "Waiting for your answer" : "Running";
          this.change(); void this.follow().catch(error => this.report(error));
        }
        else { this.status = newest.terminal; if (this.announceRun()) await this.announceFooter(this.project.id); this.change(); await this.offerSaves(); }
      } else { this.run = null; this.change(); }
    }
  }

  announceRun(stopOffer = undefined) {
    if (this.lastPrintedRun === this.run?.run_id) return false;
    const options = { stopOffer, origin: this.origin };
    this.message(this.run?.terminal ? humanRun(this.run, options) : runView(this.run).transcript, "answer", { runId: this.run?.run_id, sections: runSections(this.run, options) }); this.lastPrintedRun = this.run?.run_id;
    return true;
  }

  async announceFooter(projectId) {
    const run = this.run;
    let cost;
    try { cost = await this.client.customerCost(projectId); }
    catch { /* A missing cost read is explicitly unavailable, never a guessed amount. */ }
    if (this.run === run && !this.closed) this.message(turnFooter(run, cost), "turn-footer", { run, value: cost });
  }

  recoverDraft() {
    return this.transition(async () => {
      if (!this.registry) throw new CliError("login_required", "Use /login before recovering saved drafts");
      clearTimeout(this.draftTimer); this.registry.saveDraft(this.draft);
      const drafts = this.registry.state().drafts;
      if (!drafts.length) { this.message("No saved drafts."); return; }
      const id = await this.choose("Recover a saved draft", drafts.map(row => ({
        label: `${new Date(row.at).toISOString()} · ${row.text.slice(0, 100)}`, value: row.id,
      })));
      this.draft = this.registry.selectDraft(id); this.change();
    });
  }

  setDraft(text) {
    this.draft = text;
    clearTimeout(this.draftTimer);
    if (this.registry) this.draftTimer = setTimeout(() => {
      try { this.registry.saveDraft(this.draft); } catch (error) { this.report(error); }
    }, 200);
    this.change();
  }

  async ensureProject(consent = undefined) {
    if (!this.account) throw new CliError("login_required", "Sign in with /login; your draft is kept");
    if (this.project) return this.project;
    if (this.registry.binding()) throw new CliError("binding_unavailable", "Resolve the existing binding with /project or /unlink");
    if (this.registry.broadRoot() && !this.registry.state().pendingCreate) {
      const answer = await this.choose(`Starting here links this ${this.registry.broadRoot()} and its descendants. Type ${this.cwd} to confirm, or leave blank to cancel.`, [], { typed: true });
      if (answer !== this.cwd) throw new CliError("binding_cancelled", "Broad directory binding was not confirmed");
    }
    let workspace = this.account.workspaces[0]?.id;
    if (!workspace) throw new CliError("workspace_unavailable", "Create a Workspace in the web app first");
    if (this.account.workspaces.length > 1 && !this.registry.state().pendingCreate) {
      workspace = await this.choose("Choose the Workspace for this Project", this.account.workspaces.map(row => ({ label: row.name, value: row.id })));
    }
    const pending = this.registry.reserveCreation(this.projectName ?? basename(this.cwd), workspace);
    const project = pending.projectId ? await this.client.projectGet(pending.projectId)
      : await this.client.projectCreate(pending.name, pending.workspaceId, undefined, pending.key);
    if (!pending.projectId) await withAdmissionLock(() => {
      if(consent)checkConsent(this.localPin(),consent.epoch,this.env);
      // /exec consent given before this first send has no Project yet and completeCreation ends folder grants:
      // re-issue it for the new Project only if the consented generation is still live (revoke/relink stay fatal).
      const carry = this.execGrant?.projectId === undefined && this.execGrant;
      if (carry) checkGrantLive(carry, this.localPin(), this.env);
      this.registry.completeCreation(pending.key, project.id);
      if(consent)consent.epoch=prepareConsent(this.localPin(),this.env);
      if (carry) this.execGrant = executionGrant({ ...this.localPin(), projectId: project.id, role: project.role }, this.env);
    },this.env);
    this.project = project; this.binding = this.registry.binding(); this.provenance = "binding";
    return project;
  }

  /** v5 §2.5 explicit Produce: sends one ask whose named specialist child the host starts before Engineering's turn; its
   * rows carry the specialist's label. `produceIntent` owns the grammar and the closed entries. */
  produce(argument) {
    const { ask, intent } = produceIntent(argument);
    return this.submit(ask, intent);
  }

  async submit(text = this.draft, intent = undefined) {
    if (this.busy) throw new CliError("session_busy", "The current submission is still being reconciled");
    if (!text.trim()) return;
    if (this.offline || !this.account) {
      this.setDraft(text);
      const action = await this.choose("Sign in to send this ask. Your draft will not be sent automatically.", [
        { label: "Continue in browser", value: "login" }, { label: "Keep drafting offline", value: "offline" },
      ]);
      if (action === "login") await this.initialize({ login: true }); else this.workOffline();
      return;
    }
    if (this.run?.open) {
      this.setDraft(text); const run = this.run;
      const action = await this.choose("This Run is still working", [
        { label: "Keep drafting the next question", value: "draft" }, { label: "Send as steering to this Run", value: "steer" },
      ]);
      if (action === "steer" && this.run === run && run.open) await this.steer(text);
      return;
    }
    this.setDraft(text);
    this.registry?.saveDraft(text);
    const draftRef = structuredClone(this.registry?.draftRef ?? null);
    this.busy = true; this.status = "Submitting"; this.change();
    try {
      if (this.execPending || this.registry?.state().pendingRun) throw new CliError("submission_pending", "Use /resume to resolve the interrupted submission; your new draft is kept");
      if (this.project?.role === 'VIEWER') throw new CliError('role_forbidden', 'Editor access is required to ask Vecteur');
      if (await this.offerAttachments(text) === false) { this.status = 'Draft kept — named files not offered'; return; }
      const consentAccount=this.account.id;
      const destination = { origin: this.origin, id: this.project?.id, name: this.project?.name ?? this.projectName ?? basename(this.cwd) };
      let consent = false;
      if (this.attachments.some(f => !f.generated)) {
        const grant = this.project && currentGrant(this.localPin(), this.env);
        if (!grant) {
          const epoch=await withLocalLock(()=>prepareConsent(this.localPin(),this.env),this.env);
          if(await this.confirmFiles(destination))consent={epoch};
          if (!consent) { this.status = 'Draft kept — files not uploaded'; return; }
        }
      }
      const project = await this.ensureProject(consent || undefined);
      if (project.role === "VIEWER") throw new CliError("role_forbidden", "Editor access is required to ask Vecteur");
      if (this.attachments.some(f => !f.generated) && consent && (destination.origin !== this.origin || (destination.id ? destination.id !== project.id : destination.name !== project.name))) {
        if (!await this.confirmFiles({ origin: this.origin, id: project.id, name: project.name })) return;
      }
      if (this.execAllowed === undefined) await this.execConsent("on");
      const executor = await withAdmissionLock(async () => {
        const newest = await this.client.projectNewestRun(project.id);
        const checkDestination=()=>{
          if(this.project?.id!==project.id || this.origin!==destination.origin || this.account?.id!==consentAccount) throw new CliError('grant_changed','Upload destination changed; draft kept');
        };
        checkDestination();
        if (newest && !newest.terminal) {
          this.run = { ...newest, open: true };
          throw new CliError("run_busy", "Another terminal has an open Run. Following it; your draft is kept.");
        }
        const selections = [];
        let grant;
        if (this.attachments.some(f => !f.generated)) {
          grant = currentGrant(this.localPin(), this.env);
          if (!grant) { if (!consent) throw new CliError('grant_changed', 'Permission changed; confirm files again'); grant = createGrant(this.localPin(), this.env, consent.epoch); }
        }
        for (const item of this.attachments) {
          checkDestination();
          if (!item.generated) pinCheck(grant, this.localPin(), this.env);
          if (item.generation !== undefined && item.generation !== grant.generation) throw new CliError('grant_changed', 'Selection withdrawn; select it again');
          const file = item.generated ? {rel:basename(item.path),bytes:item.bytes,size:item.bytes.length,media:item.media} : readConfined(grant, item.rel, this.env, { selected: item });
          if (!item.generated) pinCheck(grant, this.localPin(), this.env);
          this.message(`Upload ${file.rel} (${file.size} B) to ${project.name} on ${this.origin}`);
          item.source = await this.client.inputAdd(project.id, file.bytes, file.media);
          checkDestination();
          if (!item.generated) recordUpload(grant, file, item.source, this.env);
          const offer = item.source.offer ?? await this.client.inputOffer(project.id, item.source);
          if (!offer.extracts.length) throw new CliError("extraction_unavailable", "This file has no selectable extracts");
          selections.push({ source_handle: { cas_ref: item.source.cas_ref, acquisition_ref: item.source.acquisition_ref },
            offer_id: offer.id, selected_extract_ids: offer.extracts.map(extract => extract.id).sort(), method: "exact-extract" });
        }
        selections.sort((a, b) => a.source_handle.cas_ref.localeCompare(b.source_handle.cas_ref)
          || a.source_handle.acquisition_ref.localeCompare(b.source_handle.acquisition_ref));
        const body = { ask: text, attachments: selections.map(item => item.source_handle),
          parent_state_hash: newest?.state_hash ?? null, ui_context: { layout: 'folder' },
          ...(selections.length ? { selections } : {}), ...(this.model ? { model_choice: this.model } : {}),
          ...(intent === undefined ? {} : { intent }) };
        this.executor?.stop(); this.executor = null;
        if (this.execAllowed) {
          const pin = this.localPin();
          const grant = this.execGrant;
          pinCheck(grant, pin, this.env, { execution: true });
          this.executor = new Executor({ client: this.client, grant, pin: () => this.localPin(), env: this.env,
            session: this.execSessionPolicy ?? false, approve: ({ command, timeout, folder, signal }) => {
              const prompt = this.choose(
              `Run on this computer in ${JSON.stringify(folder)} (${timeout}s)?\n${commandDisplay(command)}`, [
                { label: "Allow once", value: "once" }, { label: "Allow for this session", value: "session" }, { label: "Decline", value: "decline" }], { liveTitle: `Run this bash command (${timeout}s)?` });
              const id = this.prompt?.id;
              const cancel = () => { if (id === this.prompt?.id) this.cancelPrompt(); };
              signal.addEventListener('abort', cancel, { once: true });
              return prompt.finally(() => signal.removeEventListener('abort', cancel));
            } });
          body.local_exec = this.executor.descriptor;
        }
        const pending = this.executor ? (this.execPending = { projectId: project.id, body, key: randomUUID() })
          : this.registry.reserveRun(project.id, body, draftRef);
        return this.admitPendingLocked(pending);
      }, this.env);
      this.startExecutor(executor);
      void this.follow().catch(error => this.report(error));
    } catch(error) {
      if(['state_busy','state_fork'].includes(error.code)) await this.loadNewest();
      else if(error.code==='run_busy' && this.run?.open) void this.follow().catch(error=>this.report(error));
      throw error;
    } finally { this.busy = false; this.change(); }
  }

  async admitPending(pending) {
    let executor;
    try { executor = await withAdmissionLock(() => this.admitPendingLocked(pending), this.env); }
    catch(error) { if(['state_busy','state_fork'].includes(error.code)) await this.loadNewest(); throw error; }
    this.startExecutor(executor);
    void this.follow().catch(error=>this.report(error));
  }

  async admitPendingLocked(pending) {
    const ephemeral = pending === this.execPending;
    if (!ephemeral && pending.body?.local_exec !== undefined) throw new CliError('admission_unresolved', 'Saved execution consent expired; observe the Project history');
    if (this.project?.id !== pending.projectId) {
      const project = await this.client.projectGet(pending.projectId);
      this.followController?.abort(); this.generation++; this.run = null; this.project = project; this.change();
    }
    if (ephemeral) {
      if (!this.executor) throw new CliError("admission_unresolved", "Executor consent ended; reconcile through Project history");
      this.executor.check();
    }
    let ack;
    try { ack = await this.client.runAdmit(pending.projectId, pending.body, pending.key); }
    catch (error) {
      if (["state_busy", "state_fork"].includes(error.code) || error.admission === "refused") {
        if (ephemeral) { this.execPending = null; this.executor?.stop(); }
        else this.registry.rejectRunAdmission(pending.key);
      }
      if (["state_busy", "state_fork"].includes(error.code)) {
        throw new CliError(error.code, "Submission refused; draft kept. Review the latest Run and explicitly send again.");
      }
      // The owner marked this key as never admittable (nothing dispatched): release only this
      // reservation and keep the draft. Any other failure stays pending for /resume.
      if (error.admission === "refused") {
        if (error.code === "produce_unavailable") throw new CliError(error.code, `${error.message}. Draft kept.`);
        throw new CliError(error.code, "Submission refused before it ran; draft kept. Fix it and send again.");
      }
      throw error;
    }
    if (!ephemeral) this.registry.finishRunAdmission(pending.key);
    this.execPending = null;
    if (this.draft === pending.body.ask) { clearTimeout(this.draftTimer); this.draft = ""; }
    this.attachments = [];
    this.message(pending.body.ask, "user");
    this.run = { ...ack, ask: pending.body.ask, controls: [], events: [], terminal: "", open: true };
    this.status = "Running"; this.change();
    return ephemeral ? this.executor : null;
  }

  startExecutor(executor) {
    if (executor) {
      this.execPump = executor.pump(this.run.run_id).catch(error => {
        executor.stop();
        if (this.executor === executor) { this.execAllowed = false; this.execGrant = null; this.report(error); }
      });
    }
  }

  async resume() {
    if (this.offline) { this.offline = false; return this.initialize(); }
    if (this.busy) throw new CliError("session_busy", "This submission is already being reconciled");
    if (!this.account || !this.registry) return this.initialize();
    await withAdmissionLock(() => reconcileAdmissions(this.client, this.origin, this.env), this.env);
    const state = this.registry.state();
    if (this.execPending) return this.admitPending(this.execPending);
    if (state.pendingRun) {
      this.busy = true; this.change();
      try { return await this.admitPending(state.pendingRun); }
      finally { this.busy = false; this.change(); }
    }
    if (state.pendingCreate) return this.submit();
    if (this.run?.open) { void this.follow().catch(error => this.report(error)); return; }
    return this.initialize();
  }

  async follow() {
    this.followController?.abort();
    const controller = new AbortController(); this.followController = controller;
    const run = this.run, executor = this.executor; const generation = ++this.generation;
    const projectId = this.project.id;
    let attempts = 0, quiet = 0;
    // Read independently of SSE activity: a quiet/waiting Run can receive controls in another terminal.
    let controlTimer, controlFailures = 0, controlState = "available";
    const current = () => !controller.signal.aborted && generation === this.generation && this.run === run && run.open;
    const refreshControls = async () => {
      let interval = 3000, permanent = false;
      try {
        const controls = await this.client.runControls(run.run_id, controller.signal);
        if (!current()) return;
        if (controlState !== "available") this.message("Controls available — live updates restored.");
        controlState = "available"; controlFailures = 0;
        if (JSON.stringify(run.controls) !== JSON.stringify(controls)) { run.controls = controls; this.change(); }
      } catch (error) {
        if (!current()) return;
        const transient = ["request_failed", "request_timeout", "http_429"].includes(error.code)
          || /^http_5\d\d$/.test(error.code) || error.status === 429 || error.status >= 500;
        permanent = !transient;
        interval = Math.min(1000 * 2 ** controlFailures++, 15000);
        const state = `${permanent ? "unavailable" : "retrying"}:${error.code}`;
        if (state !== controlState) this.message(`Controls unavailable (${error.code}) — ${permanent ? "live updates stopped" : "retrying"}.`);
        controlState = state;
      }
      if (current() && !permanent) controlTimer = setTimeout(refreshControls, interval);
    };
    void refreshControls();
    controller.signal.addEventListener("abort", () => clearTimeout(controlTimer), { once: true });
    try {
      while (!this.closed && generation === this.generation && run?.open) {
        try {
          const direct = await this.client.runEvents(run.run_id, event => {
            if (generation !== this.generation) return;
            quiet = 0; run.events.push(event);
            this.status = runView(run, this.projectionCache).question ? "Waiting for your answer" : "Running";
            this.change();
          }, controller.signal, [...run.events]);
          if (generation !== this.generation) return;
          this.run = { ...direct, accepted_at: direct.run_id === run.run_id ? run.accepted_at : undefined, ask: run.ask, open: !direct.terminal };
          const stopped = direct.terminal ? stopViewOf(direct.events) : null;
          const stopOffer = stopped ? await this.client.stopOffer(direct.run_id, controller.signal) : undefined;
          if (generation !== this.generation) return;
          if (stopped?.cause === "plan_limit") void this.client.stopEvent(direct.run_id, { event: "shown", surface: "cli" });
          this.status = stopped ? "Paused at a limit" : direct.terminal; this.announceRun(stopOffer);
          await this.announceFooter(projectId);
          this.change(); await this.offerSaves().catch(error=>this.report(error)); return;
        } catch (error) {
          if (controller.signal.aborted || this.closed || generation !== this.generation) return;
          if (AUTH_ERRORS.has(error.code)) { this.report(error); return; }
          // The SSE request rotates at its time bound even during a healthy clarification park.
          // The independent authenticated pump owns executor liveness; a poll failure stops it.
          // A stream that rotates MAX_QUIET_ROTATIONS times in a row without one event is wedged, not parked.
          if (error.code === "request_timeout" && executor && !executor.closed) {
            if (++quiet > MAX_QUIET_ROTATIONS) throw new CliError("event_stream_stalled", "The Run's event stream delivered nothing for too long; local execution stopped. /resume to reconnect.");
            attempts = 0;
          }
          else { this.executor?.stop(); this.execAllowed = false; }
          if (!TRANSIENT.has(error.code) || ++attempts > 5) throw error;
          this.status = "Connection lost — reconnecting to the same Run"; this.change();
          await delay(Math.min(500 * 2 ** attempts, 8_000), controller.signal);
        }
      }
    } finally {
      executor?.stop();
      if (this.executor === executor) {
        this.execSessionPolicy = executor?.session ?? false;
        this.executor = null;
      }
      clearTimeout(controlTimer); controller.abort();
    }
  }

  attach(path) { return this.transition(() => this.selectAttachment(path)); }

  async execConsent(argument) {
    if (argument === "off") {
      this.execAllowed = false; this.execGrant = null; this.execSessionPolicy = false; this.executor?.stop('executor_revoked');
      this.message("Local execution revoked."); return;
    }
    if (argument !== "on") throw new CliError("usage_invalid", "Use /exec on or /exec off");
    qualify();
    const pin = this.localPin();
    const granted = await this.choose(`Allow Vecteur to run commands in ${pin.root.path}? Commands have your OS permissions, including network access and writes outside this folder. Only scanned output tails return to Vecteur.`,
      [{ label: "Allow, ask before each command", value: true }, { label: "No", value: false }]);
    this.execAllowed = granted;
    if (granted) this.execGrant = await withLocalLock(() => {
      if (this.project?.id !== pin.projectId || this.account?.id !== pin.accountId) throw new CliError("grant_changed", "Destination changed");
      return executionGrant(pin, this.env);
    }, this.env);
  }

  localPin() {
    return { origin: this.origin, accountId: this.account?.id, projectId: this.project?.id, role: this.project?.role,
      root: this.registry.folder, provenance: this.provenance ?? 'binding', binding: () => this.registry.binding(),
      credential: this.activeCredential ?? { kind: this.env.VECTEUR_TOKEN ? 'environment' : 'stored', token: this.env.VECTEUR_TOKEN ?? readCredentials(this.env)?.logins?.[this.origin]?.token } };
  }

  fileConsentText(destination) {
    const project = destination.id ? destination.name : `a new Project named ${destination.name}`;
    return `Allow Vecteur to read files you select in ${this.registry.folder.path} and save new files it makes there? Files you select upload to ${project} on ${destination.origin}; their content reaches this Run's model provider route; local residency is not guaranteed.`;
  }

  async confirmFiles(destination) {
    const files = this.attachments.filter(f=>!f.generated);
    return this.choose(`${this.fileConsentText(destination)}\nSend ${files.length} selected file${files.length===1?'':'s'}?\n${files.map(f=>`[x] ${f.rel} (${f.size} B)`).join('\n')}`, [
      { label: 'Yes, allow select and save-new', value: true }, { label: 'No, keep draft and selections', value: false },
    ], { liveTitle: `Send ${files.length} selected file${files.length===1?'':'s'}?` });
  }

  async selectAttachment(path) {
    if (this.project?.role === 'VIEWER') throw new CliError('role_forbidden', 'Editor access is required to select upload files');
    if (this.registry?.state().pendingRun) throw new CliError('submission_pending', 'Resolve the pending submission before changing its files');
    if (!this.registry) this.unsignedDraft();
    const rel = isAbsolute(path) ? relative(this.registry.folder.path, path) : path;
    const item = selectionMetadata(this.registry.folder, rel, this.env);
    if (this.attachments.some(f => f.rel === item.rel)) return;
    if (this.attachments.length >= 8 || this.attachments.reduce((sum, f) => sum + f.size, item.size) > 32 * 1024 * 1024) throw new CliError('attachments_full', 'Select at most 8 files and 32 MiB per turn');
    const grant = this.project && currentGrant(this.localPin(), this.env);
    this.attachments.push({ ...item, ...(grant ? { generation: grant.generation } : {}) });
    this.message(`Upload ${item.rel} (${item.size} B) to ${this.project?.name ?? 'a new Project'} on ${this.origin} · on send`);
    this.change();
  }

  async completeFiles(prefix) {
    if (!this.registry) this.unsignedDraft();
    return discover(this.registry.folder, this.env, prefix).map(f => f.rel);
  }

  async offerAttachments(text) {
    const mentions = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map(m => m[1]);
    for (const rel of mentions) await this.selectAttachment(rel);
    const words = [...new Set(text.split(/\s+/).filter(w => w && !w.startsWith('@')))];
    if (!words.length) return;
    let files = [];
    try { files = discover(this.registry.folder, this.env); }
    catch (e) {
      this.message(`File offers were unavailable (${e.code ?? 'discovery_failed'}); continuing without filename offers.`);
    }
    const notices = new Set(), blocked = new Set();
    const notice = (name, code) => {
      if (!notices.has(name)) this.message(`${name}: not offered (${code})`);
      notices.add(name);
    };
    const selected = this.attachments.map(f => f.rel);
    for (const name of words) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name) || selected.includes(name.replace(/^\.\//,''))) continue;
      try {
        // Discovery intentionally hides excluded and non-regular entries. Check an
        // explicitly named path through the same metadata-only selection boundary.
        const file = selectionMetadata(this.registry.folder, name, this.env, { ifPresent: true });
        if (!files.some(f=>f.rel===file.rel)) files.push(file);
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        if (!['excluded','path_excluded','outside_folder','symlink_refused','not_regular_file','hardlink_refused','attachment_invalid','ignore_policy_unknown'].includes(e.code)) throw e;
        notice(name, e.code === 'excluded' ? 'path_excluded' : e.code); blocked.add(name);
      }
    }
    let offers = 0;
    for (const name of words.filter(w=>!blocked.has(w))) {
      const matches = nameOffers(name, files, this.attachments.map(f=>f.rel))[0];
      if (!matches) continue;
      const grant = this.project && currentGrant(this.localPin(), this.env);
      const safe = [];
      for (const file of matches) {
        try {
          // Without a grant, offer metadata only. The common first-use card in
          // submit must be accepted before the selected content is read/scanned.
          if (grant) await withLocalLock(() => {
            pinCheck(grant, this.localPin(), this.env);
            // This preflight only decides the offer; upload rereads and rechecks
            // the selection under the same grant before any network egress.
            readConfined(grant, file.rel, this.env, { selected: file });
            pinCheck(grant, this.localPin(), this.env);
          }, this.env);
          safe.push(file);
        } catch (e) {
          if (!['secret_suspected','scan_unsupported','excluded','path_excluded','outside_folder','symlink_refused','not_regular_file','hardlink_refused','attachment_invalid','attachment_changed'].includes(e.code)) throw e;
          notice(matches.length === 1 ? name : file.rel, e.code === 'excluded' ? 'path_excluded' : e.code);
        }
      }
      if (!safe.length || offers >= 3) continue;
      offers++;
      if (safe.length === 1) {
        const file = safe[0];
        if (await this.choose(`Attach ./${file.rel} (${file.size} B)? [y/N]`, [{label:'Yes',value:true},{label:'No',value:false}])) await this.selectAttachment(file.rel);
      } else {
        const rel = await this.choose('Ambiguous filename — choose a file to attach', [...safe.map(f => ({label:`./${f.rel} (${f.size} B)`,value:f.rel})),{label:'Do not attach',value:null}]);
        if (rel) await this.selectAttachment(rel);
      }
    }
    if (notices.size) return this.choose('Send without these files?', [
      {label:'Yes, send without these files',value:true}, {label:'No, keep draft',value:false},
    ]);
  }

  async revokeFiles() {
    this.executor?.stop(); this.execAllowed = false;
    this.requireLogin();
    return withLocalLock(() => {
      endGrants({origin:this.origin,accountId:this.account.id,root:this.registry.folder.path},this.env);
      this.saveProposal = null;
      this.message('Local file permission revoked; pending selections need fresh consent.');
    }, this.env);
  }

  async scanLocalTargets() {
    try {
      qualify();
      return await withLocalLock(()=>{
        const pin = this.localPin(), grant = currentGrant(pin,this.env);
        if (!grant) return proposals(pin,this.env);
        pinCheck(grant,pin,this.env);
        const reports = observeTargets(grant,this.env,pin);
        for (const row of reports) this.message(`${terminalText(row.path)}: ${row.code}, local observation unavailable`);
        return proposals(grant,this.env);
      },this.env);
    } catch (error) {
      this.message(`${error.code}: local observation unavailable; cloud files remain available.`);
      return [];
    }
  }

  async confirmLocalRead(project, epoch) {
    const prepared = epoch ?? await withLocalLock(()=>prepareConsent(this.localPin(),this.env),this.env);
    const answer = (await this.choose(`${this.fileConsentText({origin:this.origin,id:project.id,name:project.name})}\nEnter yes to allow local reads · n no`, [], {typed:true})).trim().toLowerCase();
    if (!['','y','yes'].includes(answer)) return null;
    return withLocalLock(()=>{
      if (this.project!==project) throw new CliError('grant_changed','Diff destination changed');
      const grant=createGrant(this.localPin(),this.env,prepared);
      return pinCheck(grant,this.localPin(),this.env);
    },this.env);
  }

  async listFiles() {
    const rows = artifactRows(runView(this.run).artifacts);
    const saved = this.account && this.project ? await this.scanLocalTargets() : [];
    this.message([
      ...this.attachments.map(item=>`Pending: ${terminalText(item.rel ?? item.path)} (${item.size ?? item.bytes.length} bytes; not uploaded)`),
      ...rows.map(({artifact:a,number,sameBytesAs})=>`${number}. ${terminalText(a.path ?? a.filename)} · ${a.kind} · /download ${number} · /files diff ${number}${sameBytesAs?` · same bytes as ${sameBytesAs}`:''} · /web`),
      ...saved.map((p,i)=>`${rows.length+i+1}. Proposal ${terminalText(p.path)} → ${terminalText(p.originalPath)} · /files diff ${rows.length+i+1}`),
    ].join('\n') || 'No selected files or artifacts.');
  }

  async fileDiff(number) {
    this.requireLogin();
    if (!this.project) throw new CliError('project_unavailable','Choose a Project first');
    const project=this.project, rows=artifactRows(runView(this.run).artifacts);
    const saved=await this.scanLocalTargets();
    const row=rows.find(r=>r.number===number), proposal=saved[number-rows.length-1];
    const a=row?.artifact ?? (proposal && {path:proposal.originalPath,cas_ref:proposal.cas_ref,kind:'code'});
    if (!a?.path) throw new CliError('artifact_unavailable','Choose a file number from /files');
    // Historical proposals retain their artifact kind in the scoped journal.
    const kind=row?.artifact.kind ?? proposal.kind;
    let grant=await withLocalLock(()=>{
      const live=currentGrant(this.localPin(),this.env);
      return live ? pinCheck(live,this.localPin(),this.env) : null;
    },this.env);
    grant ??= await this.confirmLocalRead(project);
    if (!grant) return;
    const bytes=await downloadLocalArtifact(sink=>this.client.artifactGet(a.cas_ref,project.id,sink),{...a,kind});
    const snapshot=await withLocalLock(()=>{
      if(this.project!==project)throw new CliError('grant_changed','Diff destination changed');
      return inspectTarget(grant,a.path,a.cas_ref.slice(7),this.env,this.localPin());
    },this.env);
    this.message(proposalReview(a.path,snapshot,bytes));
  }

  async offerSaves(number) {
    if (!this.account || !this.project || !this.run?.terminal || this.project.role === 'VIEWER') return;
    try { qualify(); } catch (e) { if (number) throw e; return; }
    const run = this.run, project = this.project;
    if ((await this.client.projectNewestRun(project.id))?.run_id !== run.run_id) return;
    if (this.project !== project || this.run !== run) throw new CliError('grant_changed','Save destination changed');
    const grant = currentGrant(this.localPin(), this.env);
    const provisional = grant ?? { ...this.localPin(), generation: null };
    const candidates = [], selected = new Set();
    const normalize = (row, snapshot) => {
      row.snapshot=snapshot;
      row.creates=snapshot.creates;
      row.proposalPath=snapshot.exists?proposalName(row.artifact.path,run.run_id,row.artifact.revision):null;
      row.eligible=snapshot.classification!=='already identical'
        && (snapshot.exists || !!number || !tombstoned(provisional,row.artifact.path,this.env));
      if(!row.eligible) {
        selected.delete(row);
        if(snapshot.classification==='already identical')this.message(`${terminalText(row.artifact.path)}: already identical`);
      }
      return row.eligible;
    };
    for (const row of artifactRows(runView(run).artifacts)) {
      const a = row.artifact;
      if (!a.path || number && row.number !== number) continue;
      try {
        const eligible=await withLocalLock(()=>normalize(row,grant
          ? inspectTarget(grant,a.path,a.cas_ref.slice(7),this.env,this.localPin())
          : observeTargetMetadata(provisional,a.path,this.env)),this.env);
        if(!eligible)continue;
        if (row.snapshot.exists) {
          row.bytes=await downloadLocalArtifact(sink=>this.client.artifactGet(a.cas_ref,project.id,sink),a);
          if(grant) await withLocalLock(()=>pinCheck(grant,this.localPin(),this.env),this.env);
        }
        candidates.push(row);
      } catch (e) { this.message(`${a.path}: ${e.code}, not written · /download ${row.number}`); }
    }
    const current = candidates; // runArtifacts already owns current-revision selection.
    if (!current.length) return;
    for (const row of [...current].sort((a,b) => a.artifact.path.length-b.artifact.path.length || a.artifact.path.localeCompare(b.artifact.path))) if (![...selected].some(r => r.artifact.cas_ref === row.artifact.cas_ref)) selected.add(row);
    const proposal = { runId: run.run_id, projectId:project.id, generation: grant?.generation ?? null, rows:current.map(row => ({ ...row, artifact:structuredClone(row.artifact) })) };
    this.saveProposal = proposal;
    const epoch = !grant ? await withLocalLock(()=>prepareConsent(this.localPin(),this.env),this.env) : null;
    const rowLabel=row=>{
      const a=row.artifact;
      const evidence=run.events.flatMap(e=>e.kind==='tool_result'?e.payload?.files_changed??[]:[])
        .find(f=>f.path===a.path && 'sha256:'+f.sha256.replace(/^sha256:/,'')===a.cas_ref);
      return terminalText(`${selected.has(row)?'[x]':'[ ]'} ${a.path}${evidence?.bytes===undefined?'':` (${evidence.bytes} B)`}${row.creates.length?` · creates ${row.creates.map(p=>p+'/').join(', ')}`:''}${row.proposalPath?` · ${row.snapshot.classification ?? 'comparison after local read consent'} · save beside it as ${row.proposalPath}`:''}`)
        +(row.snapshot.classification==='local changed'?`\nyou changed ${terminalText(a.path)} since Vecteur read it; your edit is kept`:row.snapshot.classification==='first sync'?'\nVecteur has no earlier version of this file from you':'');
    };
    let live=grant;
    while (true) {
      if(live) await withLocalLock(()=>pinCheck(live,this.localPin(),this.env),this.env);
      const paths = [...selected].map(row => row.artifact.path);
      if (!paths.length) break;
      const beside=[...selected].some(r=>r.proposalPath);
      const question=beside && selected.size===1 ? `${terminalText(paths[0])} exists here. Save Vecteur's version beside it as ${terminalText([...selected][0].proposalPath)}?` : `Save ${paths.length} new file${paths.length===1?'':'s'} to ${terminalText(this.cwd)}?`;
      const answer = (await this.choose(`${!live?this.fileConsentText({origin:this.origin,id:project.id,name:project.name})+'\n':''}${question} Enter yes · d ${beside?'diff':'show'} · n no\n${current.filter(r=>r.eligible && !r.written).map(rowLabel).join('\n')}`, [], {typed:true,liveTitle:`${beside&&selected.size===1?'Save beside':'Save '+paths.length}? Enter yes · d ${beside?'diff':'show'} · n no`})).trim().toLowerCase();
      if (answer === 'n' || answer === 'no') { this.saveProposal=null; return; }
      if (answer === 'd') {
        if(!live) {
          live=await this.confirmLocalRead(project,epoch);
          if(!live){this.saveProposal=null;return;}
          proposal.generation=live.generation;
        }
        await withLocalLock(()=>{
          for(const row of selected) {
            normalize(row,inspectTarget(live,row.artifact.path,row.artifact.cas_ref.slice(7),this.env,this.localPin()));
            if(row.bytes)this.message(proposalReview(row.artifact.path,row.snapshot,row.bytes));
          }
        },this.env);
        if(current.length===1 && beside)continue;
        const eligible=current.filter(r=>r.eligible && !r.written);
        if(!eligible.length)break;
        const choices = await this.choose('Every candidate (choose numbers separated by commas)', eligible.map(row=>({label:rowLabel(row),value:row})),{multiple:true});
        selected.clear(); for (const row of choices) if(eligible.includes(row))selected.add(row); continue;
      }
      if (!['','y','yes'].includes(answer)) { this.message('Enter yes, d or n.'); continue; }
      await withLocalLock(()=>{
      if(this.project!==project || this.run!==run)throw new CliError('grant_changed','Save proposal withdrawn');
      live=currentGrant(this.localPin(),this.env);
      if(proposal.generation===null){
        if(live)throw new CliError('grant_changed','Permission changed during confirmation; review again');
        live=createGrant(this.localPin(),this.env,epoch);proposal.generation=live.generation;
      }
    },this.env);
    if (!live || live.generation !== proposal.generation || this.project.id !== proposal.projectId) throw new CliError('grant_changed','Save proposal withdrawn; confirm again');
    if([...selected].some(row=>row.snapshot.exists && !row.snapshot.classification)) {
      await withLocalLock(()=>{
        for(const row of selected)normalize(row,inspectTarget(live,row.artifact.path,row.artifact.cas_ref.slice(7),this.env,this.localPin()));
      },this.env);
      continue;
    }
    for (const row of selected) {
      const artifact = proposal.rows.find(r => r.number===row.number).artifact;
      try {
        const writer=row.proposalPath?writeProposalConfined:writeNewConfined;
        const fetch=row.bytes?async sink=>{sink(row.bytes);return {bytes:row.bytes.length,content_type:ARTIFACT_MEDIA_TYPES[artifact.kind]};}:sink=>this.client.artifactGet(artifact.cas_ref,project.id,sink);
        const saved = await writer(live, artifact.path, fetch, { ...artifact, runId:proposal.runId }, {env:this.env,pin:()=>this.localPin(),head:id=>this.client.projectNewestRun(id),approval:{rel:artifact.path,exists:row.snapshot.exists,sha256:row.snapshot.sha256}});
        this.message(terminalText(`Saved ${relative(this.cwd,saved.path)} (${saved.bytes} B)`));
        if(row.proposalPath)this.message(terminalText(adoptionHint(relative(this.cwd,saved.path),artifact.path)));
        row.written=true;selected.delete(row);
      } catch(e) {
        if(e.code!=='target_changed')throw e;
        this.message(e.message);
        await withLocalLock(()=>normalize(row,inspectTarget(live,artifact.path,artifact.cas_ref.slice(7),this.env,this.localPin())),this.env);
        if(!row.eligible)continue;
        row.bytes ??= await downloadLocalArtifact(sink=>this.client.artifactGet(artifact.cas_ref,project.id,sink),artifact);
        await withLocalLock(()=>{
          normalize(row,inspectTarget(live,artifact.path,artifact.cas_ref.slice(7),this.env,this.localPin()));
          if(row.eligible)this.message(proposalReview(artifact.path,row.snapshot,row.bytes));
        },this.env);
        break;
      }
    }
    }
    this.saveProposal = null;
  }

  link(options = {}) { return this.transition(() => this.selectProject(options)); }

  async selectProject({ persist = true } = {}) {
    const state = this.registry.state();
    if (state.pendingCreate || state.pendingRun) throw new CliError("operation_unresolved", "Use /resume before changing Project; the pending request keeps its original Project");
    if (this.run?.open) throw new CliError("run_busy", "Detach or finish the current Run before changing Project");
    this.projects = await this.client.projectList();
    if (this.closed) return;
    if (!this.projects.length) throw new CliError("project_unavailable", "No Projects yet; send an ask to create one");
    const id = await this.choose("Choose an existing Project", this.projects.map(row => ({ label: `${row.name} (${row.role})`, value: row.id })));
    if (this.closed) return;
    const project = this.projects.find(row => row.id === id);
    await withAdmissionLock(async () => {
      if (this.project?.id !== id) endGrants({origin:this.origin,accountId:this.account.id,root:this.registry.folder.path},this.env);
      if (persist) {
        try { this.registry.bind(id); }
        catch (error) {
          if (!["home_binding_confirmation", "root_binding_confirmation"].includes(error.code)) throw error;
          const answer = await this.choose(error.message, [], { typed: true });
          if (answer !== this.cwd) throw new CliError("binding_cancelled", "Broad directory binding was not confirmed");
          this.registry.bind(id, { confirmBroad: true });
        }
      }
      this.followController?.abort(); this.generation++;
      this.binding = this.registry.binding(); this.provenance = persist ? "binding" : "explicit";
      this.attachments = []; this.project = project; this.run = null; this.status = "Ready"; this.change();
    }, this.env);
    await this.loadNewest();
  }

  requireLogin() {
    if (this.offline) throw new CliError("offline", "Working offline; /resume reconnects. Your draft is kept.");
    if (!this.account) throw new CliError("login_required", "Use /login first; your draft and Run are kept");
  }

  async cancel() {
    this.requireLogin();
    if (!this.run?.open) throw new CliError("run_not_open", "There is no open Run to cancel");
    const run = this.run, client = this.client;
    await client.runCancel(run.run_id);
    if (this.run !== run || this.client !== client) return;
    this.status = "Cancellation requested — completed work stays"; this.change();
  }

  history(before) { return this.transition(() => this.selectHistory(before)); }

  async selectHistory(before) {
    if (!this.project) throw new CliError("project_unavailable", "Choose a Project with /project first");
    if (this.run?.open) throw new CliError("run_busy", "Finish the current Run before viewing older history; /web opens it separately");
    while (true) {
      const page = await this.client.projectHistory(this.project.id, { before });
      if (this.closed) return;
      if (!page.runs.length && !page.next_before) { this.message("No older Runs."); return; }
      const choices = page.runs.map(row => ({ label: `${row.response.terminal || "Running"} · ${row.request.ask.slice(0, 160)}`, value: row.response.run_id }));
      if (page.next_before) choices.push({ label: "Older Runs", value: "older" });
      choices.push({ label: "Back to composer", value: null });
      const id = await this.choose("Project history", choices);
      if (this.closed) return;
      if (id === "older") { before = page.next_before; continue; }
      if (!id) return;
      const selected = page.runs.find(row => row.response.run_id === id);
      this.followController?.abort(); this.generation++;
      this.run = { ...selected.response, accepted_at: selected.accepted_at, open: !selected.response.terminal };
      this.message(selected.request.ask, "user");
      if (this.run.open) void this.follow().catch(error => this.report(error));
      else { this.message(runView(this.run).transcript, "answer", { runId: this.run.run_id, sections: runSections(this.run) }); await this.announceFooter(this.project.id); }
      this.status = "Viewing history — next send continues the current Project head"; this.change();
      return;
    }
  }

  async steer(text) {
    this.requireLogin();
    if (!this.run?.open) throw new CliError("run_not_open", "There is no open Run to steer");
    const control = { id: randomUUID(), kind: text ? "steer" : "answer_now", ...(text ? { text } : {}) };
    const run = this.run, client = this.client;
    const value = await client.runControl(run.run_id, control);
    if (this.run !== run || this.client !== client) return;
    run.controls = [...(run.controls ?? []).filter(c => c.id !== value.id), value].sort((a, b) => a.sequence - b.sequence);
    this.message(`${value.kind === "steer" ? "Steer" : "Answer now"} received by Vecteur.`);
    this.change();
  }

  async answer() {
    this.requireLogin();
    const run = this.run, client = this.client;
    const question = runView(run).question;
    if (!question?.questions?.length) throw new CliError("question_unavailable", "There is no pending clarification");
    const current = () => {
      this.requireLogin();
      if (this.run !== run || this.client !== client || runView(this.run).question?.id !== question.id) throw new CliError("question_resolved", "This clarification has already been resolved; your answer was not sent");
    };
    if (this.clarificationDraft?.run !== run || this.clarificationDraft?.client !== client || this.clarificationDraft?.id !== question.id) {
      this.clarificationDraft = { run, client, id: question.id, answers: [] };
    }
    const { answers } = this.clarificationDraft;
    while (true) {
      for (const item of question.questions.slice(answers.length)) {
        const options = [...item.options.map(option => ({ label: `${option.label}${option.description ? ` — ${option.description}` : ""}`, value: option.label })),
          { label: "Write an answer", value: null }];
        const response = item.options.length ? await this.choose(
          item.question + (item.multiSelect ? " (choose numbers separated by commas)" : ""), options,
          { multiple: item.multiSelect === true }) : null;
        const selected = Array.isArray(response) ? response : [response];
        const answer = { id: item.id, selected: selected.filter(value => value !== null) };
        if (selected.includes(null)) {
          do { answer.custom = await this.choose(item.question, [], { typed: true }); }
          while (!answer.custom.trim());
        }
        answers.push(answer);
        current();
      }
      current();
      this.message(answers.map((answer, i) => `${question.questions[i].question}\n${[...answer.selected, answer.custom].filter(Boolean).join('; ')}`).join("\n\n"));
      const action = await this.choose("Review your answers before sending", [
        { label: "Submit these answers", value: "submit" }, { label: "Change answers", value: "edit" },
        { label: "Keep answers for later in this session", value: "later" },
      ]);
      current();
      if (action === "later") return;
      if (action === "submit") break;
      answers.length = 0;
    }
    await this.client.clarificationAnswer(this.run.run_id, question.id, answers);
    this.clarificationDraft = null;
    this.status = "Answer submitted"; this.change();
  }

  modelChoice() { return this.transition(() => this.selectModel()); }

  async selectModel() {
    if (!this.account || this.account.model_cost_estimates.catalogue_envelope_sha256 !== CATALOGUE_ENVELOPE_SHA256) {
      throw new CliError("catalogue_outdated", "Model catalogue differs from this CLI; install the origin's current version");
    }
    const options = [{ label: "Auto — Vecteur selects the model", value: null },
      ...PRODUCT_ROUTES.filter(row => row.route_id !== "auto").map(row => ({ label: `${row.label} · ${row.candidates.map(item => item.jurisdiction).join(" → ")}`, value: row.route_id })),
      ...MODEL_CATALOGUE.map(row => ({ label: `${row.label} · ${row.provider} · ${row.data_residency}`, value: row.profile_id }))];
    this.model = await this.choose("Model for the next Run (Vecteur billing)", options); this.change();
  }

  modeDetails() {
    const requested = this.model ?? "auto";
    const route = PRODUCT_ROUTES.find(row => row.route_id === requested);
    const profile = MODEL_CATALOGUE.find(row => row.profile_id === requested);
    const matched = this.account?.model_cost_estimates.catalogue_envelope_sha256 === CATALOGUE_ENVELOPE_SHA256;
    const destination = !matched ? "Catalogue unavailable or outdated — /login or update this CLI"
      : route ? route.candidates.map(row => `${row.provider_id}/${row.model_id} (${row.jurisdiction})`).join(" → ")
        : profile ? `${profile.provider} (${profile.data_residency})` : "Unknown";
    let local = "unavailable on this platform";
    try { qualify(); local = this.executor && !this.executor.closed ? "attached to this Run"
      : this.execAllowed && this.execGrant ? "enabled for the next Run" : "available — /exec on to allow commands"; }
    catch { /* qualify owns the supported platform boundary */ }
    return `Lead: Laplace\nExecution: Vecteur cloud\nPayer: Project organization ${this.account?.org_id ?? "(sign in first)"}\nNext model: ${this.view().model}\nData destination: ${destination}\nLast Run profile: ${this.run?.profile || "not known"}\nLocal execution: ${local}`;
  }

  statusDetails() {
    return `Vecteur · ${this.offline ? "Offline" : this.account ? "Signed in" : "Not signed in"}\nOrigin: ${this.origin}\nAccount: ${this.account?.email ?? "Unavailable"}\nProject: ${this.view().projectLabel}\nFolder: ${this.cwd}\nBinding: ${this.binding?.folder?.path ?? "None"}\nRole: ${this.project?.role ?? "No Project"}\n${this.modeDetails()}\n${this.status}${this.run ? `\n${this.view().run.elapsed}` : ""}`;
  }

  async logout() {
    this.executor?.stop(); this.execAllowed = false;
    return this.transition(async () => {
      this.requireLogin();
      const yes = await this.choose("Sign out here? Saved drafts stay with this account; a cloud Run keeps running.", [
        { label: "Keep working", value: false }, { label: "Sign out", value: true },
      ]);
      if (!yes) return;
      const client = this.client;
      await client.credentialSelfRevoke();
      if (client !== this.client || this.closed) return;
      clearTimeout(this.draftTimer); this.registry?.saveDraft(this.draft);
      await withAdmissionLock(() => {
        if (!this.env.VECTEUR_TOKEN) clearCredentials(this.env, this.origin);
        else endGrants({origin:this.origin,accountId:this.account.id},this.env);
      },this.env);
      this.signedOut = true;
      this.env = { ...this.env }; delete this.env.VECTEUR_TOKEN;
      this.followController?.abort(); this.generation++; this.account = null; this.project = null;
      this.binding = null; this.run = null; this.registry = null; this.draft = ""; this.attachments = [];
      this.workOffline();
    });
  }

  async download(index, output) {
    this.requireLogin();
    const item = runView(this.run).artifacts[index - 1];
    if (!item) throw new CliError("artifact_unavailable", "Choose an artifact number from /files");
    const result = await downloadArtifact(this.client, item.cas_ref, this.project.id, output ? resolve(this.cwd, output) : undefined);
    this.message(`Downloaded ${result.bytes} verified bytes to ${result.path}`);
  }

  /** Round trip: verified Code/package download into a new folder; the user runs it, then /attach the result. */
  async package(index) {
    this.requireLogin();
    const item = runView(this.run).artifacts[index - 1];
    if (!item) throw new CliError("artifact_unavailable", "Choose an artifact number from /files");
    const directory = resolve(this.cwd, `vecteur-package-${item.cas_ref.slice(7, 19)}`);
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      throw new CliError(error?.code === "EEXIST" ? "output_exists" : "export_failed", `could not create ${directory}`);
    });
    const result = await downloadArtifact(this.client, item.cas_ref, this.project.id, join(directory, safeArtifactName(item)));
    // CU-2: the folder remembers which package revision it holds, so a local report binds to that revision only.
    await writeFile(join(directory, PACKAGE_MARKER), JSON.stringify({ cas_ref: item.cas_ref, project_id: this.project.id,
      run_id: this.run?.run_id ?? null, filename: item.filename }), { flag: "wx", mode: 0o600 });
    this.lastPackage = directory;
    this.message([`Saved ${result.bytes} verified bytes to ${result.path}`,
      `Vecteur does not run it on its own. /run-package asks your consent and runs its declared tests here (unzip a .zip into ${directory} first),`,
      "or run them yourself and /attach the report. A report is your evidence, never an accepted result."].join("\n"));
  }

  /** CU-2 (v5 §5): with explicit consent, run the declared test command of a downloaded Code package on this machine
   *  as an approved process template (python -m pytest + plain flags, inside the package), stop its whole process
   *  tree on /stop-package or at the wall, and stage the report — bound to the package revision it tested — for upload
   *  on the next send. Without consent nothing runs. */
  async runPackage(argument = "") {
    this.requireLogin();
    if (this.localRun) throw new CliError("package_running", "A package is already running; /stop-package stops it");
    const directory = resolve(this.cwd, argument.trim() || this.lastPackage || ".");
    let marker;
    try { marker = JSON.parse(await readFile(join(directory, PACKAGE_MARKER), "utf8")); }
    catch { throw new CliError("package_unbound", "Run only a package saved with /package (its folder records the revision)"); }
    const root = await packageRoot(directory);
    const raw = await readFile(join(root, "kc.json"));
    let manifest;
    try { manifest = JSON.parse(raw.toString("utf8")); } catch { throw new CliError("package_invalid", "kc.json is not JSON"); }
    const argv = approvedTemplate(manifest, root);
    if (marker.project_id !== this.project.id
        || !runView(this.run).artifacts.some(item => item.cas_ref === marker.cas_ref)) {
      throw new CliError("report_revision_mismatch", "This folder holds a package of another Project turn; open that turn first");
    }
    const ok = await this.choose([`Run on this machine, in ${root}:`, `  ${argv.join(" ")}`,
      `Target ${manifest.target ?? "unspecified"}. It runs with your Python (${this.env.VECTEUR_PYTHON || "python3"}) and your user's rights; only its report is uploaded, on your next send.`].join("\n"), [
      { label: "Run the declared tests", value: true }, { label: "Cancel", value: false }]);
    if (!ok || this.closed) { this.message("Nothing ran."); return null; }
    const started = Date.now();
    const child = spawn(this.env.VECTEUR_PYTHON || "python3", argv.slice(1), {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: localProcessEnv(this.env, root) });
    const out = [], err = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    const run = this.localRun = { child, stopped: null };
    const wall = setTimeout(() => this.stopPackage("wall"), Number(this.env.VECTEUR_PACKAGE_WALL_S || 600) * 1000);
    const [code, signal] = await new Promise(done => child.on("close", (c, s) => done([c, s])));
    clearTimeout(wall); clearTimeout(run.escalation);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already gone */ }
    this.localRun = null;
    const tail = chunks => Buffer.concat(chunks).toString("utf8").slice(-8000);
    const report = { schema: "vecteur.kc.local-test.v1", package_cas_ref: marker.cas_ref, project_id: marker.project_id,
      run_id: marker.run_id, kc_json_sha256: createHash("sha256").update(raw).digest("hex"), target: manifest.target ?? null,
      argv, exit_code: code, signal, stopped: run.stopped, seconds: (Date.now() - started) / 1000,
      stdout_tail: tail(out), stderr_tail: tail(err) };
    const bytes = Buffer.from(JSON.stringify(report, null, 1));
    const path = join(directory, `kc-test-report-${marker.cas_ref.slice(7, 19)}-${started}.json`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    this.attachments.push({ path, bytes, media: "application/json", generated:true }); this.change();
    this.message(`${run.stopped ? `Stopped (${run.stopped})` : code === 0 ? "Tests passed" : `Tests failed (exit ${code})`}; the report ${basename(path)} is staged for your next send.`);
    return report;
  }

  /** Stop the running package: its whole process group, SIGTERM then SIGKILL after 2 s. */
  stopPackage(reason = "user") {
    const run = this.localRun;
    if (!run) throw new CliError("package_not_running", "No package is running");
    run.stopped = reason;
    try { process.kill(-run.child.pid, "SIGTERM"); } catch { /* exited */ }
    run.escalation = setTimeout(() => { try { process.kill(-run.child.pid, "SIGKILL"); } catch { /* exited */ } }, 2000);
  }

  async exportRun(output) {
    this.requireLogin();
    if (!this.run || this.run.open) throw new CliError("run_unavailable", "Export needs a completed Run");
    const result = await exportRun(this.client, this.run, this.project.id,
      resolve(this.cwd, output ?? `vecteur-run-${this.run.run_id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12)}`));
    this.message(`Exported ${result.files.length} files to ${result.directory}\n${result.files.map(file => `${basename(file.path)} · ${file.bytes} bytes${file.cas_ref ? " · verified" : ""}`).join("\n")}`);
  }

  async copy(output) {
    const answer = runView(this.run).answer;
    if (!answer) throw new CliError("answer_unavailable", "No completed answer to copy");
    if (!output) { this.emit("copy", answer); return; }
    await writeFile(resolve(this.cwd, output), answer, { flag: "wx", mode: 0o600 });
    this.message(`Saved exact answer bytes to ${output}`);
  }

  close() {
    if (this.closed) return;
    try {
      if (!this.registry && this.draft) this.unsignedDraft({ restore: false });
      if (this.registry) this.registry.saveDraft(this.draft);
    }
    catch (error) { this.message(`Draft could not be saved: ${error.code ?? "store_error"}`, "error"); }
    this.executor?.stop();
    this.closed = true; this.generation++; this.cancelLogin(); this.lifecycle.abort(); this.followController?.abort(); clearTimeout(this.draftTimer);
    this.rejectPrompt?.(new CliError("session_closed", "Session closed")); this.prompt = null;
    this.emit("close");
  }
}
