---
name: paul
description: "Trigger: finish task, task done, register task, registrar tarea, checkpoint, PAUL. Register and close the user's tasks in PAUL via paul_* MCP tools."
---

## Activation Contract

Activate when dev work in a work project BEGINS (feature picked up, bug taken) and again when it reaches a done state (feature finished, bug fixed, PR merged), or the user asks to register/close a task in PAUL. Requires the paul\_\* MCP tools. Do nothing for personal projects unless asked.

## Hard Rules

- Register AND START the task in PAUL when BEGINNING the dev work, not after finishing: PAUL's Start/Finish timestamps must reflect the real work. Closing right after registering always triggers a team-visible too_fast red flag (under 2 effective minutes).
- Only close (checkpoint) tasks you actually started and worked on. The server does not check status and would record a completion with zero work — dishonest and team-visible.
- If the checkpoint verdict includes a `red_gate`, resolve it immediately with `paul_resolve_red_gate` and an HONEST plan (canonical: register and start the PAUL task when the real work begins, close it when it ends).
- Checkpoint answers MUST come from this session's real work context: what was done, files touched, PRs, test/build outcomes. Never generic filler.
- If a checkpoint is rejected, add the ONE concrete detail PAUL requested to the weak answer and retry exactly once.
- Never invent a task id. Resolve it from `paul_tasks` first.
- In `paul_chat` free text: NEVER include urgency words (alta/media/baja/urgente/normal/regular/low...) unless answering PAUL's urgency question — they would commit a stale server-side pending assignment. And avoid asking the coach to "start the next task": it can silently reorder the list and deactivate the active task.
- Don't poll `paul_tasks` in a loop: the state endpoint has server-side side effects (coach messages, nudges).
- Preserve PAUL's Spanish replies verbatim when reporting them.

## Decision Gates

- Starting dev work with a matching task in `paul_tasks` → `paul_start_task` now; close it when the work ends.
- Starting dev work with no matching task → `paul_register_task` (title + urgency, no urgency words in the title — this includes ABM phrasing: rephrase "Dar de alta X" as "Habilitar X" and "Dar de baja X" as "Desactivar X"), then `paul_start_task` on the returned taskId.
- `paul_start_task` returns `error: order` → `paul_reorder_task` with to=0 (costs 1 of 5 weekly moves — spend consciously) or finish the current first pending task.
- `paul_start_task` returns `error: parallel_limit` → max 2 tasks active and the clock splits 50/50 while 2 run; finish or pause one first.
- `paul_register_task` returns ok:false → show paulReply to the user; recover with `paul_chat` or a clearer title.
- Task was assigned by someone else → approval parks it in status 'confirm' until the requester acks. That is expected; do not retry.

## Execution Steps

1. When the dev work BEGINS: `paul_tasks` — locate (or `paul_register_task` to create) the matching task.
2. `paul_start_task` with its id (skip if already active; 'waiting' tasks resume with the same tool).
3. Do the real dev work with the task running (at least 2 effective minutes).
4. When the work ENDS: `paul_get_checkpoint` — fetch PAUL's 3 validation questions (call it ONCE; every call spends AI budget).
5. Draft answers from the session's real context; pair each with its exact question text.
6. `paul_submit_checkpoint` — submit; on rejection, improve per PAUL's feedback and retry once. If the verdict carries a `red_gate`, resolve it immediately with `paul_resolve_red_gate`.

## Output Contract

Report to the user: task id and title, PAUL's verdict (approved or the requested improvement, verbatim), any red gate raised and its resolution, and any non-converged step with PAUL's actual reply. One short summary, no logs.
