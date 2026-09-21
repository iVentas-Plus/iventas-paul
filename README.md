# iventas-paul

MCP server (stdio) that lets AI coding agents — Claude Code, Codex, OpenCode —
register, assign and close the user's tasks in **PAUL** (the iVentas COACH task
manager), file and triage team requests, read their discussion threads, and
administer the team. After finishing dev work, the agent finds the matching
task, starts it, requests PAUL's 3 AI validation questions, and answers them
with the real context of the session's work.

## Tools

### Tasks

| Tool | Purpose |
| --- | --- |
| `paul_tasks` | List the user's tasks with a summary of counts by status |
| `paul_start_task` | Start (or resume) a task by id |
| `paul_task_action` | Pause, send to review, delete, bounce, reassign, or move a task between weeks |
| `paul_reorder_task` | Move a pending task in the queue (spends 1 of 5 weekly priority moves) |

### Assignment

| Tool | Purpose |
| --- | --- |
| `paul_people` | The roster — the only source of the `uid` every assignment needs |
| `paul_register_task` | Create a task in your own list (one direct API call) |
| `paul_assign_task` | Create a task in someone else's list |
| `paul_undo_assignment` | Delete a task you just created, within the server's undo window |

### Closing a task

| Tool | Purpose |
| --- | --- |
| `paul_get_checkpoint` | Get PAUL's 3 validation questions (begins the close flow) |
| `paul_submit_checkpoint` | Submit answers; returns PAUL's verdict |
| `paul_resolve_red_gate` | Resolve a team-visible red flag with an honest prevention plan |
| `paul_confirm_notified` | Clear a task parked until its requester confirms the client was told |

### Peticiones — the team request queue

| Tool | Purpose |
| --- | --- |
| `paul_requests` | The queue grouped by status, with each request's declared money value |
| `paul_create_request` | File a bug, idea, mejora or soporte request (also migrates a historical row) |
| `paul_request_thread` | Read one request with its whole comment thread and mention roster |
| `paul_comment_request` | Comment on a thread, notifying people by uid |
| `paul_request_action` | Take, assign, close (`hecha`) or discard a request |
| `paul_notifications` | The bell: @mentions and thread activity; optionally mark them read |

### Bugs, ideas and tips (historical boards)

| Tool | Purpose |
| --- | --- |
| `paul_bugs` | List team bugs grouped by status, with the assignable roster |
| `paul_report_bug` | Report a bug (the server de-duplicates and may merge it into an existing one) |
| `paul_assign_bug` | Assign an unassigned bug to a teammate |
| `paul_ideas` | List ideas for improving PAUL, with vote counts |
| `paul_create_idea` | Propose an idea |
| `paul_vote_idea` | Upvote an idea |
| `paul_tips` | PAUL's coaching tips — daily, or scoped to one task |

### Administration (accounts with the administrator role)

| Tool | Purpose |
| --- | --- |
| `paul_admin_status` | Team-wide status: forecast, delays, red flags, pulse, commitments, kicked, history |
| `paul_admin_tasks` | Any collaborator's board, or a sweep of everyone's |
| `paul_admin_task_write` | Create, edit, delete or force-complete any task, for any person |
| `paul_admin_people` | List, create, delete collaborators and reset their passwords |
| `paul_admin_page` | Read any admin page not covered by a dedicated tool |
| `paul_admin_action` | Submit any admin form not covered by a dedicated tool |
| `paul_admin_ask` | Ask PAUL's own copilot a question across the whole admin dataset |

### Coach

| Tool | Purpose |
| --- | --- |
| `paul_chat` | Free-form message to PAUL |

> **Peticiones replaced the bug and idea boards.** PAUL now has ONE queue for
> everything the team asks for — bugs, ideas, improvements and support — ordered
> by the money each request brings in or stops the company losing. File new work
> with `paul_create_request`; `paul_report_bug` and `paul_create_idea` still
> work but PAUL labels their boards *histórico*, and a row can be moved across
> with `migrateSrc` + `migrateId`.
>
> **Taking or assigning a request creates a real task.** `paul_request_action`
> with `take`/`assign` returns a `task_id` that exists in that person's mission
> board — and discarding the request afterwards does NOT delete it.
>
> **@mentions need uids, not names.** The `@Name` text in a comment is display
> only; the bell rings from the `mentionUids` array. Two people share the first
> name *Diego*, so `@Diego` notifies nobody — `paul_request_thread` reports the
> ambiguous names, and `paul_comment_request` warns when a mention rang no one.
>
> **How PAUL sees people.** Every assignment identifies a person by their
> **uid** (`david`, `diegoc`, `aleks`) — never by name and never by email.
> Resolve it with `paul_people` first.
>
> **The admin plane is a separate login.** PAUL is one PHP app with one session
> cookie and two independent authentications: the JSON API and the admin panel.
> The JSON API cannot tell you whether an account is an administrator — only
> attempting the panel login can, which is what the `paul_admin_*` tools do.

