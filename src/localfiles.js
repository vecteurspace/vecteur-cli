/** Linux local authority. Pathnames from a Run are untrusted; only this owner reads selections or installs saves.
 * Same-user hostile rename/check/syscall races are outside the qualified boundary (see README).
 */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, isAbsolute, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialsPath, readCredentials } from './credentials.js';
import { readStore, writeStore } from './store.js';
import { CliError } from './errors.js';
import { ARTIFACT_MEDIA_TYPES } from './contract.js';
import { MEDIA, selectSource } from './exchange.js';

export const MAX_SELECT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT = 64 * 1024 * 1024;
function statInfo(info) {
  return {dev:info.dev,ino:info.ino,size:Number(info.size),mtimeMs:Number(info.mtimeNs)/1e6,ctimeMs:Number(info.ctimeNs)/1e6,mtimeNs:info.mtimeNs,ctimeNs:info.ctimeNs,nlink:Number(info.nlink),
    isFile:()=>info.isFile(),isDirectory:()=>info.isDirectory(),isSymbolicLink:()=>info.isSymbolicLink()};
}
const stat=path=>statInfo(fs.statSync(path,{bigint:true}));
const lstat=path=>statInfo(fs.lstatSync(path,{bigint:true}));
const fstat=fd=>statInfo(fs.fstatSync(fd,{bigint:true}));
function readBounded(fd,size) {
  const bytes=Buffer.alloc(size+1);let length=0,n;
  while(length<bytes.length && (n=fs.readSync(fd,bytes,length,bytes.length-length,null))>0)length+=n;
  return bytes.subarray(0,length);
}
const C = fs.constants, DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
const READ = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY;
const context = new AsyncLocalStorage();
const fail = (code, message = code) => { throw new CliError(code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => String(a.dev ?? a.device) === String(b.dev ?? b.device) && String(a.ino ?? a.inode) === String(b.ino ?? b.inode);
const inode = info => ({ device: String(info.dev), inode: String(info.ino) });
const beneath = (root, child) => {
  const path = relative(root, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
};
const proc = (fd, name) => `/proc/self/fd/${fd}${name === undefined ? '' : '/' + name}`;
const absent = path => { try { return lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function qualify({ platform = process.platform, version = process.versions.node } = {}) {
  const [major, minor] = version.split('.').map(Number);
  if (platform !== 'linux' || major < 20 || (major === 20 && minor < 8)) fail('platform_unqualified', 'Local file authority requires Linux and Node >=20.8');
}
export const localProcessEnv = (env, root) => ({ PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? root,
  TMPDIR: env.TMPDIR, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' });
function directory(env) { return dirname(credentialsPath(env)); }
function store(env, name) { return join(directory(env), name + '.json'); }
function readGrants(env) {
  const value=readStore(store(env,'local-grants'))??{version:1,grants:{},generations:{},pending:{}};
  if(value.version!==1)fail('store_version_unsupported','Local grant store version is unsupported; bytes preserved');
  if(!value.grants || !value.generations || typeof value.grants!=='object' || typeof value.generations!=='object')fail('store_unreadable','Invalid local grant store; bytes preserved');
  // An interrupted/EIO grant-store commit must not restore authority. The fsynced journal
  // intent supplies the generation floor until the grant-store update is durable.
  for (const [key, generation] of Object.entries(journal(env).grantEnds ?? {})) {
    if ((value.grants[key]?.generation ?? Infinity) < generation) delete value.grants[key];
    if ((value.pending?.[key]?.generation ?? Infinity) < generation) delete value.pending[key];
    value.generations[key] = Math.max(value.generations[key] ?? 0, generation);
  }
  return value;
}
function journal(env) {
  const value=readStore(store(env,'local-writes'))??{version:1,writes:[],uploads:[],tombstones:{},admissions:{}};
  if(value.version!==1)fail('store_version_unsupported','Local write store version is unsupported; bytes preserved');
  if(!Array.isArray(value.writes)||!Array.isArray(value.uploads)||!value.tombstones||!value.admissions)fail('store_unreadable','Invalid local write store; bytes preserved');
  return value;
}
function saveJournal(env, value) { writeStore(store(env, 'local-writes'), value); }
function requireLock(env) {
  try { qualify(); } catch(e) { if(e.code==='platform_unqualified') return; throw e; }
  if (!context.getStore()?.active || context.getStore()?.canonical !== fs.realpathSync(directory(env))) fail('local_lock_required');
}
export function localLockName(env = process.env) {
  qualify();
  fs.mkdirSync(directory(env), { recursive: true, mode: 0o700 });
  return '\0vecteur-local-' + process.getuid() + '-' + hash(fs.realpathSync(directory(env)));
}
export async function withLocalLock(action, env = process.env, { timeout = 30_000 } = {}) {
  const name = localLockName(env), canonical = fs.realpathSync(directory(env));
  if (context.getStore()?.active && context.getStore()?.canonical === canonical) fail('local_lock_reentrant', 'Nested local authority lock is a programming error');
  const deadline = Date.now() + timeout;
  let server;
  while (true) {
    server = createServer();
    try {
      await new Promise((ok, no) => { server.once('error', no); server.listen({ path: name }, ok); });
      break;
    } catch (e) {
      server.close();
      if (e.code !== 'EADDRINUSE') throw e;
      if (Date.now() >= deadline) fail('local_locked', 'Another Vecteur process holds local file authority');
      await new Promise(ok => setTimeout(ok, 25));
    }
  }
  const lease={canonical,active:true};
  try { return await context.run(lease, action); }
  finally { lease.active=false; await new Promise((ok, no) => server.close(e => e ? no(e) : ok())); }
}

export async function withAdmissionLock(action, env = process.env) {
  try { qualify(); } catch(e) { if(e.code==='platform_unqualified') return action(); throw e; }
  return withLocalLock(action,env);
}

/** The existing bin logout and registry APIs are synchronous. Their complete mutation runs in a child holding
 * the same async lock; no lock file, detached work, or early-return promise can leave a grant live after logout.
 * Callers already holding the local lock execute in that context (local -> short synchronous store lock).
 */
export function localMutation(kind, data, env, action) {
  try { qualify(); } catch(e) { if(e.code==='platform_unqualified') return action(); throw e; }
  fs.mkdirSync(directory(env), { recursive: true, mode: 0o700 });
  if (context.getStore()?.active && context.getStore()?.canonical === fs.realpathSync(directory(env))) return action();
  const script = `import {withLocalLock} from ${JSON.stringify(import.meta.url)};
    let text=''; for await (const c of process.stdin) text+=c; const p=JSON.parse(text);
    try { const value=await withLocalLock(async()=>{
      if(p.kind==='credentials'){ const {clearCredentials}=await import('./credentials.js'); return clearCredentials(p.env,p.data.origin); }
      const {FolderRegistry}=await import('./folders.js'); const r=new FolderRegistry({...p.data,env:p.env});
      return r[p.kind](...p.data.args);
    },p.env); process.stdout.write(JSON.stringify({value})); }
    catch(e){process.stdout.write(JSON.stringify({error:{code:e.code,message:e.message}}));process.exitCode=1;}`;
  // Absolute URL imports in the child: its cwd is this module's directory, never the user's selected folder.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dirname(fileURLToPath(import.meta.url)), env: { ...process.env, ...env },
    input: JSON.stringify({ kind, data, env }), encoding: 'utf8', timeout: 35_000, maxBuffer: 1024 * 1024,
  });
  if (child.error) throw child.error;
  let result; try { result = JSON.parse(child.stdout); } catch { fail('local_mutation_failed', 'Local mutation helper failed'); }
  if (result.error) fail(result.error.code ?? 'local_mutation_failed', result.error.message);
  return result.value;
}
export function endGrants({ origin, accountId, root } = {}, env = process.env) {
  requireLock(env);
  const file = store(env, 'local-grants');
  const value = readGrants(env);
  const intent = journal(env); intent.grantEnds ??= {};
  const affected = [];
  // An invocation may hold only an in-memory execution marker. An explicit folder
  // revoke must still advance its generation, even before any file grant exists.
  const explicit = origin && accountId && root ? {
    [grantKey({ origin, accountId, root: { path: root } })]: { origin, accountId, root: { path: root }, generation: 0 },
  } : {};
  for (const [key, grant] of Object.entries({ ...explicit, ...value.pending, ...value.grants })) {
    if (origin && origin !== grant.origin || accountId && accountId !== grant.accountId || root && !beneath(root, grant.root.path)) continue;
    delete value.grants[key]; if(value.pending) delete value.pending[key];
    value.generations[key] = (value.generations[key] ?? grant.generation) + 1;
    intent.grantEnds[key] = value.generations[key]; affected.push(key);
  }
  if (affected.length) saveJournal(env, intent);
  writeStore(file, value);
  if (affected.length) {
    for (const key of affected) delete intent.grantEnds[key];
    saveJournal(env, intent);
  }
}
export const grantKey = ({ origin, accountId, root }) => hash(JSON.stringify([origin, accountId, root.path]));
export function currentGrant(pin, env = process.env) { return readGrants(env).grants[grantKey(pin)] ?? null; }
export function prepareConsent(pin, env = process.env) {
  requireLock(env); const value=readGrants(env), key=grantKey(pin);
  value.pending ??= {}; value.pending[key]={origin:pin.origin,accountId:pin.accountId,root:pin.root,generation:value.generations[key]??0};
  writeStore(store(env,'local-grants'),value); return value.generations[key]??0;
}
export function checkConsent(pin, epoch, env = process.env) {
  requireLock(env); const value=readGrants(env);
  const key=grantKey(pin);
  if (!value.pending?.[key] || !same(value.pending[key].root,pin.root) || (value.generations[key]??0)!==epoch) fail('grant_changed','Consent destination changed; review and confirm again');
}
export function createGrant(pin, env = process.env, epoch = undefined) {
  requireLock(env);
  if (pin.role === 'VIEWER') fail('role_forbidden', 'Editor access is required for local file authority');
  if(epoch!==undefined)checkConsent(pin,epoch,env);
  const root = rootIdentity(pin.root.path);
  if (!same(root, pin.root)) fail('folder_replaced');
  const value = readGrants(env), key = grantKey(pin);
  const generation = (value.generations[key] ?? 0) + 1;
  const grant = { origin: pin.origin, accountId: pin.accountId, projectId: pin.projectId, root,
    provenance: pin.provenance, generation, capabilities: ['select', 'save-new'], created_at: new Date().toISOString() };
  value.generations[key] = generation; value.grants[key] = grant; if(value.pending)delete value.pending[key];
  writeStore(store(env, 'local-grants'), value); return grant;
}
export function rootIdentity(path) {
  const real = fs.realpathSync(path), info = stat(real);
  if (!info.isDirectory()) fail('folder_invalid');
  return { path: real, ...inode(info) };
}
export function executionGrant(pin, env = process.env) {
  requireLock(env);
  const grant = currentGrant(pin, env) ?? { ...pin, generation: readGrants(env).generations[grantKey(pin)] ?? 0 };
  return { ...grant, execCredential: pin.credential.token, execPid: process.pid };
}
export function checkGrantLive(grant, pin, env = process.env) {
  requireLock(env);
  if (grant.accountId !== pin.accountId || grant.origin !== pin.origin || grant.root.path !== pin.root.path || grant.execCredential !== pin.credential.token
    || (readGrants(env).generations[grantKey(grant)] ?? 0) !== grant.generation) fail('grant_changed', 'Local permission changed; draft kept. Confirm again.');
}
export function consumeExec(runId, requestId, env = process.env) {
  requireLock(env);
  const value = journal(env); value.executions ??= [];
  if (value.executions.some(row => row.runId === runId && row.requestId === requestId)) fail('executor_consumed');
  value.executions.push({runId,requestId}); saveJournal(env,value);
}
export function pinCheck(grant, pin, env = process.env, { execution = false } = {}) {
  requireLock(env);
  if (execution && (grant.execCredential !== pin.credential.token || grant.execPid !== process.pid)) fail('grant_changed');
  const live = currentGrant(grant, env) ?? (execution && (readGrants(env).generations[grantKey(grant)] ?? 0) === grant.generation ? grant : null);
  if (!live || live.generation !== grant.generation || live.projectId !== pin.projectId
      || pin.accountId !== grant.accountId || pin.origin !== grant.origin) fail('grant_changed', 'Local permission changed; draft kept. Confirm again.');
  if (pin.role === 'VIEWER') fail('role_forbidden');
  if (grant.provenance === 'binding' && pin.binding()?.projectId !== grant.projectId) fail('grant_changed');
  if (pin.credential.kind === 'environment') {
    if (!pin.credential.token || env.VECTEUR_TOKEN !== pin.credential.token) fail('grant_changed');
  } else if (!pin.credential.token || readCredentials(env)?.logins?.[grant.origin]?.token !== pin.credential.token) fail('grant_changed');
  try { if (!same(rootIdentity(grant.root.path), grant.root)) throw new Error('replaced'); }
  catch { endGrants({ origin: grant.origin, accountId: grant.accountId, root: grant.root.path }, env); fail('folder_replaced'); }
  return live;
}
export function components(rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0') || rel.includes('\\')) fail('outside_folder');
  const parts = rel.replace(/^\.\//, '').split('/');
  if (parts.length > 16 || parts.some(c => !c || c === '.' || c === '..' || Buffer.byteLength(c) > 255)) fail('outside_folder');
  return parts;
}
function openSafe(path, flags) {
  try { return fs.openSync(path, flags); }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'ENOTDIR') fail('symlink_refused');
    throw e;
  }
}
export function walk(grant, parts = [], { create, intent = () => {}, done = () => {}, created = () => {} } = {}) {
  qualify();
  if(!Array.isArray(parts)||parts.some(p=>typeof p!=='string'||p.includes('/')))fail('outside_folder');
  if(parts.length)components(parts.join('/'));
  const chain = [];
  try {
    const fd = openSafe(grant.root.path, DIR), info = fstat(fd);
    chain.push({ fd, path: grant.root.path });
    if (!same(info, grant.root)) fail('folder_replaced');
    let made = 0;
    for (const c of parts) {
      const parent = chain.at(-1), path = join(parent.path, c), anchored = proc(parent.fd, c);
      if (!absent(anchored) && create) {
        if (++made > 8) fail('too_many_directories');
        pathCheck(chain); intent(path); fs.mkdirSync(anchored, { mode: 0o755 }); created(path);
        const child = openSafe(anchored, DIR); chain.push({ fd: child, path });
        fs.fsyncSync(parent.fd); done(path, inode(fstat(child))); continue;
      }
      chain.push({ fd: openSafe(anchored, DIR), path });
    }
    pathCheck(chain); return chain;
  } catch (e) { closeChain(chain); throw e; }
}
export function closeChain(chain) { for (const { fd } of [...chain].reverse()) fs.closeSync(fd); }
export function pathCheck(chain) {
  for (const { fd, path } of chain) {
    try {
      if (fs.readlinkSync(proc(fd)) !== path || !same(stat(path), fstat(fd))) fail('folder_moved');
    } catch (e) { if (e.code === 'folder_moved') throw e; fail('folder_moved'); }
  }
}
const fixedNames = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.claude', '.codex', '.terraform.d', 'node_modules']);
function fixedDenied(grant, parts, env) {
  const full = join(grant.root.path, ...parts);
  let own = directory(env); try { own = fs.realpathSync(own); } catch {}
  return beneath(own, full) || parts.some((c, i) => fixedNames.has(c) || c.startsWith('.env') || /\.(?:pem|key)$/.test(c)
    || c.startsWith('id_') || c === '.config' && ['gh', 'gcloud'].includes(parts[i + 1]));
}
// Only git wildmatch syntax is accepted. Unknown constructs fail closed; no shell or global git configuration runs.
function patternRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { if (++i === pattern.length) fail('ignore_policy_unknown'); out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    else if (c === '*') {
      if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1); if (end < 0) fail('ignore_policy_unknown');
      const inner = pattern.slice(i + 1, end); if (!inner || inner.includes('[') || inner.includes('/')) fail('ignore_policy_unknown');
      out += '[' + (inner[0] === '!' ? '^' + inner.slice(1) : inner) + ']'; i = end;
    } else out += c.replace(/[.+^${}()|\]]/g, '\\$&');
  }
  try { return new RegExp('^' + out + '$'); } catch { fail('ignore_policy_unknown'); }
}
function policyFile(grant, rel) {
  let chain;
  try {
    if (rel === '.git/info/exclude') {
      chain = walk(grant, []);
      const git = absent(proc(chain[0].fd, '.git'));
      pathCheck(chain);
      if (!git || git.isFile()) return '';
      closeChain(chain); chain = undefined;
    }
    const p = components(rel); chain = walk(grant, p.slice(0, -1));
    const fd = openSafe(proc(chain.at(-1).fd, p.at(-1)), READ);
    chain.push({ fd, path: join(grant.root.path, ...p) });
    const info = fstat(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_SELECT_BYTES) fail('ignore_policy_unknown');
    const bytes=readBounded(fd,info.size),after=fstat(fd);
    if(bytes.length!==info.size || after.size!==info.size || after.mtimeNs!==info.mtimeNs || after.ctimeNs!==info.ctimeNs)fail('ignore_policy_unknown');
    const value = new TextDecoder('utf-8',{fatal:true}).decode(bytes); pathCheck(chain); return value;
  } catch (e) { if (e.code === 'ENOENT') return ''; if (['folder_replaced','folder_moved'].includes(e.code)) throw e; fail('ignore_policy_unknown'); }
  finally { if (chain) closeChain(chain); }
}
export function excluded(grant, rel, env = process.env, isDirectory = false) {
  const parts = components(rel);
  if (fixedDenied(grant, parts, env)) return true;
  const rules = [];
  function add(base, text) {
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/(?<!\\) +$/, ''); if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!'); if (negate) line = line.slice(1);
      const dir = line.endsWith('/'); if (dir) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.includes('/'); if (line.startsWith('/')) line = line.slice(1);
      if (!line) fail('ignore_policy_unknown');
      rules.push({ base, negate, dir, anchored, re: patternRegex(line) });
    }
  }
  add('', policyFile(grant, '.git/info/exclude'));
  for (let depth = 0; depth < parts.length; depth++) {
    const base = parts.slice(0, depth).join('/');
    for (const file of ['.gitignore', '.vecteurignore']) add(base, policyFile(grant, [base, file].filter(Boolean).join('/')));
  }
  // Git cannot re-include a descendant of an excluded directory without re-including the directory itself.
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join('/'), directory = depth < parts.length || isDirectory;
    let denied = false;
    for (const rule of rules) {
      if (rule.base && !prefix.startsWith(rule.base + '/')) continue;
      const name = rule.base ? prefix.slice(rule.base.length + 1) : prefix;
      if ((!rule.dir || directory) && rule.re.test(rule.anchored ? name : name.split('/').at(-1))) denied = !rule.negate;
    }
    if (denied) return true;
  }
  return false;
}
function allowed(grant, rel, env) { if (excluded(grant, rel, env)) fail('excluded', 'Excluded by local file policy; nothing sent or written'); }
export function targetStatus(grant, rel, env = process.env, {metadataOnly = false} = {}) {
  const p=components(rel);
  if (metadataOnly) { if(fixedDenied(grant,p,env))fail('excluded'); }
  else allowed(grant,rel,env);
  const chain=walk(grant);
  try {
    for(let i=0;i<p.length-1;i++){
      const parent=chain.at(-1),path=proc(parent.fd,p[i]);
      if(!absent(path))return {exists:false,creates:p.slice(0,-1).map((_,j)=>p.slice(0,j+1).join('/')).slice(i)};
      chain.push({fd:openSafe(path,DIR),path:join(parent.path,p[i])});
    }
    const info=absent(proc(chain.at(-1).fd,p.at(-1)));pathCheck(chain);
    return {exists:!!info,creates:[]};
  } finally {closeChain(chain);}
}
export function selectionMetadata(root, rel, env = process.env, { ifPresent = false } = {}) {
  const grant = { root }, p = components(rel);
  if (!ifPresent) allowed(grant, rel, env);
  const chain = walk(grant, p.slice(0, -1));
  try {
    const info = lstat(proc(chain.at(-1).fd, p.at(-1)));
    // Bare words that do not name an entry need no offer or policy notice. This
    // optional probe walks without following symlinks and reads no file content.
    if (ifPresent) allowed(grant, rel, env);
    if (info.isSymbolicLink()) fail('symlink_refused');
    if (!info.isFile()) fail('not_regular_file');
    if (info.nlink !== 1) fail('hardlink_refused');
    if (info.size < 1 || info.size > MAX_SELECT_BYTES) fail('attachment_invalid', 'Select a non-empty file no larger than 8 MiB');
    pathCheck(chain);
    return { rel: p.join('/'), size: info.size, ...inode(info) };
  } finally { closeChain(chain); }
}
const SECRET = /vct_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./;
function scanString(text) { if (SECRET.test(text)) fail('secret_suspected', 'Credential-shaped content refused; nothing uploaded'); }
function textDecode(bytes) {
  let encoding = 'utf-8', data = bytes;
  // A BOM selects the sole decoder. Unmarked input must be strict UTF-8.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) data = bytes.subarray(3);
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; data = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; data = bytes.subarray(2); }
  try { return new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch { fail('scan_unsupported'); }
}
// Include invisible marks such as variation selectors and the combining grapheme joiner.
const withoutControls = text => text.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, c => /[\t\r\n]/.test(c) ? c : '');
const scanNormalized = text => { scanString(text); scanString(withoutControls(text)); };
function scanText(bytes) {
  scanString(bytes.toString('latin1'));
  const text = textDecode(bytes); scanNormalized(text);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('scan_unsupported');
}
const TEXT_UPLOAD_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json',
  '.py', '.m', '.jl', '.r', '.c', '.h', '.cpp', '.f90', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.tex', '.rst']);
