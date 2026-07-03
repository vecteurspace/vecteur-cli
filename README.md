# Vecteur CLI

Run space-mission-engineering queries from your terminal — an interactive agent that works on
your local files. The `vecteur` CLI is a **thin, open-source client**: the agent, physics
libraries, and models run on Vecteur's servers, so nothing proprietary ships in this package.

![Vecteur CLI](https://raw.githubusercontent.com/vecteurspace/vecteur-cli/main/assets/screenshot.png)

```bash
npm install -g @vecteur/cli
vecteur login          # opens your browser to approve this device
cd my-mission/         # this directory becomes your workspace
vecteur                # start an interactive session
```

## Install

```bash
npm install -g @vecteur/cli
```

One command on **macOS, Windows, and Linux** — needs [Node 18+](https://nodejs.org). Standalone
apps (no Node required) are coming soon. Run `vecteur` (no args) with no token and it will start
the sign-in flow for you.

## Interactive session

`vecteur` opens a full-screen session. The current directory **is** your workspace — return to it
later and the conversation resumes.

- Type naturally to ask engineering questions; the oracle and its subagents run server-side and
  stream their work (classify → resolve → execute) as they go.
- `@path` — attach a local file as context (sandboxed to the current folder).
- `/` — a slash-command menu: `↑`/`↓` to select, `Tab` to complete, `Enter` to run.
  Commands: `/usage`, `/files`, `/project`, `/open`, `/new`, `/clear`, `/help`, `/exit`.
- `↑`/`↓` recalls previous prompts; `Ctrl-D` exits.

The first thing you ask becomes the project's title in the web app.

## One-shot & scripting

```bash
vecteur ask "period at 550 km circular" --project <id>
vecteur ask "explain this" --file ./mission.md   # attach local files as context
vecteur projects              # your projects (same as the web app at vecteur.space)
vecteur whoami                # who you're signed in as
vecteur update                # upgrade to the latest version
```

## Use it from an AI assistant (MCP)

No install needed — connect Vecteur to Claude, Cursor, or any MCP-capable assistant:

```bash
claude mcp add --transport http vecteur https://api.vecteur.space/mcp
```

Other MCP clients (Cursor, etc.) take a config block:

```json
{
  "mcpServers": {
    "vecteur": {
      "url": "https://api.vecteur.space/mcp",
      "headers": { "Authorization": "Bearer YOUR_ACCESS_KEY" }
    }
  }
}
```

Create an access key in the web app under **Account → Access keys**. The same key works for the
CLI, MCP, and direct API calls.

## Configuration

- `VECTEUR_API_URL` — point at a different Vecteur instance (default `https://api.vecteur.space`).
- `VECTEUR_TOKEN` — supply an access key non-interactively (CI).

Credentials are stored at `~/.config/vecteur/config.json` (owner-only).

## What this package contains (and doesn't)

This is a client. It sends your queries (and any files you explicitly attach) to the Vecteur API
and streams results back. It contains **no** agent logic, physics code, prompts, or API keys — a
CI gate (`.github/workflows/ci.yml` + `scripts/check-no-ip-leak.sh`) scans every change and the
published tarball ships only compiled client code + LICENSE + README.

## Development

```bash
npm install
npm run build      # clean + tsc -> dist/
npm run typecheck
npm test           # vitest (ink render + unit tests)
```

## License

MIT — see [LICENSE](./LICENSE).
