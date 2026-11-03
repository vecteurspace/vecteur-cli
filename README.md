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
Project and never retries: a moved head exits `state_fork` naming the current head, and a Project
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
`vecteur_project_get`, `vecteur_run_submit`, `vecteur_run_get` and `vecteur_run_events`.
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

## Interactive session

Enter sends; Ctrl+J or Alt+Enter inserts a line. Bracketed paste is one edit and never sends.
The rich view uses normal terminal scrollback. `vecteur --plain` gives a linear view;
`NO_COLOR=1 vecteur` or `--no-color` removes styling. `TERM=dumb` selects the linear view.
Bare invocation in a pipe or CI keeps the previous status output; `vecteur status` always prints it.

- `/project` chooses a Project for this session; `/link` saves the folder association.
  `/unlink` removes that association for this subtree and preserves the draft. `/name` renames
  the current Project or names the one created on first send. `/history` loads older Runs on demand.
- `/model` selects the next Run's model or route from the matched server catalogue. `/mode`
  explains leadership, execution location and payer. Stage 1 runs in Vecteur cloud.
- `/attach <path>` previews a selected file and asks before uploading on send. Up to eight
  files, 8 MiB each and 32 MiB total; all available extracts are selected. `/clear-files` removes
  pending attachments. Nothing scans your directory or uploads unrelated files.
- `/answer` handles clarification, including multiple choices and custom text. `/steer <text>`
  and `/answer-now` submit instructions; acceptance is distinct from execution.
- `/cancel` or double Esc requests cloud Run cancellation. Ctrl+D on an empty composer or
  `/quit` detaches; the cloud Run continues. Ctrl+C clears a nonempty composer.
- `/files` lists outputs; `/download <number> [path]` verifies bytes and refuses overwrite.
  `/copy [path]` preserves the exact answer: terminal clipboard when supported, otherwise a file.
- `/resume` reconciles an interrupted submission using its original identity, or follows the
  same Run from its validated event cursor. A moved head requires an explicit new send.
  Unknown admission remains pending if authority or transport prevents reconciliation.
- `/details [number]`, `/web`, `/doctor` and `/help` expose details, browser access, diagnostics
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
recovery path grants server access. Attachments are held in
memory until send and must be selected again after restart. A newer store version is refused without
rewriting it. Previous CLI versions ignore the separate folder registry.

## Maintainer boundaries and later stages

One package, one session owner, two views; stage 1 has no daemon or second application.

| Owner | Responsibility |
|---|---|
| `bin/vecteur.js` | TTY dispatch and preserved script/MCP commands; lazy terminal loading |
| `session.js`, `commands.js` | Cloud actions, prompts, recovery and view facts |
| `client.js` | Public API, auth transport, validated records, sources, controls and cursor replay |
| `credentials.js`, `folders.js`, `store.js` | Existing login, account/folder metadata and atomic persistence |
| `input.js`, `terminal.js` | Grapheme-aware composer, paste, signals and the single stdout writer |
| `tui/view.js`, `blocks.js` | Rich layout and Run presentation; plain view uses the same session facts |
| `markdown.js`, `contract.js` | Generated parser/contracts; no runtime web or SDK import |
| `download.js`, `diagnostics.js` | Verified downloader, Run export and shared read-only diagnostics |
| `vendors.js` | Claude Code/Codex MCP setup and native-terminal handoff argv; no vendor credentials |

The renderer uses exact `wrap-ansi`/`string-width` pins and a common display-width implementation.
Ink failed the frozen startup budget. Completed output is appended; resize abandons old live
geometry so it never guesses how many reflowed scrollback lines to erase. Neither view authorizes
operations or issues requests itself.

Later computer-use work adds separate device credentials, grants, IPC/relay and cancellation
subjects. Native Claude/Codex sessions need their own identity and lifecycle; they are not cloud
Runs. A folder link must never become a local execution grant. External tool results enter existing
custody with tool/version/hash/trust metadata. No companion/native/driver stubs, vendor credential
discovery or local execution capability ships in this package.

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