export function scanContent(bytes, rel = '') {
  try {
    if (bytes.includes(Buffer.from('%PDF-')) || extname(rel).toLowerCase() === '.pdf')
      fail('scan_unsupported', 'PDF files cannot be checked for credentials before upload yet; upload this PDF in the web app, or attach a text/CSV/Markdown export.');
    const extension = extname(rel).toLowerCase();
    // Refuse containers before decoding, including renamed and prefixed ZIP/OOXML files.
    if (bytes.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
        bytes.length >= 4 && [0x06054b50, 0x08074b50].includes(bytes.readUInt32LE(0)) ||
        ['.docx', '.docm', '.dotx', '.dotm', '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb', '.xlam', '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam', '.sldx', '.sldm', '.zip'].includes(extension))
      fail('scan_unsupported', 'Word files cannot be checked for credentials before upload yet; upload it in the web app, or attach a text/CSV/Markdown export');
    scanString(bytes.toString('latin1'));
    if (!TEXT_UPLOAD_EXTENSIONS.has(extension)) fail('scan_unsupported', 'Local file uploads require a text/CSV/Markdown export or a supported code/configuration text file');
    scanText(bytes);
  } catch (e) { if (e instanceof CliError) throw e; fail('scan_unsupported'); }
}
export function readConfined(grant, rel, env = process.env, { selected, hook = () => {}, allowEmpty = false } = {}) {
  const p = components(rel); allowed(grant, rel, env);
  const chain = walk(grant, p.slice(0, -1));
  try {
    hook('before_open', chain);
    const before = lstat(proc(chain.at(-1).fd, p.at(-1)));
    const fd = openSafe(proc(chain.at(-1).fd, p.at(-1)), READ);
    chain.push({ fd, path: join(grant.root.path, ...p) }); hook('opened', chain);
    const info = fstat(fd);
    if (!info.isFile()) fail('not_regular_file');
    if (info.nlink !== 1) fail('hardlink_refused');
    pathCheck(chain);
    if (!same(info, before) || info.size !== before.size || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs || selected && (!same(info, selected) || info.size !== selected.size)) fail('attachment_changed');
    if (info.size < (allowEmpty ? 0 : 1) || info.size > MAX_SELECT_BYTES) fail('attachment_invalid');
    const bytes = readBounded(fd,info.size), after = fstat(fd);
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) fail('attachment_changed');
    hook('read', chain); pathCheck(chain); allowed(grant, rel, env); scanContent(bytes, rel);
    return { rel, bytes, sha256: hash(bytes), size: bytes.length, mtime_ms: after.mtimeMs, media: MEDIA[extname(rel).toLowerCase()] ?? 'text/plain' };
  } finally { closeChain(chain); }
}
/** Explicit --attach consent lasts only for this call, for these paths and this authenticated destination.
 * Reuse the qualified reader, policy and scan. Preflight the entire set before any upload.
 * The caller holds the local admission lock through selection, request freezing and admission.
 */