## Configuration

Two environment variables are required (the server fails fast if either is missing):

- `PAUL_EMAIL` — the collaborator's login email
- `PAUL_PASSWORD` — the collaborator's password

`PAUL_URL` is optional and defaults to `https://iventas.cc/iventas-coach`. Set it only to target a different PAUL deployment during development or testing.

The session cookie is kept in memory only; nothing is written to disk.

### Using shell-exported variables (recommended)

The server reads plain `process.env`, so the credentials can come from your
shell instead of being hardcoded in agent config files. Add to your
`~/.zshrc` / `~/.bashrc`:

```sh
export PAUL_EMAIL=you@company.com
export PAUL_PASSWORD=your-password

# Optional: use a non-production PAUL deployment for development or testing.
export PAUL_URL=https://example.com/iventas-coach
```

Each agent then forwards them as shown below — the config files stay free of
secrets and can be committed/shared; every teammate uses their own exports.

## Quick install

One command per agent, run from the repo where you want the tools
(assumes the shell exports above):

```sh
# Claude Code — project scope (writes .mcp.json in the repo root)
claude mcp add paul --scope project \
  --env PAUL_EMAIL='${PAUL_EMAIL}' --env PAUL_PASSWORD='${PAUL_PASSWORD}' \
  -- npx -y github:iVentas-Plus/iventas-paul

# Claude Code — user scope (all your projects, config outside the repo)
claude mcp add paul --scope user \
  --env PAUL_EMAIL='${PAUL_EMAIL}' --env PAUL_PASSWORD='${PAUL_PASSWORD}' \
  -- npx -y github:iVentas-Plus/iventas-paul
```

For Codex and OpenCode, paste the blocks below into their config files.

## Per-agent setup

All examples run the server straight from GitHub with
`npx -y github:iVentas-Plus/iventas-paul` (Node 20+; private repos need git
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
      "args": ["-y", "github:iVentas-Plus/iventas-paul"],
      "env": {
        "PAUL_EMAIL": "${PAUL_EMAIL}",
        "PAUL_PASSWORD": "${PAUL_PASSWORD}"
      }
    }
  }
}
```

To override the production URL for development or testing, add `PAUL_URL` to
the environment block. Hardcoding real values also works — but then the file
must never be committed.

### Codex — `~/.codex/config.toml`

Codex sanitizes the environment of MCP servers: exported shell variables do
NOT reach the server unless allowlisted with `env_vars`:

```toml
[mcp_servers.paul]
command = "npx"
args = ["-y", "github:iVentas-Plus/iventas-paul"]
env_vars = ["PAUL_EMAIL", "PAUL_PASSWORD"]
```

Alternatively, hardcode static values under `[mcp_servers.paul.env]` (keep
that file out of version control).

> **Codex sandbox — read this before reporting a bug.** Under Codex's default
> `workspace-write` sandbox every tool call here is cancelled, and the model
> reports it as *"MCP tool call was canceled"* with nothing in the server's
> logs. The cause is that MCP subprocesses do **not** inherit
> `sandbox_workspace_write.network_access`. Measured on Codex, in this order:
>
> | Configuration | Shell `curl` to PAUL | MCP tool call |
> | --- | --- | --- |
> | default `workspace-write` | 200 | cancelled |
> | `-c sandbox_workspace_write.network_access=true` | 200 | **still cancelled** |
> | `--sandbox danger-full-access` | 200 | works |
>
> So granting network access to the workspace is NOT a fix — it was tried and
> the subprocess stayed blocked. Until Codex propagates that permission to MCP
> subprocesses, the only configuration that works is:
>
> ```sh
> codex --sandbox danger-full-access
> ```
>
> Scope it deliberately: that flag lifts the sandbox for the whole session, so
> prefer a session started in the repo you are working on rather than making it
> the global default. This is a Codex limitation and it applies to any
> network-dependent MCP server, not just this one. Claude Code and OpenCode are
> unaffected and need no sandbox change.

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
      "command": ["npx", "-y", "github:iVentas-Plus/iventas-paul"],
      "environment": {
        "PAUL_EMAIL": "{env:PAUL_EMAIL}",
        "PAUL_PASSWORD": "{env:PAUL_PASSWORD}"
      }
    }
  }
}
```

The same block works globally in `~/.config/opencode/opencode.json`. Add `PAUL_URL` only when overriding the production default for development or testing.

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
