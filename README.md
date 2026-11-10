# Vecteur CLI

One command line for Vecteur's public API. Sign in through your browser, then use the same
Projects and run records as the web app. The client stores your credential locally; it never
calls the OPE, engine or database directly.

```bash
npm install -g @vecteur/cli
vecteur
```

`vecteur` opens the session, signs in through your browser when needed, and finds the Project
linked to this folder. A new folder creates its Project only when you send your first ask.
No `init` command or file in the working directory is required.

On Linux, a fresh interactive ask offers separate local command consent. `/exec on` enables
it for the next admission; `/exec off` revokes it and stops the active process group.
Commands show their exact bash text, folder and timeout, with once/session approval.
`vecteur run submit --ask '…' --allow-exec` grants invocation-scoped session approval and
stays in the foreground; `--no-wait`, persisted `--request-key` retries and MCP refuse this flag.
The shell has your OS permissions, including network access and writes outside its cwd.
Only scanned UTF-8 output tails (16,000/8,000 bytes) return to Vecteur; credential-shaped or
unsupported output withholds both tails. A lost start acknowledgement never spawns; unknown
outcomes are never retried. Restarted sessions observe existing Runs without execution authority.

For scripts and explicit one-shot commands:

```bash
vecteur login
vecteur whoami
vecteur project list
vecteur project create 'Transfer study'
vecteur project use 'Transfer study'
vecteur project get PROJECT_ID --json
vecteur run submit --ask 'GTO to GEO transfer'
vecteur run get RUN_ID --json
vecteur run events RUN_ID --json
vecteur artifact get sha256:ARTIFACT_DIGEST --output report.docx
vecteur logout
```

Use `vecteur login --origin URL` for another deployment. For automation, supply a Project PAT
through `VECTEUR_TOKEN` and its origin through `VECTEUR_BASE_URL`; never pass a token on argv.
`--help` and `--version` work without signing in.

`project list` shows authorized Projects and the server's Organization-wide active Project
allowance. `project create NAME --workspace NAME_OR_ID` chooses among multiple Workspaces; one
Workspace is implicit. Names must match exactly and uniquely, or use an id. Quota refusals show
the server's reason and recovery links.

`project use NAME_OR_ID` saves the selected id beside the login for that origin. `run submit`
checks this selection against the live authorized list each time; `--project ID` overrides it.
With `VECTEUR_TOKEN`, runs require `--project ID` and `project use` requires a persistent login.
Project PATs retain their server-defined scope; listing and creating Projects require an account
login. `project list --json` preserves `{projects, active_projects, selected_project_id}`.