export async function selectInvocationFiles(client, projectId, paths, { cwd = process.cwd(), env = process.env, signal } = {}) {
  qualify(); requireLock(env);
  const origin = client.config.origin, token = client.config.token;
  const project = await client.projectGet(projectId, signal);
  if (project.role === 'VIEWER') fail('role_forbidden', 'Editor access is required to attach files');
  // The exact active credential pins the principal for this call. /auth/me is account-PAT-only;
  // Project PATs already authorize projectGet/inputAdd and need no additional permission.
  const grant = { origin, projectId, root: rootIdentity(cwd), capabilities: ['select'] };
  const explicit = [...new Set(paths.map(path => relative(grant.root.path, resolve(cwd, path))))].sort();
  if (!explicit.length || explicit.length > 8) fail('attachment_invalid', 'Select one to eight explicit files');
  const check = () => {
    if (client.config.origin !== origin || client.config.token !== token
        || (env.VECTEUR_TOKEN ? env.VECTEUR_TOKEN : readCredentials(env)?.logins?.[origin]?.token) !== token) fail('grant_changed');
    if (!same(rootIdentity(grant.root.path), grant.root)) fail('folder_replaced');
  };
  check();
  const files = explicit.map(rel => readConfined(grant, rel, env));
  if (files.reduce((n, file) => n + file.size, 0) > 32 * 1024 * 1024) fail('attachment_invalid', 'Selection exceeds 32 MiB');
  const selections = [];
  for (const file of files) {
    check();
    const current = readConfined(grant, file.rel, env);
    if (current.sha256 !== file.sha256) fail('attachment_changed');
    const source = await client.inputAdd(projectId, current.bytes, current.media, signal);
    check();
    selections.push(await selectSource(client, projectId, source, signal));
  }
  check(); return selections;
}
export function recordUpload(grant, file, source, env = process.env) {
  requireLock(env); const j = journal(env);
  j.uploads.push({ scope: scope(grant), rel: file.rel, size: file.size, mtime_ms: file.mtime_ms,
    sha256: file.sha256, generation: grant.generation, cas_ref: source.cas_ref, acquisition_ref: source.acquisition_ref });
  establishBase(j, grant, file.rel, file.bytes, file.sha256, 'uploaded', env); saveJournal(env, j);
}
export function scope(grant) { return hash(JSON.stringify([grant.origin, grant.accountId, grant.root, grant.projectId])); }
export function tombstoned(grant, rel, env = process.env) {
  const j = journal(env), key = scope(grant);
  return !!(j.tombstones[key]?.[rel] || j.observed?.[key]?.[rel]);
}

