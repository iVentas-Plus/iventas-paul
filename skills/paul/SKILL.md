---
name: paul
description: "Trigger: finish task, task done, register task, registrar tarea, assign to someone, asignar tarea, checkpoint, report bug, reportar bug, idea, admin, PAUL. Register, assign and close tasks in PAUL, report bugs and ideas, and administer the team via paul_* MCP tools."
---

## Activation Contract

Activate when dev work in a work project BEGINS (feature picked up, bug taken) and again when it reaches a done state (feature finished, bug fixed, PR merged), or the user asks to register/assign/close a task, report a bug or idea, or inspect the team in PAUL. Requires the paul\_\* MCP tools. Do nothing for personal projects unless asked.

## Hard Rules

- Register AND START the task in PAUL when BEGINNING the dev work, not after finishing: PAUL's Start/Finish timestamps must reflect the real work. Closing right after registering always triggers a team-visible too_fast red flag (under 2 effective minutes).
- Only close (checkpoint) tasks you actually started and worked on. The server does not check status and would record a completion with zero work — dishonest and team-visible.
- **Never guess a uid.** PAUL identifies people by uid (`david`, `diegoc`, `aleks`), never by name or email. Resolve it with `paul_people` before any assignment.
- **`queued: true` is not an assignment.** It means the autopilot is off for that department and PAUL only queued a proposal for an admin. Never tell the user the work was assigned.
- If the checkpoint verdict includes a `red_gate`, resolve it immediately with `paul_resolve_red_gate` and an HONEST plan.
- Checkpoint answers MUST come from this session's real work context: what was done, files touched, PRs, test/build outcomes. Never generic filler.
- If a checkpoint is rejected, add the ONE concrete detail PAUL requested to the weak answer and retry exactly once.
- Never invent a task id. Resolve it from `paul_tasks` first.
- Don't poll `paul_tasks` in a loop: the state endpoint has server-side side effects (coach messages, nudges).
- Preserve PAUL's Spanish replies verbatim when reporting them.
- Admin writes (`paul_admin_task_write`, `paul_admin_people`, `paul_admin_action`) hit a live panel with **no undo and no confirmation step**. Never run one the user did not ask for, and ask the user to confirm immediately before EACH one, naming the tool, the exact target (task id or uid) and what becomes irreversible. A confirmation given for one mutation does not carry over to the next.

## Decision Gates

- Starting dev work with a matching task in `paul_tasks` → `paul_start_task` now; close it when the work ends.
- Starting dev work with no matching task → `paul_register_task` (title + urgency), then `paul_start_task` on the returned `taskId`. Titles are plain fields now: any wording is fine.
- The user wants someone ELSE to do it → `paul_people` to resolve the uid, then `paul_assign_task`. To hand over a task that ALREADY exists, use `paul_task_action` with action `reassign` — do not create a duplicate.
- Wrong assignment just made → `paul_undo_assignment` with the returned `taskId`, immediately. Past the window, `paul_task_action` action `delete`.
- `paul_start_task` returns `error: order` → `paul_reorder_task` with to=0 (costs 1 of 5 weekly moves — spend consciously) or finish the current first pending task.
- `paul_start_task` returns `error: parallel_limit` → finish or pause one first (`paul_task_action` action `pause`).
- Something in **PAUL itself** is broken → `paul_report_bug`. It is PAUL's own bug board, not the user's product tracker — a bug in the product the team builds does NOT go here. A `grouped: true` reply means PAUL merged it into an existing bug: that is success, not failure.
- An improvement to PAUL itself → `paul_create_idea`. Ideas are feedback about PAUL, not work items.
- The user asks how the team is doing → `paul_admin_status` with the page that answers it (`forecast` for who won't close the week, `delays` for late deliveries, `redflags` for red flags, `pulse` for activity, `commitments`, `kicked`, `history`).
- The user asks about someone else's tasks → `paul_admin_tasks` (with a uid when you know it; without one it sweeps everybody, one request per person).
- Any admin page with no dedicated tool → `paul_admin_page`; any admin mutation with no dedicated tool → `paul_admin_action`.

## Execution Steps

1. When the dev work BEGINS: `paul_tasks` — locate (or `paul_register_task` to create) the matching task.
2. `paul_start_task` with its id (skip if already active; paused/waiting tasks resume with the same tool).
3. Do the real dev work with the task running (at least 2 effective minutes).
4. When the work ENDS: `paul_get_checkpoint` — fetch PAUL's 3 validation questions (call it ONCE; every call spends AI budget).
5. Draft answers from the session's real context; pair each with its exact question text.
6. `paul_submit_checkpoint` — submit; on rejection, improve per PAUL's feedback and retry once. If the verdict carries a `red_gate`, resolve it immediately with `paul_resolve_red_gate`.

## Output Contract

Report to the user: task id and title, PAUL's verdict (approved or the requested improvement, verbatim), any red gate raised and its resolution, and any non-converged step with PAUL's actual reply. For an assignment, report WHO it landed on and whether it was queued instead. One short summary, no logs.
