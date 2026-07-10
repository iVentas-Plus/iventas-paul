# iventas-paul

MCP server (stdio) that lets AI coding agents — Claude Code, Codex, OpenCode —
register and close the user's tasks in **PAUL** (the iVentas COACH task
manager). After finishing dev work, the agent finds the matching task, starts
it, requests PAUL's 3 AI validation questions, and answers them with the real
context of the session's work. There is no direct create-task API in PAUL, so
new tasks are registered through PAUL's coach chat dialogue with defensive
verification against the task list.

## Tools

| Tool | Purpose |
| --- | --- |
| `paul_tasks` | List the user's tasks with a summary of counts by status |
| `paul_start_task` | Start (or resume) a task by id |
| `paul_get_checkpoint` | Get PAUL's 3 validation questions (begins the close flow) |
| `paul_submit_checkpoint` | Submit answers; returns PAUL's verdict |
| `paul_register_task` | Register a new task via the chat dialogue, verified against state |
| `paul_reorder_task` | Move a pending task in the queue (spends 1 of 5 weekly priority moves) |
| `paul_resolve_red_gate` | Resolve a team-visible red flag with an honest prevention plan |
| `paul_chat` | Free-form message to PAUL (reorder, pause, ask anything) |

## Configuration

Three environment variables (the server fails fast if any is missing):

- `PAUL_URL` — base URL up to the app folder, e.g. `https://example.com/iventas-coach`
- `PAUL_EMAIL` — the collaborator's login email
- `PAUL_PASSWORD` — the collaborator's password

The session cookie is kept in memory only; nothing is written to disk.

### Using shell-exported variables (recommended)

The server reads plain `process.env`, so the credentials can come from your
shell instead of being hardcoded in agent config files. Add to your
`~/.zshrc` / `~/.bashrc`:

```sh
export PAUL_URL=https://example.com/iventas-coach
export PAUL_EMAIL=you@company.com
export PAUL_PASSWORD=your-password
```

Each agent then forwards them as shown below — the config files stay free of
secrets and can be committed/shared; every teammate uses their own exports.

## Quick install

One command per agent, run from the repo where you want the tools
(assumes the shell exports above):

```sh
# Claude Code — project scope (writes .mcp.json in the repo root)
claude mcp add paul --scope project \
  --env PAUL_URL='${PAUL_URL}' --env PAUL_EMAIL='${PAUL_EMAIL}' --env PAUL_PASSWORD='${PAUL_PASSWORD}' \
  -- npx -y github:diegosiac/iventas-paul

# Claude Code — user scope (all your projects, config outside the repo)
claude mcp add paul --scope user \
  --env PAUL_URL='${PAUL_URL}' --env PAUL_EMAIL='${PAUL_EMAIL}' --env PAUL_PASSWORD='${PAUL_PASSWORD}' \
  -- npx -y github:diegosiac/iventas-paul
```

For Codex and OpenCode, paste the blocks below into their config files.

## Per-agent setup

All examples run the server straight from GitHub with
`npx -y github:diegosiac/iventas-paul` (Node 20+; private repos need git
authenticated with repo access on that machine). Prefer **project-scoped**
config in your work repos: it keeps personal projects clean — agents only see
the PAUL tools where they are relevant.

### Claude Code — project `.mcp.json`

`${VAR}` placeholders are expanded by Claude Code from the environment, so
this exact block is safe to commit:

```json
{
  "mcpServers": {
    "paul": {
      "command": "npx",
      "args": ["-y", "github:diegosiac/iventas-paul"],
      "env": {
        "PAUL_URL": "${PAUL_URL}",
        "PAUL_EMAIL": "${PAUL_EMAIL}",
        "PAUL_PASSWORD": "${PAUL_PASSWORD}"
      }
    }
  }
}
```

`${PAUL_URL:-https://example.com/iventas-coach}` sets a default so only the
credentials need exporting. Hardcoding real values also works — but then the
file must never be committed.

### Codex — `~/.codex/config.toml`

Codex sanitizes the environment of MCP servers: exported shell variables do
NOT reach the server unless allowlisted with `env_vars`:

```toml
[mcp_servers.paul]
command = "npx"
args = ["-y", "github:diegosiac/iventas-paul"]
env_vars = ["PAUL_URL", "PAUL_EMAIL", "PAUL_PASSWORD"]
```

Alternatively, hardcode static values under `[mcp_servers.paul.env]` (keep
that file out of version control).

### OpenCode — project `opencode.json`

`{env:VAR}` placeholders are expanded by OpenCode from the environment, so
this exact block is safe to commit (an unset variable becomes an empty
string and the server fails fast telling you which one is missing):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "paul": {
      "type": "local",
      "command": ["npx", "-y", "github:diegosiac/iventas-paul"],
      "environment": {
        "PAUL_URL": "{env:PAUL_URL}",
        "PAUL_EMAIL": "{env:PAUL_EMAIL}",
        "PAUL_PASSWORD": "{env:PAUL_PASSWORD}"
      }
    }
  }
}
```

The same block works globally in `~/.config/opencode/opencode.json`.

## Installing the skill into a work repo

The skill teaches Claude Code *when* to use the tools (register/close tasks
after finishing dev work, answer checkpoints from real session context):

```sh
mkdir -p .claude/skills/paul
cp node_modules/iventas-paul/skills/paul/SKILL.md .claude/skills/paul/
# or copy skills/paul/SKILL.md from a checkout of this repo
```

For Codex/OpenCode, paste the block from `AGENTS-snippet.md` into the repo's
`AGENTS.md`.

## Development

```sh
npm install    # also builds via the prepare script
npm test       # vitest unit tests (fetch is mocked; never hits a live server)
npm run build  # tsc -> dist/
```

## Security note

Prefer shell-exported variables with `${VAR}` / `{env:VAR}` / `env_vars`
forwarding: the config files stay free of secrets. If you hardcode real
credentials in `.mcp.json` / `config.toml` / `opencode.json`, keep those
files out of version control. This server never persists the session cookie
or credentials to disk.