const MAX_BASE_STORE = 256 * 1024 * 1024;
function baseDirectory(env) {
  const path = join(directory(env), 'local-bases');
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) fail('store_permissions');
  fs.chmodSync(path, 0o700); return path;
}
/** Private content-addressed snapshots only. All writes/eviction share the local authority lock. */
function retainBase(bytes, sha256, env) {
  requireLock(env);
  if (!bytes || bytes.length > MAX_SELECT_BYTES || hash(bytes) !== sha256) return;
  const dir = baseDirectory(env), path = join(dir, sha256);
  if (readBase(sha256, env)) return;
  const files = fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}$/.test(n)).map(name => ({name, info:fs.lstatSync(join(dir,name))}));
  let total = files.reduce((n,f) => n + f.info.size, 0);
  for (const file of files.sort((a,b) => a.info.mtimeMs-b.info.mtimeMs || a.name.localeCompare(b.name))) {
    if (total + bytes.length <= MAX_BASE_STORE && file.name !== sha256) continue;
    if (!file.info.isFile() || file.info.nlink !== 1) fail('store_permissions');
    fs.unlinkSync(join(dir,file.name)); total -= file.info.size;
  }
  const fd = fs.openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dfd = fs.openSync(dir, DIR); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}
export function readBase(sha256, env = process.env) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) return null;
  let fd;
  try {
    const dir = join(directory(env),'local-bases'), parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) return null;
    fd = fs.openSync(join(dir,sha256), READ);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > MAX_SELECT_BYTES || (info.mode & 0o777) !== 0o600) return null;
    const bytes = readBounded(fd, info.size);
    return bytes.length === info.size && hash(bytes) === sha256 ? bytes : null;
  } catch { return null; } // A missing/unreadable snapshot never erases its journalled hash or provenance.
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function establishBase(j, grant, rel, bytes, sha256, provenance, env) {
  retainBase(bytes, sha256, env);
  const key = scope(grant);
  ((j.baselines ??= {})[key] ??= {})[rel] = {last_synced_sha256:sha256, provenance};
  ((j.observed ??= {})[key] ??= {})[rel] = true;
}
export function proposals(grant, env = process.env) {
  return journal(env).writes.filter(e => e.proposal && e.phase === 'done' && scope(e.grant) === scope(grant))
    .map(e => ({path:e.rel, originalPath:e.proposal.originalPath, cas_ref:e.proposal.cas_ref, kind:e.expected.kind, runId:e.expected.runId, revision:e.expected.revision}));
}
/** Record existence before any policy/content read can refuse; pre-consent discovery is metadata only. */
export function observeTargetMetadata(pin, rel, env = process.env) {
  requireLock(env);
  const status = targetStatus(pin, rel, env, {metadataOnly:true});
  if (status.exists) {
    const j = journal(env), key = scope(pin);
    ((j.observed ??= {})[key] ??= {})[rel] = true;
    saveJournal(env,j);
  }
  return {...status, sha256:null};
}
/** Observe adoption from original-path bytes and durable CAS identity, never from an editable proposal. */
export function inspectTarget(grant, rel, proposedSha256, env = process.env, pin) {
  requireLock(env);
  if (!pin) fail('grant_changed','Local read permission requires a current pin');
  pinCheck(grant,pin,env);
  const status = observeTargetMetadata(grant, rel, env);
  const local = status.exists ? readConfined(grant, rel, env, {allowEmpty:true}) : null;
  const j = journal(env), key = scope(grant);
  if (local) {
    const adopted = j.writes.some(e => e.phase === 'done' && scope(e.grant) === key
      && e.proposal?.originalPath === rel && e.proposal.cas_ref === 'sha256:' + local.sha256);
    const prior = j.baselines?.[key]?.[rel];
    if (adopted && prior?.last_synced_sha256 !== local.sha256) establishBase(j,grant,rel,local.bytes,local.sha256,'adopted-observed',env);
    saveJournal(env,j);
  }
  const base = j.baselines?.[key]?.[rel];
  const classification = !local ? 'absent' : local.sha256 === proposedSha256 ? 'already identical'
    : !base ? 'first sync' : local.sha256 === base.last_synced_sha256 ? 'clean' : 'local changed';
  return {...status, sha256:local?.sha256 ?? null, bytes:local?.bytes, classification, baseline:base,
    baseBytes:base ? readBase(base.last_synced_sha256,env) : null};
}
export function observeTargets(grant, env = process.env, pin) {
  requireLock(env); const j = journal(env), key = scope(grant), reports = [];
  const paths = new Set([...Object.keys(j.observed?.[key] ?? {}), ...Object.keys(j.baselines?.[key] ?? {}), ...proposals(grant,env).map(p=>p.originalPath)]);
  for (const rel of paths) try { inspectTarget(grant,rel,null,env,pin); } catch(e) { reports.push({path:rel,code:e.code}); }
  return reports;
}

