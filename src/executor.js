/** The foreground process owns consent, a per-Run secret and one bounded shell process group. */
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { localProcessEnv, scanContent, withLocalLock, pinCheck, walk, closeChain, consumeExec } from './localfiles.js';
import { CliError } from './errors.js';
import { validateLocalExecStatus } from './contract.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new CliError('protocol_invalid', 'Invalid local executor protocol'); };

export function ring(cap) {
  let bytes = Buffer.alloc(0), count = 0;
  return {
    push(chunk) { count += chunk.length; bytes = Buffer.concat([bytes, chunk.subarray(-cap)]).subarray(-cap); },
    get count() { return count; },
    finish() {
      let start = 0;
      if (count > bytes.length) while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      const tail = bytes.subarray(start);
      if (tail.length) scanContent(tail, 'stdout.txt');
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(tail), count, truncated: count > tail.length };
    },
  };
}

export class Executor {
  constructor({ client, grant, pin, env = process.env, approve = null, session = false }) {
    this.client = client; this.grant = grant; this.pin = pin; this.env = env;
    this.approve = approve; this.session = session; this.closed = false; this.unknown = false; this.paused = false; this.revoked = false;
    this.secret = randomBytes(32).toString('hex'); this.descriptor = { secret_sha256: hash(Buffer.from(this.secret, 'hex')) };
    this.abort = new AbortController();
    this.seen = new Set(); this.active = null;
  }

  check({ allowPaused = false } = {}) {
    if (this.closed || this.unknown || !this.secret || this.paused && !allowPaused) throw new CliError('executor_revoked', 'Local execution stopped');
    pinCheck(this.grant, this.pin(), this.env, { execution: true });
  }

  stop(reason = 'outcome_unknown') {
    this.closed = true; this.revoked ||= reason === 'executor_revoked'; this.abort.abort();
    this.active?.stop(reason);
    this.secret = null;
  }

  async pump(runId) {
    this.runId = runId;
    let task = null;
    try {
      while (!this.closed) {
        await withLocalLock(() => this.check({ allowPaused: true }), this.env, { timeout: 2000 });
        const polledAt = performance.now();
        const reply = await this.client.localExec(runId, { secret: this.secret });
        if (!validateLocalExecStatus(reply) || reply.requests.length > 1) fail();
        if (reply.stop) break;
        this.paused = reply.paused;
        if (this.paused) {
          if (task) task.interrupted = true;
          this.approval?.abort(); this.active?.stop('executor_revoked');
        }
        for (const request of reply.requests) {
          if (!task && !this.seen.has(request.id)) {
            this.seen.add(request.id);
            const current = { interrupted: false }; task = current;
            current.done = this.execute(request, polledAt).catch(() => { if (!current.interrupted) this.stop(); })
              .finally(() => { if (task === current) task = null; });
          }
        }
        await sleep(1000);
      }
    } finally {
      this.stop();
      await task?.done;
    }
  }

