import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { VecteurClient, CliError, configuration, delay, isTokenShaped, requestTimeout,
  resolveOrigin, shouldOpenBrowser, waitForDeviceAuthorization } from "./client.js";
import { readCredentials, writeCredentials, clearCredentials } from "./credentials.js";
import { FolderRegistry, UNSIGNED_ACCOUNT } from "./folders.js";
import { runView } from "./blocks.js";
import { downloadArtifact, exportRun } from "./download.js";
import { humanCost, runSections } from "./format.js";
import { CATALOGUE_ENVELOPE_SHA256, MODEL_CATALOGUE, PRODUCT_ROUTES } from "./contract.js";
import { openBrowser } from "./browser.js";

export const NEW_FOLDER = "New folder — send an ask or /link an existing Project";
const AUTH_ERRORS = new Set(["pat_expired", "pat_invalid", "pat_revoked"]);
const TRANSIENT = new Set(["request_failed", "request_timeout", "terminal_invalid"]);
const MEDIA = { ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

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
      attachments: this.attachments.map(item => ({ path: item.path, size: item.bytes.length })),
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

  async choose(title, options, { typed = false, multiple = false } = {}) {
    if (this.prompt) throw new CliError("prompt_busy", "Answer the current question first");
    return new Promise((resolveChoice, reject) => {
      this.prompt = { id: ++this.promptGeneration, title, options, typed, multiple };
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
    const newRegistry = !this.registry || this.registry.accountId !== account.id;
    if (newRegistry) this.registry = new FolderRegistry({ origin: this.origin, accountId: account.id, cwd: this.cwd, env: this.env });
    if (newRegistry && this.draft) {
      if (unsigned && transferUnsigned) unsigned.transferDraftTo(this.registry, this.draft);
      else this.registry.newDraft();
    }
    this.registry.rememberLogin(token);
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
    await this.loadNewest();
  }

  async loadNewest() {
    if (this.project) {
      this.followController?.abort(); const generation = ++this.generation;
      const newest = await this.client.projectNewestRun(this.project.id);
      if (this.closed || generation !== this.generation) return;
      if (newest) {
        this.run = { ...newest, open: !newest.terminal };
        if (this.run.open) {
          this.status = runView(this.run, this.projectionCache).question ? "Waiting for your answer" : "Running";
          this.change(); void this.follow().catch(error => this.report(error));
        }
        else { this.status = newest.terminal; this.announceRun(); this.change(); }
      } else { this.run = null; this.change(); }
    }
  }

  announceRun() {
    if (this.lastPrintedRun === this.run?.run_id) return;
    this.message(runView(this.run).transcript, "answer", { runId: this.run?.run_id, sections: runSections(this.run) }); this.lastPrintedRun = this.run?.run_id;
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

  async ensureProject() {
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
    if (!pending.projectId) this.registry.completeCreation(pending.key, project.id);
    this.project = project; this.binding = this.registry.binding();
    return project;
  }

  async submit(text = this.draft) {
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
      if (this.registry?.state().pendingRun) throw new CliError("submission_pending", "Use /resume to resolve the interrupted submission; your new draft is kept");
      const project = await this.ensureProject();
      if (project.role === "VIEWER") throw new CliError("role_forbidden", "Editor access is required to ask Vecteur");
      const newest = await this.client.projectNewestRun(project.id);
      if (newest && !newest.terminal) {
        this.run = { ...newest, open: true }; void this.follow().catch(error => this.report(error));
        throw new CliError("run_busy", "Another terminal has an open Run. Following it; your draft is kept.");
      }
      const selections = [];
      for (const item of this.attachments) {
        item.source ??= await this.client.inputAdd(project.id, item.bytes, item.media);
        const offer = item.source.offer ?? await this.client.inputOffer(project.id, item.source);
        if (!offer.extracts.length) throw new CliError("extraction_unavailable", "This file has no selectable extracts");
        selections.push({ source_handle: { cas_ref: item.source.cas_ref, acquisition_ref: item.source.acquisition_ref },
          offer_id: offer.id, selected_extract_ids: offer.extracts.map(extract => extract.id).sort(), method: "exact-extract" });
      }
      selections.sort((a, b) => a.source_handle.cas_ref.localeCompare(b.source_handle.cas_ref)
        || a.source_handle.acquisition_ref.localeCompare(b.source_handle.acquisition_ref));
      const body = { ask: text, attachments: selections.map(item => item.source_handle),
        parent_state_hash: newest?.state_hash ?? null, ui_context: null,
        ...(selections.length ? { selections } : {}), ...(this.model ? { model_choice: this.model } : {}) };
      const pending = this.registry.reserveRun(project.id, body, draftRef);
      await this.admitPending(pending);
    } finally { this.busy = false; this.change(); }
  }

  async admitPending(pending) {
    if (this.project?.id !== pending.projectId) {
      const project = await this.client.projectGet(pending.projectId);
      this.followController?.abort(); this.generation++; this.run = null; this.project = project; this.change();
    }
    let ack;
    try { ack = await this.client.runAdmit(pending.projectId, pending.body, pending.key); }
    catch (error) {
      if (["state_busy", "state_fork"].includes(error.code)) {
        this.registry.rejectRunAdmission(pending.key);
        await this.loadNewest();
        throw new CliError(error.code, "Submission refused; draft kept. Review the latest Run and explicitly send again.");
      }
      // The owner marked this key as never admittable (nothing dispatched): release only this
      // reservation and keep the draft. Any other failure stays pending for /resume.
      if (error.admission === "refused") {
        this.registry.rejectRunAdmission(pending.key);
        throw new CliError(error.code, "Submission refused before it ran; draft kept. Fix it and send again.");
      }
      throw error;
    }
    this.registry.finishRunAdmission(pending.key);
    if (this.draft === pending.body.ask) { clearTimeout(this.draftTimer); this.draft = ""; }
    this.attachments = [];
    this.message(pending.body.ask, "user");
    this.run = { ...ack, events: [], terminal: "", open: true };
    this.status = "Running"; this.change();
    void this.follow().catch(error => this.report(error));
  }

  async resume() {
    if (this.offline) { this.offline = false; return this.initialize(); }
    if (this.busy) throw new CliError("session_busy", "This submission is already being reconciled");
    if (!this.account || !this.registry) return this.initialize();
    const state = this.registry.state();
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
    const run = this.run; const generation = ++this.generation;
    const projectId = this.project.id;
    let attempts = 0;
    while (!this.closed && generation === this.generation && run?.open) {
      try {
        const direct = await this.client.runEvents(run.run_id, event => {
          if (generation !== this.generation) return;
          run.events.push(event);
          this.status = runView(run, this.projectionCache).question ? "Waiting for your answer" : "Running";
          this.change();
        }, controller.signal, [...run.events]);
        if (generation !== this.generation) return;
        this.run = { ...direct, accepted_at: direct.run_id === run.run_id ? run.accepted_at : undefined, open: !direct.terminal };
        this.status = direct.terminal; this.announceRun();
        try {
          const cost = await this.client.customerCost(projectId);
          if (generation === this.generation) this.message(humanCost(cost), "cost", { value: cost });
        } catch (error) { if (generation === this.generation) this.message(`Usage unavailable: ${error.code}`); }
        this.change(); return;
      } catch (error) {
        if (controller.signal.aborted || this.closed || generation !== this.generation) return;
        if (AUTH_ERRORS.has(error.code)) { this.report(error); return; }
        if (!TRANSIENT.has(error.code) || ++attempts > 5) throw error;
        this.status = "Connection lost — reconnecting to the same Run"; this.change();
        await delay(Math.min(500 * 2 ** attempts, 8_000), controller.signal);
      }
    }
  }

  attach(path) { return this.transition(() => this.selectAttachment(path)); }

  async selectAttachment(path) {
    if (this.registry?.state().pendingRun) throw new CliError("submission_pending", "Resolve the pending submission before changing its files");
    const filename = resolve(this.cwd, path);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > 8 * 1024 * 1024) throw new CliError("attachment_invalid", "Select one non-empty file no larger than 8 MiB");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs
          || after.ctimeMs !== info.ctimeMs) throw new CliError("attachment_changed", "File changed while reading; select it again");
    } finally { await handle.close(); }
    if (this.attachments.length >= 8 || this.attachments.reduce((sum, item) => sum + item.bytes.length, bytes.length) > 32 * 1024 * 1024) {
      throw new CliError("attachments_full", "Select at most 8 files and 32 MiB per turn; /clear-files removes pending files");
    }
    const ok = await this.choose(`Attach ${filename} (${bytes.length} bytes) to ${this.project?.name ?? "the Project created on send"} at ${this.origin}? Selected extracts go to the chosen model route.`, [
      { label: "Attach on next send", value: true }, { label: "Cancel", value: false },
    ]);
    if (!ok || this.closed) return;
    const extension = /\.[^.]+$/.exec(filename)?.[0].toLowerCase();
    this.attachments.push({ path: filename, bytes, media: MEDIA[extension] ?? "application/octet-stream" }); this.change();
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
    this.binding = this.registry.binding();
    this.attachments = []; this.project = project; this.run = null; this.status = "Ready"; this.change();
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
      else this.message(runView(this.run).transcript, "answer", { runId: this.run.run_id, sections: runSections(this.run) });
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
    this.message(`Instruction ${value.state}; acceptance does not mean it was executed.`);
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
    return `Lead: Laplace\nExecution: Vecteur cloud\nPayer: Project organization ${this.account?.org_id ?? "(sign in first)"}\nNext model: ${this.view().model}\nData destination: ${destination}\nLast Run profile: ${this.run?.profile || "not known"}\nNative Claude/Codex modes and local execution are unavailable in this version.`;
  }

  statusDetails() {
    return `Vecteur · ${this.offline ? "Offline" : this.account ? "Signed in" : "Not signed in"}\nOrigin: ${this.origin}\nAccount: ${this.account?.email ?? "Unavailable"}\nProject: ${this.view().projectLabel}\nFolder: ${this.cwd}\nBinding: ${this.binding?.folder?.path ?? "None"}\nRole: ${this.project?.role ?? "No Project"}\n${this.modeDetails()}\n${this.status}${this.run ? `\n${this.view().run.elapsed}` : ""}`;
  }

  async logout() {
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
      if (!this.env.VECTEUR_TOKEN) clearCredentials(this.env, this.origin);
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
    this.closed = true; this.generation++; this.cancelLogin(); this.lifecycle.abort(); this.followController?.abort(); clearTimeout(this.draftTimer);
    this.rejectPrompt?.(new CliError("session_closed", "Session closed")); this.prompt = null;
    this.emit("close");
  }
}