export function proposalName(rel, runId, revision) {
  const run8 = String(runId).replace(/-/g,'').slice(0,8);
  if (!/^[a-f0-9]{8}$/i.test(run8) || !Number.isSafeInteger(revision) || revision < 1) fail('artifact_invalid','Proposal requires a Run id and revision');
  const name = `${rel}.vecteur-${run8.toLowerCase()}-${revision}`; components(name); return name;
}
export async function writeProposalConfined(grant, rel, fetchBytes, expected, options) {
  const name = proposalName(rel,expected.runId,expected.revision);
  const bytes = await downloadLocalArtifact(fetchBytes,expected);
  for (let n=0;n<=99;n++) {
    try {
      return await writeNewConfined(grant,name+(n?`-${n}`:''),async sink=>{sink(bytes);return {bytes:bytes.length,content_type:ARTIFACT_MEDIA_TYPES[expected.kind]};},expected,
        {...options,proposalFor:rel});
    } catch(e) { if(e.code !== 'output_exists') throw e; }
  }
  fail('proposal_name_unavailable','All 100 proposal names already exist; nothing written');
}
export function admissionIntent(origin, projectId, key, body, env = process.env) {
  requireLock(env); const j = journal(env);
  if (body.local_exec !== undefined) fail('admission_unresolved', 'Execution consent cannot be frozen; observe the Project history');
  j.admissions ??= {};
  const id = hash(JSON.stringify([origin, projectId, key]));
  const prior = j.admissions[id];
  if (prior && JSON.stringify(prior.body) !== JSON.stringify(body)) fail('submission_mismatch');
  j.admissions[id] = { origin, projectId, key, body }; saveJournal(env, j); return id;
}
export function admissionResolved(id, env = process.env) { requireLock(env); const j = journal(env); delete j.admissions[id]; saveJournal(env, j); }
export function unresolvedAdmissions(origin, projectId, env = process.env) {
  const folders = readStore(store(env, 'folders'))?.folders ?? {};
  return [...Object.values(folders).filter(r => r.origin === origin && r.pendingRun?.projectId === projectId).map(r => r.pendingRun),
    ...Object.values(journal(env).admissions ?? {}).filter(r => r.origin === origin && r.projectId === projectId)];
}
export async function reconcileAdmissions(client, origin, env = process.env) {
  requireLock(env);
  for (const [id, row] of Object.entries(journal(env).admissions ?? {})) {
    if (row.origin !== origin) continue;
    if (row.body?.local_exec !== undefined) fail('admission_unresolved', 'Saved execution consent expired; observe the Project history');
    try { await client.runAdmit(row.projectId, row.body, row.key); admissionResolved(id, env); }
    catch (e) { if (e.admission === 'refused' || ['state_fork', 'state_busy'].includes(e.code)) admissionResolved(id, env); else throw e; }
  }
}