`run submit` continues the Project's conversation: it reads the Project's current head (the newest
Run's `state_hash`) and submits the next turn on it, so two submits in a row are two turns of one
study, exactly as in the web app. A new Project's first turn has no head. `--parent STATE_HASH`
skips the read and admits the turn only if that hash is still the head. The CLI never forks a
Project and never automatically retries: a moved head exits `state_fork` naming the current head, and a Project
whose Run is still open exits `state_busy` naming that Run (and, when it waits on a question, the
web address where it can be answered). Nothing is admitted in either case. Once a turn is admitted,
any later failure names the Run: check it with `vecteur run get RUN_ID` instead of submitting
again, which would start another turn. Start a fresh study with `vecteur project create`.

`run events` validates dense SSE sequence and returns the canonical direct record only when its
embedded events match the stream. Redirects, secret-shaped responses, malformed responses and
timeouts fail nonzero. `--json` sorts object keys for deterministic machine output.

Human run output shows the sealed synthesis, input origins, artifact download commands, the typed
terminal cause/recovery, and—after `run submit`—the selected Project's UTC-month customer cost using
the server's display strings. Machine run output remains the unchanged canonical record. Artifact
downloads use the Project-scoped admitted CAS route, verify the declared length, media type and
SHA-256, and refuse to overwrite a local path. Use `--project ID` when no Project is selected.

`vecteur mcp` serves MCP over stdio using the same credentials and public client. It exposes
`vecteur_project_get`, `vecteur_run_submit`, `vecteur_run_get`, `vecteur_run_events`, `vecteur_artifact_get` (digest-verified download into the working folder, never overwrites) and `vecteur_material_attach` (uploads one file from the working folder after you confirm the origin and the Project head; refuses read-only, foreign or moved-on Projects).
Pass material_attach's returned `selections` verbatim to `vecteur_run_submit` or `vecteur_run_start` for that Project. For multiple files, concatenate their `selections` arrays. These select the same extracts as CLI `--attach`; upload alone does not admit material to a Run. Omitting that Project's pending material in the same MCP session refuses with `selection_required` before admission; pending material in another Project does not block it. To deliberately abandon pending material, pass the optional boolean `discard_pending_material: true` to submit or start: it clears only that Project's pending tracking before admission and uses the supplied selections, or none if omitted. The discard remains effective if admission refuses; it does not delete uploaded files. Omitting the flag or passing `false` retains the guard. A file with no selectable extracts refuses with `extraction_unavailable`.
It also exposes `vecteur_run_start`, `vecteur_run_status` and `vecteur_clarification_answer` for
long Runs. `vecteur_run_submit` blocks and is suitable only for short asks.
An MCP host supplies tool arguments; stdout carries only MCP protocol.

`vecteur mcp setup claude` (or `codex`) runs that vendor's own `mcp add` once so your Claude Code
or Codex can call Vecteur. `vecteur handoff claude` (or `codex`, or `/handoff` in a session) opens
your own Claude Code/Codex in this terminal with Vecteur attached for that session only, and
returns when it exits. The vendor keeps its own login and billing; Vecteur never reads its
credentials and the handoff changes no vendor configuration. This is a handoff, not the integrated
mode in which the vendor session appears inside Vecteur's TUI and web.

`vecteur run export <run-id> [--output <dir>]` (or `/export [dir]`) writes a completed Run into a
new folder: `answer.md` (exact answer bytes), `run.json` (the canonical record) and every artifact,
each verified against its SHA-256 CAS id. Nothing is overwritten.

## Claude Code and Codex: attach, poll, answer, export

Both vendors use the same lifecycle recipe. Sign in to Vecteur and to your vendor separately;
use `vecteur mcp setup claude` / `vecteur handoff claude`, or substitute `codex`. The installed
vendor command and its own permissions apply. These recipes have packed CLI/MCP fake-server
coverage; interactive Claude Code/Codex handoff acceptance is not yet recorded. Vecteur Runs
use your Vecteur plan; the generalist uses its own provider and billing. Data returned to the
generalist goes to that assistant's provider.

From the folder containing your inputs, choose the Project and pin its last Run's `state_hash`
as `H` (a 64-character lowercase hex hash). For a Project with no Run, use `--parent none`.
Choose a fresh request key of 8–64 letters, digits, `_` or `-`, then keep the command unchanged
for retries:

```bash
vecteur run submit --no-wait --parent "$H" --request-key orbit-20261107-01 \
  --attach orbit.csv requirements.txt -p PROJECT_ID --ask 'Plot this orbit' --json
# Read run_id from the acknowledgment, then poll until terminal is nonempty:
vecteur run get RUN_ID --json
# Optional validated event replay (the stream has the configured request timeout):
vecteur run events RUN_ID --json
# When the latest clarification has state "requested":
vecteur run answer RUN_ID --clarification CLARIFICATION_ID --answers answers.json --json
vecteur run get RUN_ID --json
vecteur run export RUN_ID -p PROJECT_ID --output orbit-result --json
```

`answers.json` is the wire answer array; `--answers -` reads the same JSON from stdin:

```json
[{"id":"orbit","selected":["leo","meo"],"custom":"Include a polar case"},
 {"id":"mass","selected":[],"custom":"550 kg"}]
```

The server owns valid question/option ids, multi-select, expiry and stale/duplicate refusals.
MCP hosts use `vecteur_run_start({project_id, ask, request_key, parent_state_hash})`, then poll
`vecteur_run_status({run_id})` and answer with
`vecteur_clarification_answer({run_id, clarification_id, answers})`. Start returns the RunAck
plus the resolved `parent_state_hash`. Status returns `{run_id, terminal, last_seq, clarification}`:
one bounded record read, last sequence `-1` when no events exist, and the latest clarification
payload verbatim only while requested. Stopping polling detaches and never cancels the Run.

`--attach` is explicit consent to upload exactly those files to the command's explicit or
selected Project at the authenticated origin, for Vecteur cloud and the Run's model provider.
It replaces inherited sources. The invocation grant is never persisted and does not change a
folder binding or saved Project selection. Paths must be inside the working folder; the same
Linux/Node qualification, exclusions, no-symlink reader, secret scan, eight-file, 8 MiB/file and
32 MiB total limits as interactive selection apply. All extracts are selected. An unsafe member
of the initial set refuses before any file uploads. Neither filenames nor local paths enter
the admission/upload bodies. `--attach` applies only to `run submit --no-wait`.

With explicit `--parent H|none`, the CLI writes the exact admission body (ask, parent, source
handles and selections) before dispatch, in a no-overwrite 0600 `request-<key-digest>.json` file
beside `credentials.json`. Retain that file for recovery. A retry with the same command reuses
its handles without rereading local files or the head, even if both changed. Changing the ask,
parent, Project or attachment set with the same key refuses `request_key_reused`. The shared
admission-intent journal remains in force through a dropped response or killed process.

Without `--parent`, the client resolves the head once and reports that parent in its response
or admission error. This convenience mode has no frozen request file. An interrupted request
without that file remains `admission_unresolved`; a conflicting same-key retry also reports
`admission_unresolved`. Inspect Project history before choosing a new key. No newest Run is
presented as recovered, and the client never generates a replacement key. Transport, timeout,
pending, unknown and malformed-ack errors carry the request key and parent once resolved.
Only `run submit --no-wait` and `run answer` emit one JSON error object on stderr
(`code`, `message`, optional `run_id`, `request_key`, `parent_state_hash`); stdout holds only the
success record. Existing blocking CLI and MCP success outputs and CLI error bytes are preserved;
MCP errors may additionally name an admitted `run_id`.

`run export` and `artifact get` keep their verified no-overwrite behavior. New MCP local-file
tools (`vecteur_input_add`, `vecteur_artifact_save`) remain gated on integration-doors §6.1.

## Interactive session

Enter sends; Ctrl+J or Alt+Enter inserts a line. In rich mode, bracketed paste is one edit and never sends.
Plain mode and `TERM=dumb` emit no escape bytes: only an input read consisting exactly of CR or
CRLF submits. A read containing text before its final CR/CRLF stays a draft; all CR/CRLF delimiters
in that read become newlines. An unmarked paste split into a lone CR/CRLF read can therefore
submit early; coalesced text and Enter stay in the draft.
The rich view uses normal terminal scrollback. `vecteur --plain` gives a linear view;
`NO_COLOR=1 vecteur` or `--no-color` removes styling. `TERM=dumb` selects the linear view.
Bare invocation in a pipe or CI keeps the previous status output; `vecteur status` always prints it.

- `/project` chooses a Project for this session; `/link` saves the folder association.
  `/unlink` removes that association for this subtree and preserves the draft. `/name` renames
  the current Project or names the one created on first send. `/history` loads older Runs on demand.
- `/model` selects the next Run's model or route from the matched server catalogue. `/mode`
  explains leadership, execution location and payer. Stage 1 runs in Vecteur cloud.
- `@` completes local paths. A whole filename in your ask offers attachment after local
  checks (at most three offers; ambiguous basenames list choices).
  A refused name prints `name: not offered (reason)` and asks whether to send without it.
  Without a grant, ordinary named files are offered by name and size without reading
  their content. Accepting an offer leads to the common first-use permission card; only after
  confirmation is content read and scanned. Credential-shaped content refuses `secret_suspected`
  before upload. With a grant, content is also checked before offering.
  Directory listings and ignore-policy reads stay local.
  `/attach <path>` selects metadata inside the session folder, including before its first send.
  Absolute paths must lie inside that folder; outside paths now refuse `outside_folder`.
  First send asks for `select` and `save-new` permission, naming the folder, Project and origin.
  Send-first and save cards print their full disclosure and every file's selection state to
  scrollback once on opening; a short question and its choices stay live.
  Nothing leaves this computer unless you confirm it. Selected content uploads to Vecteur cloud
  and the Run's model provider route; local residency is not guaranteed. The composer states
  the upload destination. Declining keeps the draft and selections and reads no selected content.
  Up to eight files, **8 MiB each** (reduced from 16 MiB) and 32 MiB total; all available extracts
  are selected. `/clear-files` removes pending selections. A retry of an admitted upload uses
  its frozen source handle and never rereads the local file.
- `/answer` handles clarification, including multiple choices and custom text. `/steer <text>`
  and `/answer-now` submit instructions; acceptance is distinct from execution.
- `/cancel` or double Esc requests cloud Run cancellation. Ctrl+D on an empty composer or
  `/quit` detaches; the cloud Run continues. Ctrl+C clears a nonempty composer.
- `/package <number>` saves a result into its own new folder and prints how to continue. Local execution needs its separate consent; attached test reports join the next turn as your evidence, not an accepted result.
- After a terminal head Run, a save-new prompt offers absent artifact paths, including missing
  parent directories. Identical bytes preselect the shortest path; `d` shows every path and
  lets you choose any. `yes` installs verified bytes without overwriting, `n` declines.
  This writes once; it makes no synchronization or latest-version promise.
  `/files revoke` ends local permission and withdraws pending proposals. Unlink, any bind/relink
  (even to the same Project and with an explicit session selection), another `/project`, logout
  and root replacement also end permission. `/project` without linking works with fresh consent.
  When a returned path already exists, Vecteur offers a separate proposal:
  `<path>.vecteur-<run8>-<rev>` (collision suffixes `-1` through `-99`). The original is kept.
  Before local read consent, inspection uses metadata only. First-use approval permits the
  comparison, then an informed proposal confirmation; `d` also requires explicit read consent.
  Revoked permission requires fresh consent for `/files diff N`.
  `d` displays `local now → proposed` and, when retained, `base → local now`; diffs are bounded
  and sanitized. The prompt labels **clean**, **local changed**, or **first sync**; identical
  bytes need no write. A target edit or deletion before the approval commits withdraws it,
  refreshes the comparison and requires fresh confirmation. This check does not lock your editor.
  Review and adopt using your own editor or the printed `mv -i -- …` command. Vecteur never
  replaces, renames, moves or deletes the original or a published proposal. `/files` lists
  proposals and `/files diff N` compares their recorded CAS bytes with the current original.
  Adoption is observed when the original matches a recorded proposal, including after restart
  or adoption by move. The next unchanged turn then compares with that adopted baseline.
  Uploaded, saved, adopted and previously observed existing paths are never automatically offered again after deletion, even with changed bytes;
  `/files save N` explicitly offers one again. History is scoped to origin/account/root/Project.
  Cloud and pending `/files` rows remain available when local authority is unavailable (including
  Viewer access and unqualified platforms); optional local observation reports a notice.
  `/files` lists inputs/outputs; `/download <number> [path]` verifies bytes and refuses overwrite.
  `/copy [path]` preserves the exact answer: terminal clipboard when supported, otherwise a file.
- `/resume` reconciles an interrupted submission using its original identity, or follows the
  same Run from its validated event cursor. A moved head requires an explicit new send.
  Unknown admission remains pending if authority or transport prevents reconciliation.
- `Ctrl+O` and `/details [number]` print the full human tool block (changed files, excerpts and code summary).
- `/web`, `/doctor` and `/help` expose details, browser access, diagnostics
  and commands. Updates are manual; an incompatible origin supplies its required install command.

Folder links are scoped by origin, authenticated account and canonical directory identity.
An explicit parent link applies to descendants; a nearer link or unlink overrides it. Linking
home, a filesystem root or a detected mount root requires typing its full path. A replaced directory or inaccessible Project asks for recovery.
A link is metadata and never a filesystem grant. Viewer access permits reads and downloads.

`folders.json` beside the credential store holds bindings, drafts and unresolved request identities.
POSIX directories/files use 0700/0600; writes are atomic and protected by a short writer lock.
A crashed writer leaves an explicit lock recovery message. Drafts are bounded to 256 KiB and
expire after 30 days on next registry access/write. Up to 20 revisions from concurrent editors remain
recoverable through `/drafts`; `/clear` removes the selected draft. Unchanged terminals never
overwrite another editor, and admission consumes only its exact draft revision. Unresolved
request evidence stays until resolved. Account draft recovery requires the same credential fingerprint
previously bound by a successful account read. Never-signed-in drafts occupy a separate unsigned
namespace with no Project authority; only explicit login transfers them into an account. Neither
recovery path grants server access. Selections hold metadata until send and must be selected
again after restart; generated `/run-package` reports remain an explicit-command exception. A newer store version is refused without
rewriting it. Previous CLI versions ignore the separate folder registry.

## Local file authority limits

Selection and automatic save-new require **Linux and Node >=20.8**. Other platforms and older
Node versions refuse these capabilities with `platform_unqualified`; cloud commands still work.
A folder link supplies no permission. Viewer Projects cannot acquire file authority, upload
inputs, admit Runs or retry them; the server checks EDITOR for both cookies and PATs, and checks
EDITOR before fetching a Drive import.

The fixed exclusions cover credential/vendor directories, `.git`, `.env*`, private-key names,
`node_modules` and the CLI store; nested `.gitignore`, `.vecteurignore` and root `.git/info/exclude`
apply with git precedence. A `.git` gitfile is denied and never followed; it supplies no
`.git/info/exclude`. Unknown/unreadable policy excludes its subtree. If optional filename
discovery is unavailable, the CLI says so and a plain ask still submits without offers.
Global `core.excludesFile` is not read. Symlinks, hardlinks, devices, FIFOs, path escapes and detected folder moves refuse.
Local file authority uploads only strict UTF-8 (with or without BOM) or UTF-16LE/BE text
with a BOM, with these extensions:
`.txt`, `.md`, `.csv`, `.json`, `.py`, `.m`, `.jl`, `.r`, `.c`, `.h`, `.cpp`, `.f90`,
`.toml`, `.yaml`, `.yml`, `.ini`, `.cfg`, `.tex`, `.rst` (case-insensitive).
A BOM selects exactly its declared encoding; invalid text refuses `scan_unsupported`.
Without a BOM, only strict UTF-8 is decoded: no encoding heuristics or fallback are used.
BOM-less UTF-16 is unsupported; export it as UTF-8 or include a UTF-16 BOM.
Credential shapes are scanned in raw bytes and in a copy of the decoded text with control
(except tab, CR and LF) and zero-width/format characters removed. Uploaded bytes remain unchanged.

**PDF is refused in this slice** (`scan_unsupported`), by `.pdf` extension or `%PDF-` content
signature anywhere in the file, including after a preamble and under another filename.
**DOCX and ZIP/OOXML containers are refused** (`scan_unsupported`), by extension or ZIP content
signature (`PK\x03\x04` anywhere in the file), including under a `.txt` filename. Their reading
order cannot yet be checked reliably for credentials before upload. Upload Word/PDF files in
the web app, or attach a text/CSV/Markdown export. No ZIP/XML document scanner is used.
Other extensions, invalid text encodings and uninspectable binary representations also refuse.
False positives refuse. This is a bounded representation/pattern check, not a guarantee that every
secret can be recognized. No local filename or absolute path is added to an upload body.

`local-grants.json` records permission generations and pending consent metadata; `local-writes.json`
records upload evidence, save intents, proposal-to-original/CAS mappings, per-path baseline hashes
and provenance, observed-existence tombstones and unresolved non-session admissions.
Grant revocation is fsynced before link/logout metadata and automatic Project binding; a
journalled revocation intent also blocks old grants and consent if the grant-store write fails or is interrupted.
Both are private local stores beside `folders.json`. Local admissions and file operations share
an async, non-reentrant lock in the order local lock → short store lock. **Design deviation:**
a realpath-canonical Linux abstract Unix socket replaces the spec's literal lock file so SIGKILL
releases exclusion in the kernel. Another same-user process contends across XDG aliases; another
OS user in the same network namespace could squat the name (denial of service).

Exact baseline bytes are retained privately in `local-bases/<sha256>` beside these stores, mode
0600, up to 8 MiB per file and 256 MiB total; oldest snapshots are evicted first. Reads verify the
digest. If a snapshot is evicted, missing or corrupt, hash-based conflict status remains and the
display says the base diff is unavailable. Edited proposal files are never used to reconstruct a
baseline. The code/text extensions `.py .m .jl .r .c .h .cpp .f90 .toml .yaml .yml .ini .cfg .tex .rst`
upload as `text/plain`, with the same strict content scan. Extract-based upload does not establish
whole-file model fidelity: fixture J3 runs prove delivery and user adoption mechanically; model-quality
J3 remains UNKNOWN until the installed literal model run.

Downloads finish and verify length, digest and kind-specific media in memory before any local
mutation. Fsynced intents precede directory/staging creation, writes, publication and cleanup.
Restart checks root and inode ownership; the post-link two-name state removes its recorded staging
link before completing. Replacements and unexplained hardlinks are retained and reported.
A mkdir interrupted before its inode was recorded is retained with
`may have been created by an interrupted save`; unconditional empty-folder crash cleanup is not promised.
An unsafe/partial installation reports `install_unverified`, with cleaned and remaining paths.
The older short store-lock recovery message still applies to `store.js` writes themselves.

A save refuses `admission_unresolved, resolve it with /resume` before reading the head while any
folder's pending admission or the command/MCP admission journal is unresolved for that origin/Project.
`/resume` retries the exact persisted request/key through the active credential; failed authorization
keeps the intent unresolved. A local lock cannot fence web/other-machine admissions after the head
read: that residual window is the local installation sequence, with no network wait. Hostile
same-OS-user directory/name swaps between the last identity check and a syscall remain a TOCTOU
limit; identity-checked cleanup has the same last-check race. Node provides no openat2/linkat/flock
boundary for eliminating it here. The TUI has no `--project` attachment door;
`run submit --no-wait -p OTHER --attach ...` grants only that invocation's explicit destination.

Explicit `/download`, `/copy`, `/export`, `artifact get`, `run export`, `/package`, `/run-package`
and MCP `materialAttach` retain their own consent/ownership boundaries. They are not uses of the
new persistent local grant; MCP attachment remains the integration-doors owner.

## Maintainer boundaries and later stages

One package, one session owner, two views; stage 1 has no daemon or second application.

| Owner | Responsibility |
|---|---|
| `bin/vecteur.js` | TTY dispatch and preserved script/MCP commands; lazy terminal loading |
| `session.js`, `commands.js` | Cloud actions, prompts, recovery and view facts |
| `client.js` | Public API, auth transport, validated records, sources, controls and cursor replay |
| `credentials.js`, `folders.js`, `store.js` | Existing login, account/folder metadata and atomic persistence |
| `localfiles.js` | Grants, anchored reads/writes, exclusions/scan, local lock, admission/save journals and recovery |
| `input.js`, `terminal.js` | Grapheme-aware composer, paste, signals and the single stdout writer |
| `tui/view.js`, `blocks.js` | Rich layout and Run presentation; plain view uses the same session facts |
| `markdown.js`, `contract.js` | Generated parser/contracts; no runtime web or SDK import |
| `download.js`, `diagnostics.js` | Verified downloader, Run export and shared read-only diagnostics |
| `vendors.js` | Claude Code/Codex MCP setup and native-terminal handoff argv; no vendor credentials |

The renderer uses exact `wrap-ansi`/`string-width` pins and a common display-width implementation.
Ink failed the frozen startup budget. Completed output is appended; resize abandons old live
geometry so it never guesses how many reflowed scrollback lines to erase. Neither view authorizes
operations or issues requests itself.

The v5 foreground `local_exec` replaces the proposed companion and local-file seed paths.
Folder links and file grants do not authorize execution. Explicit attach and verified save-new
remain the file transfer doors; command output is not a Lab certification. Native Claude/Codex
handoffs retain their own identity and lifecycle.

The intended platform matrix includes Linux, macOS and Windows Terminal, plus screen-reader
qualification. Current evidence and unresolved cases belong in the stage-1 WBS/backlog; Linux
tests alone do not qualify other platforms. Standalone binaries are a later packaging option using
the same session owner. This package uses the `stable` channel, visible even offline. Publication
freezes its reviewed package bytes and release identity. Updates across channels always ask explicitly.

## Drafting, recovery and updates

`vecteur --offline` opens a saved local draft without a network request or browser. Use `/login`
when ready; signing in restores the draft for editing and never sends it automatically. `/help`
searches every command and `/shortcuts` lists editing, choice and Run-control keys. `/settings`
saves plain/screen-reader display, reduced motion and update preferences separately from tokens.

`/update check` (or `vecteur update --check`) identifies the actual launcher, Node, PATH mismatch
and origin's required version. Default installation asks first. Opted-in automatic upgrades defer
while a Run, login or unresolved submission is active. Only a user-owned npm symlink launcher with
verified release integrity and npm provenance qualifies. Existing module trees stay intact; the
launcher switches to a separately installed npm generation. Recovery instructions name the retained
previous target. Windows wrappers, custom Node loaders, direct source scripts and packages without
provenance receive a refusal and exact manual guidance. No elevation, shell setup edits or automatic
old-generation deletion occurs. Scripts, JSON, MCP, help and version never install an update.

For an **unpublished preview**, use its exact installed path with `--offline`, or pass `--origin`
for the matching ready acceptance backend. Installing a global release does not update an absolute
preview path. Production's exact contract pin may reject a preview before browser sign-in.

```bash
/path/to/preview/bin/vecteur --offline
/path/to/preview/bin/vecteur --origin http://127.0.0.1:PORT --no-browser
```
