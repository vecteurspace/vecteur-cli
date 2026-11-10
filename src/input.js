import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

const START = "\x1b[200~", END = "\x1b[201~";
const MAX_BYTES = 256 * 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Stream decoder shared by both views; negotiated paste is one edit, never a send. */
export class ComposerInput extends EventEmitter {
  constructor() {
    super(); this.text = ""; this.cursor = 0; this.pending = ""; this.pasting = false;
    this.decoder = new StringDecoder("utf8"); this.pasted = "";
    this.undo = []; this.killed = ""; this.focusEpoch = 0;
  }
  set(text) { this.text = text; this.cursor = text.length; this.emit("change", this.text); }
  checkpoint() {
    if (this.undo.at(-1)?.text === this.text) return;
    this.undo.push({ text: this.text, cursor: this.cursor });
    if (this.undo.length > 12) this.undo.shift();
  }
  restore() {
    const previous = this.undo.pop();
    if (previous) { Object.assign(this, previous); this.emit("change", this.text); }
  }
  lineStart() { return this.cursor === 0 ? 0 : this.text.lastIndexOf("\n", this.cursor - 1) + 1; }
  lineEnd() { const end = this.text.indexOf("\n", this.cursor); return end < 0 ? this.text.length : end; }
  replace(from, to, value = "", cut = false) {
    this.checkpoint(); if (cut) this.killed = this.text.slice(from, to);
    this.text = this.text.slice(0, from) + value + this.text.slice(to); this.cursor = from + value.length;
    this.emit("change", this.text);
  }
  word(direction) {
    if (direction < 0) return this.text.slice(0, this.cursor).search(/[^\s]*\s*$/u);
    return this.cursor + (/^\s*\S*/u.exec(this.text.slice(this.cursor))?.[0].length ?? 0);
  }
  vertical(direction) {
    const start = this.lineStart(), end = this.lineEnd(), column = this.cursor - start;
    if (direction < 0 && start > 0) {
      const previous = this.text.lastIndexOf("\n", start - 2) + 1;
      this.cursor = Math.min(start - 1, previous + column);
    } else if (direction > 0 && end < this.text.length) {
      const nextEnd = this.text.indexOf("\n", end + 1);
      this.cursor = Math.min(nextEnd < 0 ? this.text.length : nextEnd, end + 1 + column);
    } else { this.emit("history", direction); return; }
    // Clamp vertical movement to a grapheme boundary, never inside a surrogate/emoji.
    const boundary = [...[...graphemes.segment(this.text)].map(row => row.index), this.text.length].findLast(index => index <= this.cursor);
    this.cursor = boundary ?? 0;
  }
  boundary(direction) {
    if (this.segmentedText !== this.text) {
      this.segmentedText = this.text;
      this.boundaries = [...graphemes.segment(this.text)].map(item => item.index);
      this.boundaries.push(this.text.length);
    }
    if (direction < 0) return this.boundaries.findLast(index => index < this.cursor) ?? 0;
    return this.boundaries.find(index => index > this.cursor) ?? this.text.length;
  }
  insert(text) {
    const value = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    if (Buffer.byteLength(value) > MAX_BYTES) { this.emit("notice", "Draft is too large; attach a file instead."); return; }
    this.checkpoint();
    this.text = value; this.cursor += text.length; this.emit("change", this.text);
  }
  feed(bytes, { unbracketed = false } = {}) {
    clearTimeout(this.escapeTimer);
    const epoch = this.focusEpoch;
    let chunk = typeof bytes === "string" ? bytes : this.decoder.write(bytes);
    // Unmarked multiline reads are drafts, including every trailing CR. A split read
    // consisting only of CR/CRLF is indistinguishable from Enter without negotiation.
    if (unbracketed) chunk = chunk === "\r\n" ? "\r" : chunk === "\r" ? chunk : chunk.replace(/\r\n?/g, "\n");
    this.pending += chunk;
    while (this.pending) {
      if (this.pasting) {
        const end = this.pending.indexOf(END);
        if (end < 0) {
          const take = Math.max(0, this.pending.length - END.length + 1);
          this.pasted += this.pending.slice(0, take); this.pending = this.pending.slice(take);
          if (Buffer.byteLength(this.pasted) > MAX_BYTES) { this.pasted = ""; this.pasteOverflow = true; }
          return;
        }
        this.pasted += this.pending.slice(0, end); this.pending = this.pending.slice(end + END.length);
        if (!this.pasteOverflow) this.insert(this.pasted.replace(/\r\n?/g, "\n"));
        else this.emit("notice", "Paste exceeds the draft limit; attach the file instead.");
        this.pasted = ""; this.pasting = false; this.pasteOverflow = false; continue;
      }
      if (this.pending.startsWith(START)) { this.pasting = true; this.pending = this.pending.slice(START.length); continue; }
      // Terminal replies to the writer's own queries are never keys, early or late: a colour
      // report (OSC 10/11) is recognised by its own form, any OSC while the writer awaits one.
      // A bare Alt+] keeps its meaning.
      const report = /^\x1b\](?:1(?:[01](?:;(?:r(?:g(?:b(?::[0-9a-f/]*)?)?)?)?)?)?)?/i.exec(this.pending)?.[0] ?? "";
      if (this.pending.startsWith("\x1b]") && (this.expectReports || report.length > 2)) {
        const end = /\x07|\x1b\\/.exec(this.pending);
        if (!end && this.pending.length < 256 && (this.expectReports || report.length === this.pending.length)) {
          this.escapeTimer = setTimeout(() => { this.pending = ""; }, 300); return;
        }
        const length = end ? end.index + end[0].length : 2;
        const reply = this.pending.slice(0, length); this.pending = this.pending.slice(length);
        if (end) this.emit("report", reply);
        continue;
      }
      if (this.pending.startsWith("\x1b")) {
        if (this.pending.startsWith("\x1b\x1b")) {
          // Escape followed by an arrow/Alt-Enter keeps that encoded key intact.
          const encodedTail = /^\x1b\x1b(?:\[|\r|\n)/.test(this.pending);
          this.pending = this.pending.slice(encodedTail ? 1 : 2);
          if (epoch === this.focusEpoch) {
            this.emit("cancel"); if (!encodedTail && epoch === this.focusEpoch) this.emit("cancel");
          }
          continue;
        }
        if (this.pending.startsWith("\x1b\r") || this.pending.startsWith("\x1b\n")) {
          this.pending = this.pending.slice(2); this.insert("\n"); continue;
        }
        if (/^\x1b[bf]/.test(this.pending)) {
          const direction = this.pending[1] === "b" ? -1 : 1;
          this.pending = this.pending.slice(2); this.cursor = this.word(direction); this.emit("change", this.text); continue;
        }
        const escape = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending)?.[0];
        if (escape) {
          this.pending = this.pending.slice(escape.length);
          if (/^\x1b\[\d+;\d+R$/.test(escape)) { this.emit("report", escape); continue; }
          if (this.handleKey?.(escape)) continue;
          if (escape === "\x1b[D") this.cursor = this.boundary(-1);
          else if (escape === "\x1b[C") this.cursor = this.boundary(1);
          else if (["\x1b[H", "\x1b[1~"].includes(escape)) this.cursor = this.lineStart();
          else if (["\x1b[F", "\x1b[4~"].includes(escape)) this.cursor = this.lineEnd();
          else if (escape === "\x1b[3~") this.replace(this.cursor, this.boundary(1));
          else if (escape === "\x1b[A") this.vertical(-1);
          else if (escape === "\x1b[B") this.vertical(1);
          else if (escape === "\x1b[13;2u" || escape === "\x1b[27;2;13~") this.insert("\n");
          this.emit("change", this.text); continue;
        }
        this.escapeTimer = setTimeout(() => {
          if (this.pending === "\x1b") { this.pending = ""; if (epoch === this.focusEpoch) this.emit("cancel"); }
          else { this.pending = ""; this.emit("notice", "Unsupported terminal key sequence"); }
        }, 40);
        return;
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0)); this.pending = this.pending.slice(char.length);
      if (epoch !== this.focusEpoch && /[\r\x03\x04]/.test(char)) continue;
      if (this.handleKey?.(char)) continue;
      if (char === "\r") {
        if (this.text[this.cursor - 1] === "\\") this.replace(this.cursor - 1, this.cursor, "\n");
        else this.emit("submit", this.text);
      }
      else if (char === "\n") this.insert("\n");
      else if (char === "\x03") this.emit("interrupt");
      else if (char === "\x04") { if (!this.text) this.emit("exit"); else this.replace(this.cursor, this.boundary(1)); }
      else if (char === "\x0f") this.emit("details");
      else if (char === "\x15") this.replace(this.lineStart(), this.cursor, "", true);
      else if (char === "\x0b") this.replace(this.cursor, this.lineEnd(), "", true);
      else if (char === "\x17") this.replace(this.word(-1), this.cursor, "", true);
      else if (char === "\x19") this.insert(this.killed);
      else if (char === "\x1f") this.restore();
      else if (char === "\x12") this.emit("search");
      else if (char === "\x0c") this.emit("redraw");
      else if (char === "\x01") { this.cursor = this.lineStart(); this.emit("change", this.text); }
      else if (char === "\x05") { this.cursor = this.lineEnd(); this.emit("change", this.text); }
      else if (char === "\x7f" || char === "\b") {
        const next = this.boundary(-1);
        this.replace(next, this.cursor);
      } else if (char === "\t") { if (this.listenerCount("complete")) this.emit("complete"); else this.insert("  "); }
      else if (char >= " " && char !== "\x7f") this.insert(char);
    }
  }
  close() { clearTimeout(this.escapeTimer); }
}