function entryUpdate(entry, phase, detail, env) {
  requireLock(env); entry.events.push({ phase, ...detail }); entry.phase = phase;
  const j = journal(env), at = j.writes.findIndex(r => r.id === entry.id);
  if (at < 0) j.writes.push(entry); else j.writes[at] = entry;
  saveJournal(env, j);
}
function markDone(entry, info, env) {
  requireLock(env); const j = journal(env);
  entry.events.push({phase:'done',local_sha256:entry.sha256,...inode(info)}); entry.phase='done';
  const at=j.writes.findIndex(r=>r.id===entry.id); if(at<0)j.writes.push(entry);else j.writes[at]=entry;
  (j.tombstones[scope(entry.grant)] ??= {})[entry.rel] = true;
  if (!entry.proposal) establishBase(j,entry.grant,entry.rel,readBase(entry.sha256,env),entry.sha256,'saved',env);
  saveJournal(env, j);
}
function cleanupName(parentfd, name, owned, report, entry, env) {
  if (!name) return;
  const path = proc(parentfd, name), info = absent(path); if (!info) return;
  if (owned && same(info, owned)) { entryUpdate(entry,'cleanup_unlink_intent',{name,...owned},env); fs.unlinkSync(path); report.cleaned.push(name); }
  else report.remains.push({ path: name, ...inode(info), reason: 'identity not owned' });
}
function cleanupDirs(entry, report, env) {
  for (const event of [...entry.events].reverse()) {
    if (event.phase !== 'mkdir_done') continue;
    try {
      const p = relative(entry.grant.root.path, event.path).split('/'), chain = walk(entry.grant, p.slice(0, -1));
      try {
        const path = proc(chain.at(-1).fd, p.at(-1)), info = absent(path);
        if (info && same(info, event)) { pathCheck(chain); entryUpdate(entry,'cleanup_rmdir_intent',{path:event.path,...inode(info)},env); fs.rmdirSync(path); fs.fsyncSync(chain.at(-1).fd); report.cleaned.push(event.path); }
        else if (info) report.remains.push({ path: event.path, reason: 'directory identity changed' });
      } finally { closeChain(chain); }
    } catch (e) { if (e.code !== 'ENOENT') report.remains.push({ path: event.path, reason: e.code }); }
  }
  for (const e of entry.events.filter(e => e.phase === 'mkdir_intent')) if (!entry.events.some(d => d.phase === 'mkdir_done' && d.path === e.path)) {
    if (absent(e.path)) report.remains.push({ path: e.path, reason: 'may have been created by an interrupted save' });
  }
}
/** Single writer: fetch/verify in memory first, then one locked fence and a synchronous, journalled install. */
export async function downloadLocalArtifact(fetchBytes, expected) {
  const chunks = []; let length = 0;
  const result = await fetchBytes(chunk => {
    length += chunk.byteLength; if (length > MAX_ARTIFACT) fail('artifact_invalid', 'Artifact exceeds 64 MiB'); chunks.push(Buffer.from(chunk));
  });
  const bytes = Buffer.concat(chunks);
  if (result.bytes !== length || result.content_type !== ARTIFACT_MEDIA_TYPES[expected.kind] || 'sha256:' + hash(bytes) !== expected.cas_ref) fail('artifact_invalid');
  return bytes;
}
export async function writeNewConfined(grant, rel, fetchBytes, expected, { env = process.env, pin, head, hook = () => {}, approval, proposalFor } = {}) {
  qualify(); const p = components(rel), bytes = await downloadLocalArtifact(fetchBytes,expected), length = bytes.length;
  return withLocalLock(async () => {
    pinCheck(grant, pin(), env);
    if (unresolvedAdmissions(grant.origin, grant.projectId, env).length) fail('admission_unresolved', 'admission_unresolved, resolve it with /resume');
    if ((await head(grant.projectId))?.run_id !== expected.runId) fail('newer_turn', 'a newer turn exists, review it');
    // Effective selection and credentials can change in this process while the head read awaits.
    pinCheck(grant, pin(), env); allowed(grant, rel, env);
    if (approval) {
      const now = inspectTarget(grant,approval.rel,expected.cas_ref.slice(7),env,pin());
      if (now.sha256 !== approval.sha256 || now.exists !== approval.exists) fail('target_changed','Target changed; approval withdrawn. Review the refreshed diff and confirm again.');
    }
    retainBase(bytes,hash(bytes),env);
    const entry = { id: randomUUID(), grant, rel, expected, sha256: hash(bytes), events: [], phase: 'created',
      ...(proposalFor ? {proposal:{originalPath:proposalFor,cas_ref:expected.cas_ref}} : {}) };
    let chain, tempfd, tempIdentity, parentfd, leafPublished = false;
    const event = (phase, detail = {}) => { entryUpdate(entry, phase, detail, env); hook(phase, entry, chain); };
    try {
      hook('before_intent', entry); event('created');
      chain = walk(grant, p.slice(0, -1), { create: true, created: path => hook('mkdir_created',entry,chain), intent: path => event('mkdir_intent', { path }), done: (path, id) => event('mkdir_done', { path, ...id }) });
      parentfd = chain.at(-1).fd; entry.parentChain = chain.map(({fd,path}) => ({ path, ...inode(fstat(fd)) }));
      const leaf = p.at(-1); entry.temp = `.vecteur-${leaf}-${entry.id}.part`;
      event('temp_intent', { name: entry.temp });
      tempfd = fs.openSync(proc(parentfd, entry.temp), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NOCTTY, 0o600);
      tempIdentity = inode(fstat(tempfd)); hook('temp_created', entry, chain);
      event('temp_done', tempIdentity); event('write_intent'); fs.writeFileSync(tempfd, bytes); fs.fsyncSync(tempfd); event('chmod_intent'); fs.fchmodSync(tempfd, 0o644 & ~process.umask()); fs.fsyncSync(tempfd);
      event('pending'); pathCheck(chain);
      if (!same(lstat(proc(parentfd, entry.temp)), tempIdentity)) fail('install_unverified');
      hook('before_link', entry, chain);
      fs.linkSync(proc(parentfd, entry.temp), proc(parentfd, leaf)); leafPublished = true; hook('linked', entry, chain);
      const fd = openSafe(proc(parentfd, leaf), READ);
      try {
        const info = fstat(fd);
        if (!info.isFile() || !same(info, tempIdentity) || info.nlink !== 2) fail('install_unverified');
        pathCheck([...chain, { fd, path: join(grant.root.path, ...p) }]);
      } finally { fs.closeSync(fd); }
      event('unlink_intent');
      if (!same(lstat(proc(parentfd, entry.temp)), tempIdentity)) fail('install_unverified');
      fs.unlinkSync(proc(parentfd, entry.temp)); fs.fsyncSync(parentfd); hook('unlinked', entry, chain);
      markDone(entry, fstat(tempfd), env); return { path: join(grant.root.path, ...p), bytes: length, sha256: entry.sha256 };
    } catch (e) {
      const report = { cleaned: [], remains: [] };
      // Durably announce cleanup too. A failed journal aborts cleanup rather than making an unrecorded mutation.
      event('cleanup_intent', { cause: e.code });
      if (parentfd !== undefined) {
        if (leafPublished) cleanupName(parentfd, p.at(-1), tempIdentity, report, entry, env);
        cleanupName(parentfd, entry.temp, tempIdentity, report, entry, env); fs.fsyncSync(parentfd);
      }
      cleanupDirs(entry, report, env);
      const unverified = e.code === 'install_unverified' || leafPublished || report.remains.length;
      event(unverified ? 'install_unverified' : 'failed', report);
      if (unverified) fail('install_unverified', JSON.stringify({ cause: e.code, ...report }));
      if (e.code === 'EEXIST') fail('output_exists', 'exists locally, not written');
      throw e;
    } finally { if (tempfd !== undefined) fs.closeSync(tempfd); if (chain) closeChain(chain); }
  }, env);
}

