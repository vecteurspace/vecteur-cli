import { ComposerInput } from "./input.js";
import { command, completions, SHORTCUTS } from "./commands.js";
import { Session } from "./session.js";
import { terminalText as safe, taskLines } from "./format.js";
import { preferences } from "./preferences.js";
import { openBrowser } from "./browser.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

const measure = value => /^[\x20-\x7e]*$/.test(value) ? value.length : stringWidth(value);

/**
 * The only stdout writer. It never clears the screen/scrollback or enters alternate screen.
 * Rich mode parks the cursor (hidden) at column 1 of the first live row: everything from there
 * down is the live region, so one erase-below removes exactly it, even after the terminal has
 * reflowed it on resize. A cursor-position report places that row; blank rows between the
 * transcript and the bottom-anchored composer are cursor movement, never printed history.
 */
export class TerminalWriter {
  constructor(stdout, plain) {
    this.stdout = stdout; this.plain = plain; this.drawn = false; this.frame = null;
    this.row = null; this.awaiting = 0; this.since = 0;
  }
  erase() {
    if (!this.drawn) return "";
    this.drawn = false;
    return "\r\x1b[J";
  }
  clearLive() { this.frame = null; const bytes = this.erase(); if (bytes) this.stdout.write(bytes); }
  // Display rows the terminal used for appended text; rich lines are narrower than the window.
  advance(text) {
    const columns = Math.max(1, this.stdout.columns ?? 80);
    const rows = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(measure(stripVTControlCharacters(line)) / columns)), 0);
    if (this.awaiting) this.since += rows;
    else if (this.row) this.row = Math.min(this.stdout.rows ?? 24, this.row + rows);
  }
  progress(view) {
    const subject = view.run?.subject?.id;
    if (subject !== this.subject) { this.subject = subject; this.lastProgress = null; this.lastQuestion = null; }
    if (!subject || view.run.terminal) return;
    if (view.run.progress && view.run.progress !== this.lastProgress) {
      this.append(safe(`${view.run.progress} · ${view.run.elapsed ?? "Elapsed unavailable"}`)); this.lastProgress = view.run.progress;
    }
    const question = view.run.question;
    if (question?.id !== this.lastQuestion) {
      this.lastQuestion = question?.id;
      if (question) this.append(safe(`Vecteur needs your answer — /answer\n${question.questions.map(row => row.question).join("\n")}`));
    }
  }
  /** Scrollback text, then the given live frame in the same write: the composer never blinks out. */
  append(text, frame = null) {
    const body = text.replace(/\n+$/, "");
    let bytes = `${this.erase()}${body}\n`;
    if (!this.plain) this.advance(body);
    if (frame) { this.frame = frame; bytes += this.render(); }
    this.stdout.write(bytes);
  }
  draw(frame) {
    if (this.plain) return;
    this.frame = typeof frame === "string" ? { top: [], bottom: frame.replace(/\n+$/, "").split("\n") } : frame;
    // One write per frame: erase and redraw land together, so the spinner never flickers.
    const bytes = this.render();
    if (bytes) this.stdout.write(bytes);
  }
  render() {
    if (this.plain || !this.frame || this.awaiting) return "";
    const rows = this.stdout.rows ?? 24;
    const lines = [...this.frame.top, ...this.frame.bottom].slice(-Math.max(1, rows - 1));
    const gap = this.row ? Math.max(0, rows - this.row + 1 - lines.length) : 0;
    const at = Math.max(0, lines.length - this.frame.bottom.length);
    const body = [...lines.slice(0, at), ...Array(gap).fill(""), ...lines.slice(at)];
    const up = body.length - 1;
    if (this.row) this.row = Math.max(1, Math.min(this.row, rows - body.length + 1));
    const erase = this.erase(); this.drawn = true;
    return `${erase}${body.join("\n")}${up ? `\x1b[${up}A` : ""}\r`;
  }
  /** Ask the terminal where the live region starts; frames wait for the answer (or 300 ms). */
  locate(query = "") {
    if (this.plain) return;
    this.awaiting++; this.since = 0;
    this.stdout.write(`${query}\x1b[6n`);
    clearTimeout(this.locateTimer);
    this.locateTimer = setTimeout(() => { this.awaiting = 0; this.row = null; this.onLocated?.(); }, 300);
  }
  located(row, column) {
    if (!this.awaiting || --this.awaiting) return;
    clearTimeout(this.locateTimer);
    const rows = this.stdout.rows ?? 24;
    let bytes = "";
    // Another program left the cursor mid-line: start the live region on the next row.
    if (column > 1 && !this.since) { bytes = "\r\n"; row++; }
    this.row = Math.max(1, Math.min(rows, row + this.since));
    if (bytes) this.stdout.write(bytes);
    this.onLocated?.();
  }
  resized(plain) {
    // Reflow moved the old frame but not the parked cursor: erase below it, then re-locate.
    const bytes = this.drawn ? "\r\x1b[J" : "";
    this.drawn = false; this.frame = null; this.row = null; this.plain = plain;
    if (bytes) this.stdout.write(bytes);
  }
  close() { clearTimeout(this.locateTimer); this.awaiting = 0; }
}

