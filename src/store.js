import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";

const held = new Set();
const pause = new Int32Array(new SharedArrayBuffer(4));
const MAX_STORE_BYTES = 16 * 1024 * 1024;

function privateDirectory(file) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
      || (process.getuid && info.uid !== process.getuid())) {
    throw new CliError("store_permissions", `${directory} must be a private directory owned by you`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077)) chmodSync(directory, 0o700);
}

/** Locks cover only synchronous read-modify-write, never network or user input. */
export function withStoreLock(file, action) {
  if (held.has(file)) return action();
  privateDirectory(file);
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3_000;
  let fd;
  while (fd === undefined) {
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new CliError("store_locked",
        `${file} is locked; close the other Vecteur writer. If it crashed, inspect ${lock} before removing the lock.`);
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
    fsyncSync(fd);
    held.add(file);
    return action();
  } finally {
    held.delete(file);
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Rename publishes complete bytes; a crash leaves the previous complete version readable. */
export function writeStore(file, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new CliError("store_full", "Local store exceeds 16 MiB; existing bytes were preserved");
  privateDirectory(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  catch (error) { unlinkSync(temporary); throw error; }
  finally { closeSync(fd); }
  try { renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  return file;
}

export function readStore(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_STORE_BYTES) throw new Error("Not a bounded regular file");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (value === null) throw new Error("Store is null");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new CliError("store_unreadable", `${file} is not a readable regular JSON store; existing bytes were preserved`);
  } finally { if (fd !== undefined) closeSync(fd); }
}