export function reconcileWrites(env = process.env) {
  requireLock(env); const reports = [];
  for (const entry of journal(env).writes) {
    if (['done', 'failed'].includes(entry.phase)) continue;
    let chain;
    const report = { id: entry.id, cleaned: [], remains: [] }, p = components(entry.rel);
    try {
      chain = walk(entry.grant, p.slice(0, -1));
      const parentfd = chain.at(-1).fd, path = proc(parentfd, p.at(-1));
      let target, verified = false;
      target=absent(path);
      if (target?.isFile() && entry.events.some(e=>e.phase==='pending')) {
        const fd = openSafe(path, READ);
        try { target = fstat(fd);
          if (target.isFile() && target.size <= MAX_ARTIFACT) {
            const bytes = readBounded(fd,target.size); pathCheck([...chain, {fd,path:join(entry.grant.root.path,...p)}]);
            verified = bytes.length === target.size && hash(bytes) === entry.sha256;
          }
        } finally { fs.closeSync(fd); }
      }
      const tempEvent = entry.events.find(e => e.phase === 'temp_done');
      const tmpPath = entry.temp && proc(parentfd, entry.temp), tmp = tmpPath && absent(tmpPath);
      if (tmp) {
        const owned = tempEvent ? same(tmp, tempEvent) : entry.temp.endsWith(`-${entry.id}.part`);
        const linksExplained = tmp.nlink === 1 || tmp.nlink === 2 && verified && same(tmp, target) && (!tempEvent || same(target, tempEvent));
        if (owned && tmp.isFile() && tmp.size <= MAX_ARTIFACT && linksExplained) {
          entryUpdate(entry, 'recovery_unlink_intent', {}, env); fs.unlinkSync(tmpPath); fs.fsyncSync(parentfd); report.cleaned.push(entry.temp);
        } else report.remains.push({ path: entry.temp, reason: 'foreign staging identity or unexplained links' });
      }
      if (verified && !report.remains.length) {
        if (target.nlink !== (tmp && same(tmp,target) ? 2 : 1)) report.remains.push({ path: entry.rel, reason: 'unexplained target links' });
        else markDone(entry, target, env);
      } else {
        if (target) report.remains.push({ path: entry.rel, reason: 'not written; target differs or is not inspectable' });
        entryUpdate(entry, 'recovery_cleanup_intent', {}, env); cleanupDirs(entry, report, env);
        entryUpdate(entry, report.remains.length ? 'install_unverified' : 'failed', report, env);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        entryUpdate(entry, 'recovery_cleanup_intent', {}, env); cleanupDirs(entry, report, env);
        entryUpdate(entry, report.remains.length ? 'install_unverified' : 'failed', report, env);
      } else report.remains.push({ path: entry.grant.root.path, reason: e.code === 'folder_replaced' ? 'root changed, not reconciled' : e.code });
    } finally { if (chain) closeChain(chain); }
    reports.push(report);
  }
  return reports;
}

