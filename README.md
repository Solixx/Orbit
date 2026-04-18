# Orbit

Self-hosted web UI for controlling Cursor CLI from your phone, tablet, or another computer. Runs on your macOS or Windows machine, accessed privately via Tailscale. Your prompts never leave your devices.

> ## Security notice — do NOT expose this server to the public internet
>
> Orbit executes `cursor`, `git`, and dev-server commands against your local codebase. Exposing it on a public IP or a public ngrok tunnel gives anyone who finds the URL the ability to read, modify, and push your code, and to run arbitrary processes on your machine.
>
> Only ever run it behind a private network (Tailscale, WireGuard, VPN) or bound to `127.0.0.1`. Always set a strong random `AUTH_TOKEN` (`openssl rand -hex 32`) as a second line of defense.

## How It Works

```
Phone/Tablet/Windows PC  ──(Tailscale VPN)──>  Your macOS/Windows machine (Express + Cursor CLI)
```

The web server runs on your macOS/Windows machine alongside Cursor. You access it from any device with a browser (Android, iOS/iPadOS, Windows, etc.) via Tailscale (private mesh VPN). ngrok is only used for previewing your actual dev server output, not the control panel.

## Prerequisites

- Node.js 20.12+
- [Cursor CLI](https://cursor.com) installed and authenticated (`cursor login` or `agent login`)
- [Tailscale](https://tailscale.com) installed on the machine running Orbit (macOS/Windows) and any client devices you’ll use to access it (Android/iOS/Windows) (free for personal use)
- An [ngrok](https://ngrok.com) account for dev server preview tunnels (free tier works)

## Setup

```bash
# Install dependencies
npm install

# Copy env template and fill in your values
cp .env.example .env

# Start the server
npm run dev
```

### Docker Setup

```bash
# Build and run with Docker Compose
docker compose up -d

# Or build manually
docker build -t orbit .
docker run -p 4000:4000 --env-file .env orbit
```

## Tailscale Setup

1. Install Tailscale on your macOS/Windows machine and on your client device(s) (Android/iOS/Windows)
2. Sign in with the same account on all devices
3. Find your machine's Tailscale IP:
   ```bash
   tailscale ip -4
   # Example output: 100.100.50.1
   ```
4. Start Orbit: `npm run dev`
5. Open `http://100.100.50.1:4000` on your phone/tablet/PC
6. Bookmark it or add to your home screen for quick access (PWA supported)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4000` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `AUTH_TOKEN` | No | | Optional bearer token for extra security |
| `NGROK_AUTHTOKEN` | For tunnels | | ngrok auth token for preview tunnels |
| `CURSOR_API_KEY` | No | | Cursor API key (if not using `agent login`) |
| `PROJECTS_DIR` | No | | Base dir to scan for project picker |
| `PROMPT_TIMEOUT_MS` | No | `300000` | Prompt timeout in ms (5 min) |
| `INTERACTIVE_TIMEOUT_MS` | No | `120000` | Per-request timeout for permission/ask/plan dialogs (ms) |
| `DISCONNECT_GRACE_MS` | No | `30000` | Grace period before auto-rejecting pending requests when all clients disconnect (ms) |
| `LLM_INACTIVITY_WARN_MS` | No | `45000` | Warn the UI when the LLM has been silent this long (ms) |
| `AGENT_BIN` | No | `agent` | Path to Cursor agent CLI binary |
| `LOG_LEVEL` | No | `info` | Pino log level (debug, info, warn, error) |

## Web UI Features

- **Project picker** -- dropdown of all directories under `PROJECTS_DIR`
- **Model selector** -- choose any Cursor-supported model
- **Three modes** -- Agent (edits files), Ask (read-only), Plan (analysis)
- **Live streaming** -- see Cursor output in real time via WebSocket
- **Dev server** -- start/stop `npm run dev` from your phone
- **Tunnel** -- start an ngrok tunnel to preview your app on your device
- **Cancel** -- stop a running prompt mid-execution
- **Git panel** -- full git workflow (status, stage, commit, push, branches, merge, stash, diff view)
- **PWA** -- add to home screen for native-like experience
- **Keyboard shortcuts** -- Enter/Cmd+Enter to send, Escape to cancel
- **Toast notifications** -- non-intrusive status updates
- **Connection banner** -- auto-reconnect with countdown when disconnected

## API Reference

### Core

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/health` | -- | Health check with uptime, memory, service status |
| GET | `/api/status` | -- | Full session status |
| GET | `/api/projects` | -- | List project directories |
| POST | `/api/project` | `{ path }` | Set active project |
| GET | `/api/models` | -- | List known models |
| POST | `/api/model` | `{ name }` | Set active model |
| POST | `/api/dev/start` | `{ command? }` | Start dev server |
| POST | `/api/dev/stop` | -- | Stop dev server |
| POST | `/api/tunnel/start` | `{ port? }` | Start ngrok tunnel |
| POST | `/api/tunnel/stop` | -- | Stop tunnel |
| POST | `/api/prompt/cancel` | -- | Cancel running prompt |

### Git

| Method | Path | Body / Query | Description |
|--------|------|------|-------------|
| GET | `/api/git/status` | -- | Parsed git status (branch, ahead/behind, file lists) |
| GET | `/api/git/diff` | `?file=...&staged=1` | Git diff (optional file filter, staged flag) |
| POST | `/api/git/stage` | `{ files: string[] }` | Stage files |
| POST | `/api/git/unstage` | `{ files: string[] }` | Unstage files |
| POST | `/api/git/commit` | `{ message }` | Create a commit |
| GET | `/api/git/branches` | -- | List branches |
| POST | `/api/git/checkout` | `{ branch }` | Switch branch |
| POST | `/api/git/branch/create` | `{ name, startPoint? }` | Create and switch to new branch |
| POST | `/api/git/branch/delete` | `{ name, force? }` | Delete a branch |
| POST | `/api/git/merge` | `{ branch }` | Merge branch into current |
| POST | `/api/git/merge/abort` | -- | Abort an in-progress merge |
| POST | `/api/git/discard` | `{ files: string[] }` | Discard unstaged changes |
| POST | `/api/git/discard-all` | -- | Discard all unstaged changes |
| POST | `/api/git/reset` | `{ mode, target? }` | Reset (soft/mixed/hard) |
| POST | `/api/git/stash` | `{ message? }` | Stash changes |
| POST | `/api/git/stash/pop` | `{ index? }` | Pop a stash entry |
| GET | `/api/git/stash/list` | -- | List stash entries |
| POST | `/api/git/stash/drop` | `{ index? }` | Drop a stash entry |
| GET | `/api/git/log` | `?count=20` | Commit log (max 100) |
| POST | `/api/git/push` | `{ force? }` | Push to remote |
| POST | `/api/git/fetch` | -- | Fetch all remotes |

### WebSocket

| Path | Description |
|------|-------------|
| `ws://host:port/ws?token=...` | Prompt streaming via WebSocket |

**Client sends:** `{ type: "prompt", message: "...", mode: "agent"|"ask"|"plan" }`

**Server sends:** `{ type: "start" }`, `{ type: "chunk", data: "..." }`, `{ type: "done", exitCode, timedOut }`, `{ type: "error", message: "..." }`

## Development

```bash
npm run dev          # Start with hot reload
npm test             # Run tests
npm run typecheck    # TypeScript check
npm run lint         # Biome lint
npm run lint:fix     # Auto-fix lint issues
npm run format       # Format code
npm run build        # Production build
```

## Security

- **Optional bearer token** auth for all API routes and WebSocket
- **Helmet** for secure HTTP headers (CSP, X-Frame-Options, HSTS)
- **Rate limiting** on API routes (120 req/min) and destructive operations (20 req/min)
- **Zod validation** on all POST request bodies
- **CORS** configured for credential-bearing requests
- **Designed for Tailscale** -- access over private mesh VPN, not the public internet

## Typical Workflow

1. Open Orbit on your phone via Tailscale IP
2. Select your project from the dropdown
3. Choose a model (defaults to composer-1.5)
4. Type a prompt and tap Send
5. Watch the output stream in real time
6. Tap "Dev Start" to run the dev server
7. Tap "Tunnel Start" to get a preview URL
8. Open the preview URL on your phone to test the result
9. Use the Git panel to stage, commit, and push changes
10. Send another prompt to iterate

## License

Orbit is **source-available** software, not open source. It is released under the custom [Orbit Source-Available License](./LICENSE).

In short:

- You **can** clone the repo and run it for personal / non-commercial use.
- You **can** submit pull requests — they are reviewed and accepted at the maintainer's discretion.
- You **cannot** use it commercially (as part of a paid product or service) without a separate license.

For commercial licensing or any use not covered above, open an issue on this repository.

## Community

[Discord](https://discord.gg/A5nPrsbc47) — discussion and support for Orbit.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, conventions, and PR process. By submitting a contribution you agree to the contribution terms in the [LICENSE](./LICENSE).