  async execute(request, polledAt = performance.now()) {
    const { id, command, timeout, approval_remaining, hard_remaining } = request;
    const secret = this.secret;
    // Subtract the entire poll round trip conservatively; server and client wall clocks may differ.
    const approval = polledAt + approval_remaining*1000, hard = polledAt + hard_remaining*1000;
    if (!/^[0-9a-f]{32}$/.test(id) || typeof command !== 'string' || command.includes('\0')
        || !Buffer.byteLength(command) || Buffer.byteLength(command) > 8192
        || !Number.isInteger(timeout) || timeout < 1 || timeout > 600 || !Number.isFinite(approval)
        || !Number.isFinite(hard) || hard <= performance.now() || request.state !== 'pending') fail();
    let choice = this.session ? 'session' : null, alarm;
    const approvalAbort = this.approval = new AbortController();
    const cancelApproval = () => approvalAbort.abort();
    if (!choice) {
      this.abort.signal.addEventListener('abort', cancelApproval, { once: true });
      if (!this.approve) fail();
      choice = await Promise.race([
        // Leaving the open prompt (Esc, cancel) is a decline; the server must see a refusal, never silence.
        this.approve({ command, timeout, folder: this.grant.root.path, signal: approvalAbort.signal }).catch(e => { if (e?.code === 'action_cancelled') return 'decline'; throw e; }),
        new Promise(resolve => { alarm = setTimeout(() => { resolve('expired'); approvalAbort.abort(); }, Math.max(0, approval-performance.now())); }),
      ]).finally(() => {
        if (this.approval === approvalAbort) this.approval = null;
        clearTimeout(alarm); this.abort.signal.removeEventListener('abort', cancelApproval);
      });
    }
    // Explicit revocation while the prompt was open: the server must record executor_revoked, not_started.
    if (this.revoked) { await this.client.localExec(this.runId, { secret, action: 'refuse', code: 'executor_revoked' }, id); return; }
    if (this.closed) return; // stop-driven cancel: not the user's decision, and the secret is gone
    await withLocalLock(() => this.check(), this.env, { timeout: 2000 });
    if (!['once', 'session'].includes(choice)) {
      await this.client.localExec(this.runId, { secret: this.secret, action: 'refuse', code: choice === 'expired' ? 'approval_timeout' : 'user_declined' }, id);
      return;
    }
    if (choice === 'session') this.session = true;
    const nonce = randomBytes(32).toString('hex');
    const ack = await this.client.localExec(this.runId, { secret: this.secret, action: 'start', nonce }, id);
    if (ack?.permit !== true || ack.state !== 'started') return;
    let chain, execution;
    try {
      await withLocalLock(() => {
        this.check();
        if (performance.now() + (timeout + 2)*1000 > hard) fail();
        consumeExec(this.runId, id, this.env);
        chain = walk(this.grant);
        execution = this.shell(id, command, timeout, chain[0].fd);
      }, this.env);
      // No await between the last pin check, permit consumption and spawn.
      const answer = await execution;
      if (answer.effect === 'unknown') this.unknown = true;
      // Revocation bars starts immediately; the consumed permit may still seal its typed outcome.
      if (!this.secret && answer.code !== 'executor_revoked') return;
      const body = { secret, action: 'seal', nonce, result: answer };
      try { await this.client.localExec(this.runId, body, id); }
      catch { await this.client.localExec(this.runId, body, id); } // identical seal only; never repeat spawn
    } finally { if (chain) closeChain(chain); }
  }

  async shell(id, command, timeout, fd) {
    const start = performance.now(), out = ring(16000), err = ring(8000);
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd: `/proc/${process.pid}/fd/${fd}`, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: localProcessEnv(this.env, this.grant.root.path),
    });
    let reason = null, escalation, failed = false;
    const kill = signal => { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const stop = why => {
      if (why && !reason) reason = why;
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 2000);
    };
    this.active = { stop };
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', () => { failed = true; });
    child.on('exit', () => stop(null)); // descendants may still hold the pipes after their leader exits
    const wall = setTimeout(() => stop('timeout'), timeout * 1000);
    const code = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(wall);
    if (escalation) { kill('SIGKILL'); clearTimeout(escalation); }
    this.active = null;
    const result = { request_id: id, code: failed ? 'spawn_failed' : reason ?? (code === 0 ? 'ok' : 'command_failed'),
      exit_code: code, seconds: (performance.now()-start)/1000, stdout_tail: '', stderr_tail: '', stdout_bytes: out.count, stderr_bytes: err.count,
      truncated: { stdout: out.count > 16000, stderr: err.count > 8000 }, effect: failed ? 'not_started' : reason ? 'unknown' : 'completed' };
    // Counts survive a refusal; no unscanned text is ever attached to an error or persisted.
    const streams = [];
    for (const [stream, buffer] of [['stdout', out], ['stderr', err]]) {
      try { streams.push([stream, buffer.finish()]); }
      catch (error) { result.code = error.code === 'secret_suspected' ? error.code : 'scan_unsupported'; }
    }
    for (const [stream, data] of streams) {
      result[stream+'_bytes'] = data.count; result.truncated[stream] = data.truncated;
      if (!['secret_suspected', 'scan_unsupported'].includes(result.code)) result[stream+'_tail'] = data.text;
    }
    return result;
  }
}