export async function startTerminal(options = {}, { stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  let prefs;
  try { prefs = preferences(env); } catch (error) {
    if (!options.plain) throw error;
    prefs = { plain: true, reducedMotion: true };
  }
  let rich = !options.plain && !prefs.plain && env.TERM !== "dumb";
  const color = !options.noColor && env.NO_COLOR === undefined;
  // Colour roles start palette-relative; a terminal that reports its own colours gets exact blends.
  let theme = color; const reported = {};
  const layout = await import("./tui/view.js");
  const isPlain = () => !rich || ((stdout.columns ?? 80) < 40 || (stdout.rows ?? 24) < 8);
  const writer = new TerminalWriter(stdout, isPlain());
  const session = new Session({ ...options, env });
  const input = new ComposerInput();
  session.terminalFlags = [...(options.plain ? ["--plain"] : []), ...(options.noColor ? ["--no-color"] : [])];
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { version } = pkg, channel = pkg.vecteur?.channel;
  let suppressed = false, activePrompt = null, selected = 0, paletteSelected = 0, paletteDismissed = false;
  let lastPlainStatus = "", lastPlainIdentity = "", plainDraft = "", frameTimer, clockTimer, cancelAt = 0, cancelRun, exitAt = 0;
  let snapshot = null, localPicker = null, loginAction = 0, updateChecked = false, tick = 0;
  // While a vendor owns the TTY (handoff) Vecteur writes nothing: frames, clocks, streamed
  // steps and messages wait, and are flushed once when the vendor exits.
  let vendorOwnsTerminal = false, resizedDuringHandoff = false; const heldMessages = [];
  // Rich scrollback streams each finished step as one line; the answer block then skips them.
  const streamed = { run: null, events: 0, steps: 0 };
  // The identity header is live until the first transcript block, then committed once.
  let headerLive = true, cursorHidden = false;
  const directory = () => session.cwd === homedir() || session.cwd.startsWith(homedir() + "/") ? "~" + session.cwd.slice(homedir().length) : session.cwd;
  const history = []; let historyIndex = 0, historyDraft = "", historyAccount;
  const syncInput = (value, cursor = value === input.text ? input.cursor : value.length) => { suppressed = true; input.set(value); input.cursor = cursor; suppressed = false; };
  const focusChanged = () => {
    input.focusEpoch++; cancelAt = 0;
    // Number/Enter typeahead from a dismissed numbered prompt is never a new ask.
    if (/^[\d,\s]*$/.test(input.pending)) input.pending = "";
  };
  const palette = () => !paletteDismissed && !session.prompt && !session.loginChallenge && !localPicker
    && /^\/[^\s/]*$/.test(input.text) ? completions(input.text, session) : [];
  const choices = () => {
    const prompt = session.prompt ?? localPicker;
    if (!prompt || prompt.typed) return [];
    if (!input.text || /^[\d, ]+$/.test(input.text)) return prompt.options;
    return prompt.options.filter(item => item.label.toLowerCase().includes(input.text.toLowerCase()));
  };
  const frameView = () => ({ ...session.view(), version, channel, header: headerLive, directory: directory(),
    focus: localPicker ?? session.prompt, choices: choices(), selected,
    palette: palette(), paletteSelected, loginAction });
  const live = () => layout.richLayout(frameView(), input.text, input.cursor,
    { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24, color: theme, tick: prefs.reducedMotion ? null : tick });
  const draw = () => {
    clearTimeout(frameTimer); frameTimer = null;
    if (vendorOwnsTerminal) return;
    if (!session.closed && !writer.plain) writer.draw(live());
  };
  // The real cursor stays hidden in rich mode (the composer draws its own caret) and always
  // returns on exit, error, plain fallback and vendor handoff.
  const showCursor = visible => {
    if (env.TERM === "dumb" || visible !== cursorHidden) return;
    cursorHidden = !visible; stdout.write(visible ? "\x1b[0m\x1b[?25h" : "\x1b[?25l");
  };
  const restoreCursor = () => showCursor(true);
  const commitHeader = () => {
    if (writer.plain || !headerLive) return;
    headerLive = false; writer.append(layout.richHeader(frameView(), stdout.columns ?? 80, theme).join("\n"));
  };
  // Transcript blocks (asks, answers, steps, usage) commit the header above them; notices printed
  // before the first ask stay above the live identity, which keeps owning the current facts.
  const print = (text, transcript = true) => {
    if (transcript) commitHeader();
    writer.append(text, writer.plain || session.closed || vendorOwnsTerminal ? null : live());
  };
  writer.onLocated = () => {
    input.expectReports = false;
    if (theme && reported.fg && reported.bg && theme === color) {
      theme = layout.paletteTheme(reported, ["truecolor", "24bit"].includes(env.COLORTERM));
    }
    draw();
  };
  const locate = (query = "") => { if (!writer.plain) { input.expectReports ||= !!query; writer.locate(query); } };
  const schedule = () => { if (!frameTimer && !vendorOwnsTerminal) frameTimer = setTimeout(() => { frameTimer = null; draw(); }, 40); };
  const printPlainPrompt = prompt => writer.append(safe(`${prompt.title}\n${prompt.options.map((row, i) => `${i + 1}. ${row.label}`).join("\n")}\nEnter a choice; Esc returns to your draft.`));
  const maybeUpdate = () => {
    if (updateChecked || session.closed || session.offline || session.busy || session.prompt || session.loginChallenge || session.run?.open || session.registry?.state().pendingRun || session.registry?.state().pendingCreate || !session.release) return;
    updateChecked = true;
    void import("./update.js").then(({ interactiveUpdate }) => interactiveUpdate(session, { automatic: true })).catch(error => session.report(error));
  };
  session.on("change", view => {
    if (vendorOwnsTerminal) return;
    const ticking = !writer.plain && !view.offline && session.run?.open;
    if (ticking && !clockTimer) clockTimer = setInterval(() => { tick++; draw(); }, prefs.reducedMotion ? 1000 : 200);
    if (!ticking) { clearInterval(clockTimer); clockTimer = null; }
    const run = session.run;
    if (!writer.plain && run?.open && Array.isArray(run.events)) {
      if (streamed.run !== run.run_id) Object.assign(streamed, { run: run.run_id, events: 0, steps: 0 });
      for (; streamed.events < run.events.length; streamed.events++) {
        const event = run.events[streamed.events];
        if (event?.kind !== "step_finished") continue;
        const [row] = taskLines([event]);
        if (!row) continue;
        if (!streamed.steps++) print("");
        print(layout.richMessage({ kind: "step", text: row.split("\n").map(part => part.trim().replace(/^[▸·]\s*/, "")).filter(Boolean).join(" · ") }, stdout.columns ?? 80, theme));
      }
    }
    if (process.connected && process.send && env.VECTEUR_UPDATE_SESSION && session.release?.compatible
        && session.registry && (!view.busy || view.prompt)) {
      const nonce = env.VECTEUR_UPDATE_SESSION; delete env.VECTEUR_UPDATE_SESSION;
      process.send({ type: "vecteur-ready", nonce, version, contract: session.release.contract, origin: session.origin }, () => {});
    }
    const accountKey = `${view.account?.id ?? "unsigned"}:${view.project?.id ?? "unbound"}`;
    if (historyAccount !== accountKey) {
      if (historyAccount !== undefined && !view.prompt) { localPicker = null; focusChanged(); syncInput(view.draft); }
      history.length = 0; historyIndex = 0; historyDraft = ""; historyAccount = accountKey; input.undo = []; input.killed = ""; snapshot = null; }
    if (writer.plain) {
      writer.progress(view);
      const identity = `${view.account?.email ?? "Not signed in"} · ${view.projectLabel}\n${view.folder}\n${view.lead} · ${view.location} · ${view.model}`;
      if (identity !== lastPlainIdentity) { writer.append(safe(identity)); lastPlainIdentity = identity; }
    }
    if (view.prompt !== activePrompt) {
      if (view.prompt && !activePrompt) snapshot = { text: input.text.startsWith("/") ? session.draft : input.text, cursor: input.cursor, undo: input.undo, killed: input.killed };
      activePrompt = view.prompt; selected = 0; focusChanged();
      if (activePrompt) {
        input.undo = []; input.killed = ""; syncInput(""); if (writer.plain) printPlainPrompt(activePrompt);
      } else {
        const restored = snapshot && snapshot.text === session.draft ? snapshot : { text: session.draft, cursor: session.draft.length };
        syncInput(restored.text, Math.min(restored.cursor, restored.text.length)); input.undo = restored.undo ?? []; input.killed = restored.killed ?? ""; snapshot = null;
      }
    }
    if (writer.plain && view.status !== lastPlainStatus) {
      writer.append(safe(view.status)); lastPlainStatus = view.status; plainDraft = "";
    }
    schedule(); queueMicrotask(maybeUpdate);
  });
  session.on("preferences", value => {
    prefs = value; rich = !options.plain && !prefs.plain && env.TERM !== "dumb";
    writer.resized(isPlain()); showCursor(writer.plain); locate(); session.change(); draw();
  });
  session.on("message", message => {
    if (vendorOwnsTerminal) { heldMessages.push(message); return; }
    print(writer.plain ? safe(message.text) : layout.richMessage(message, stdout.columns ?? 80, theme,
      { stepsShown: message.runId && message.runId === streamed.run ? streamed.steps : 0 }), ["user", "answer", "cost"].includes(message.kind));
    plainDraft = "";
  });
  session.on("copy", answer => {
    if (vendorOwnsTerminal) return;
    if (writer.plain || env.TERM === "dumb") { session.message("Use /copy <file path> to save the exact answer bytes."); return; }
    writer.clearLive(); stdout.write(`\x1b]52;c;${Buffer.from(answer).toString("base64")}\x07`);
    session.message("Copy requested through the terminal clipboard; use /copy <path> if it is disabled.");
  });
  input.on("change", value => {
    if (suppressed) return;
    if (!session.prompt && !localPicker && !value.startsWith("/")) session.setDraft(value);
    if (writer.plain) {
      if (value.startsWith(plainDraft)) stdout.write(safe(value.slice(plainDraft.length)));
      else stdout.write(`\n> ${safe(value)}`);
      plainDraft = value;
    }
    paletteDismissed = false; paletteSelected = 0; selected = 0; schedule();
  });
  const restoreLocal = text => {
    localPicker = null; focusChanged();
    const restored = text ?? historyDraft; syncInput(restored);
    if (!restored.startsWith("/")) session.setDraft(restored);
    draw();
  };
  const execute = async text => {
    if (localPicker) {
      const match = /^[1-9]\d*$/.test(text.trim()) ? localPicker.options[Number(text) - 1] : choices()[selected];
      if (match) restoreLocal(match.value); else session.message("Enter one of the numbered choices.");
      return;
    }
    if (session.prompt) {
      const prompt = session.prompt;
      if (!prompt.typed && !prompt.multiple && !/^[1-9]\d*$/.test(text.trim())) {
        const item = choices()[selected]; if (!item) return;
        text = String(prompt.options.indexOf(item) + 1);
      }
      session.answerPrompt(text); return;
    }
    if (!text.trim()) return;
    const suggestions = palette();
    if (suggestions.length) {
      const exact = suggestions.find(row => `/${row.name}` === text);
      const row = exact ?? suggestions[paletteSelected];
      if (row.disabled) { session.message(row.disabled); return; }
      if (!exact && row.argument) { syncInput(`/${row.name} `); focusChanged(); draw(); return; }
      text = `/${row.name}`;
    }
    history.push(text); if (history.length > 50) history.shift(); historyIndex = history.length;
    if (writer.plain) stdout.write("\n");
    if (text.startsWith("/")) {
      syncInput(session.draft);
      if (text === "/clear") input.checkpoint();
    }
    focusChanged(); paletteDismissed = true;
    try { await command(session, text); if (!session.prompt && !session.closed) syncInput(session.draft); }
    catch (error) { session.report(error); }
    draw();
  };
  // Native-terminal handoff (stage 2, narrower than integrated mode): the vendor owns this TTY
  // until it exits; the cloud Run, draft and session survive untouched.
  session.on("handoff", async vendor => {
    if (vendorOwnsTerminal) return;
    vendorOwnsTerminal = true;
    clearTimeout(frameTimer); frameTimer = null; clearInterval(clockTimer); clockTimer = null;
    stdin.off("data", onData); stdin.setRawMode(false); stdin.pause();
    process.off("SIGINT", onSignal);
    writer.clearLive(); commitHeader(); showCursor(true); if (env.TERM !== "dumb") stdout.write("\x1b[?2004l");
    const { VENDORS, executingServer, runVendor, vendorArgv } = await import("./vendors.js");
    writer.append(`Opening your ${VENDORS[vendor]} terminal with Vecteur attached for this session only. Exit it to return.`);
    let note;
    // The child's identity is the session's CURRENT one: a re-login removed any startup token.
    try { note = `${VENDORS[vendor]} exited (${await runVendor(vendorArgv(vendor, "handoff", executingServer()), { ...session.env, VECTEUR_BASE_URL: session.origin })}). Back in Vecteur.`; }
    catch (error) { note = `${error.code ?? "vendor_failed"}: ${error.message}`; }
    finally {
      vendorOwnsTerminal = false;
      process.once("SIGINT", onSignal);
      if (env.TERM !== "dumb") stdout.write("\x1b[?2004h");
      stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData);
    }
    // The vendor's output is history now; find where it left the cursor before drawing again.
    writer.resized(isPlain()); showCursor(writer.plain); locate();
    if (resizedDuringHandoff) { resizedDuringHandoff = false; onResize(); }
    for (const message of heldMessages.splice(0)) session.emit("message", message);
    session.message(note); session.change();
  });
  input.on("submit", text => { void execute(text); });
  input.on("notice", text => session.message(text));
  input.on("history", direction => {
    if (historyIndex === history.length) historyDraft = input.text;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + direction));
    input.set(history[historyIndex] ?? historyDraft);
  });
  input.on("search", () => {
    if (session.prompt || session.loginChallenge) return;
    historyDraft = input.text; localPicker = { title: "Search this session's input history", options: [...history].reverse().map(text => ({ label: text, value: text })) };
    selected = 0; focusChanged(); syncInput(""); if (writer.plain) printPlainPrompt(localPicker); draw();
  });
  input.on("complete", () => {
    const row = palette()[paletteSelected]; if (row) { syncInput(`/${row.name}${row.argument ? " " : ""}`); draw(); }
  });
  const cancel = () => {
    if (session.prompt) { session.cancelPrompt(); return; }
    if (localPicker) { restoreLocal(); return; }
    if (session.loginController && session.busy) { session.workOffline(); focusChanged(); return; }
    if (palette().length) { paletteDismissed = true; focusChanged(); draw(); return; }
    if (!session.run?.open) { session.status = "Draft kept · Ctrl+D exits"; session.change(); return; }
    if (cancelRun === session.run.run_id && Date.now() - cancelAt < 2_500) {
      cancelAt = 0; void session.cancel().catch(error => session.report(error));
    } else { cancelRun = session.run.run_id; cancelAt = Date.now(); session.status = "Press Esc again to cancel this Run; completed work stays"; session.change(); }
  };
  input.on("cancel", cancel);
  input.on("interrupt", () => {
    if (session.prompt || localPicker || session.loginChallenge) { cancel(); return; }
    if (input.text) { input.replace(0, input.text.length); session.status = "Draft cleared · Ctrl+_ restores"; session.change(); }
    else if (session.run?.open) cancel();
    else if (Date.now() - exitAt < 2_000) session.close();
    else { exitAt = Date.now(); session.status = "Press Ctrl+C again to exit; draft saved"; session.change(); }
  });
  input.handleKey = key => {
    const rows = choices(), list = palette();
    if (["\x1b[A", "\x1b[B"].includes(key) && (session.prompt && !session.prompt.typed || localPicker || list.length)) {
      const delta = key === "\x1b[A" ? -1 : 1;
      if (list.length) paletteSelected = (paletteSelected + delta + list.length) % list.length;
      else selected = rows.length ? (selected + delta + rows.length) % rows.length : 0;
      draw(); return true;
    }
    if (key === " " && session.prompt?.multiple) {
      const item = rows[selected], index = session.prompt.options.indexOf(item) + 1;
      const values = new Set(input.text.trim().split(/[, ]+/).filter(Boolean));
      if (values.has(String(index))) values.delete(String(index)); else values.add(String(index));
      syncInput([...values].join(",")); draw(); return true;
    }
    if (key === "?" && !input.text && !session.prompt) { session.message(SHORTCUTS); return true; }
    if (session.loginChallenge && ["\t", "\x1b[Z"].includes(key)) {
      loginAction = (loginAction + (key === "\t" ? 1 : 2)) % 3; draw(); return true;
    }
    if (session.loginChallenge && key === "\r" && !input.text) {
      if (loginAction === 0) void openBrowser(session.loginChallenge.verification_uri_complete);
      else if (loginAction === 1) session.emit("copy", session.loginChallenge.verification_uri_complete);
      else session.workOffline();
      focusChanged(); return true;
    }
    return false;
  };
  input.on("details", () => { if (!session.prompt) void execute("/details"); });
  input.on("redraw", () => { writer.clearLive(); locate(); draw(); });
  input.on("report", report => {
    const position = /^\x1b\[(\d+);(\d+)R$/.exec(report);
    if (position) { writer.located(Number(position[1]), Number(position[2])); return; }
    const value = /^\x1b\]1([01]);rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(report);
    if (value) reported[value[1] === "0" ? "fg" : "bg"] = value.slice(2).map(hex => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255));
  });
  input.on("exit", () => { try { session.close(); } catch (error) { session.report(error); } });
  const onData = chunk => {
    if (env.TERM === "dumb" && !input.pasting && (String(chunk).match(/[\r\n]/g)?.length ?? 0) > 1) {
      input.insert(String(chunk).replace(/\r\n?/g, "\n")); return;
    }
    input.feed(chunk);
  };
  const onResize = () => {
    // The vendor owns the TTY: not one byte; the new geometry is applied once on restore.
    if (vendorOwnsTerminal) { resizedDuringHandoff = true; return; }
    const plain = isPlain(), changed = plain !== writer.plain;
    writer.resized(plain); lastPlainIdentity = ""; showCursor(plain); locate();
    if (changed) print(plain ? "Plain view — terminal is small; all actions remain available." : "Rich view restored.", false);
    session.change(); draw();
  };
  const onSignal = () => { try { session.close(); } catch {} };
  const done = new Promise(resolve => session.once("close", resolve));
  stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData); stdout.on("resize", onResize);
  process.once("SIGTERM", onSignal); process.once("SIGHUP", onSignal); process.once("SIGINT", onSignal);
  if (env.TERM !== "dumb") stdout.write("\x1b[?2004h");
  process.on("exit", restoreCursor);
  if (writer.plain) writer.append(`Vecteur ${version}${channel === "preview" ? " · Preview" : ""} · ${safe(session.origin)}`);
  else { showCursor(false); locate(color ? "\x1b]10;?\x1b\\\x1b]11;?\x1b\\" : ""); }
  draw();
  void session.initialize().then(() => { if (!input.text) syncInput(session.draft); draw(); }).catch(error => session.report(error));
  try { await done; }
  finally {
    clearTimeout(frameTimer); clearInterval(clockTimer); input.close(); stdin.off("data", onData); stdout.off("resize", onResize);
    process.off("SIGTERM", onSignal); process.off("SIGHUP", onSignal); process.off("SIGINT", onSignal);
    writer.clearLive(); writer.close(); commitHeader(); showCursor(true); process.off("exit", restoreCursor);
    if (env.TERM !== "dumb") stdout.write("\x1b[?2004l");
    stdin.setRawMode(false); stdin.pause();
    stdout.write(session.restart ? "Restarting Vecteur…\n" : session.run?.open ? "Detached. The cloud Run continues; run vecteur here to follow it.\n" : "Session closed.\n");
  }
  if (session.restart) {
    const { restartUpdate } = await import("./update.js");
    process.exitCode = await restartUpdate(session.restart);
  }
}
