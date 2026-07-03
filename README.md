# Vecteur CLI

Run space-mission-engineering queries from your terminal — an interactive agent that works on
your local files. The `vecteur` CLI is a **thin, open-source client**: the agent, physics
libraries, and models run on Vecteur's servers, so nothing proprietary ships in this package.

![Vecteur CLI](https://raw.githubusercontent.com/vecteurspace/vecteur-cli/main/assets/screenshot.png)

```
npm install -g @vecteur/cli
vecteur login          # opens your browser to approve this device
cd my-mission/         # this directory becomes your workspace
vecteur                # start an interactive session
```

## Install

```bash
npm install -g @vecteur/cli
```

Standalone binaries (no Node needed) and `brew` / `winget` / `curl` installers are published with
each release — see the [releases page](https://github.com/vecteurspace/vecteur-cli/releases).

## Use

```bash
vecteur                       # interactive session; the current directory is your workspace
vecteur ask "period at 550 km circular" --project <id>
vecteur ask "explain this" --file ./mission.md   # attach local files as context
vecteur projects              # your projects (same as the web app at vecteur.space)
vecteur whoami                # who you're signed in as
```

Inside the interactive session: type naturally, use `@path` to attach a local file, and
`/help` for commands (`/files`, `/new`, `/open`, `/exit`).

## Use it from an AI assistant (MCP)

No install needed — connect Vecteur to Claude, Cursor, or any MCP-capable assistant:

```bash
claude mcp add --transport http vecteur https://api.vecteur.space/mcp
```

## Configuration

- `VECTEUR_API_URL` — point at a different Vecteur instance (default `https://api.vecteur.space`).
- `VECTEUR_TOKEN` — supply an access key non-interactively (CI).

Credentials are stored at `~/.config/vecteur/config.json` (owner-only).

## What this package contains (and doesn't)

This is a client. It sends your queries (and any files you explicitly attach) to the Vecteur API
and streams results back. It contains **no** agent logic, physics code, prompts, or API keys — a
CI gate (`.github/workflows/ci.yml`) scans every change and the published tarball ships only
compiled client code + LICENSE + README.

## Development

```bash
npm install
npm run build      # tsc typecheck + emit to dist/
npm run typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