export function discover(root, env = process.env, prefix = '', { max = 1000 } = {}) {
  qualify(); const files = [], grant = {root};
  function visit(parts) {
    const chain = walk(grant, parts);
    try {
      for (const item of fs.readdirSync(proc(chain.at(-1).fd), { withFileTypes: true })) {
        const rel = [...parts, item.name].join('/');
        try { if (excluded(grant, rel, env, item.isDirectory())) continue; }
        catch (e) { if (e.code === 'ignore_policy_unknown') continue; throw e; }
        if (item.isDirectory() && parts.length < 15) visit([...parts, item.name]);
        else if (item.isFile() && rel.startsWith(prefix)) {
          try { files.push(selectionMetadata(root, rel, env)); } catch(e) { if (!['attachment_invalid','hardlink_refused','ignore_policy_unknown'].includes(e.code)) throw e; }
        }
        if (files.length >= max) return;
      }
      pathCheck(chain);
    } finally { closeChain(chain); }
  }
  // Establish the root policy before per-entry/subtree failure isolation.
  excluded(grant, '.gitignore', env);
  visit([]); return files;
}
export function nameOffers(text, files, selected = []) {
  const tokens = new Set(text.split(/\s+/).filter(Boolean)), groups = [];
  for (const token of tokens) {
    if (token.startsWith('@') || token.startsWith('/') || token.split('/').includes('..')) continue;
    const name = token.replace(/^\.\//, '');
    const matches = files.filter(f => !selected.includes(f.rel) && (f.rel === name || !name.includes('/') && f.rel.split('/').at(-1) === name));
    if (matches.length) groups.push(matches);
    if (groups.length === 3) break;
  }
  return groups;
}
