# PAUL task tracking (copy into AGENTS.md)

```markdown
## PAUL task tracking

This project tracks work in PAUL (iVentas COACH) through the paul_* MCP tools.

- When you BEGIN dev work here, register and START the matching task in PAUL
  right away: `paul_tasks` to find it (or `paul_register_task` with title +
  urgency alta|media|baja to create it), then `paul_start_task`. PAUL's
  Start/Finish timestamps must reflect the real work — closing right after
  registering always raises a team-visible too_fast red flag.
- To give work to SOMEONE ELSE, resolve their uid with `paul_people` first,
  then `paul_assign_task`. PAUL identifies people by uid (`david`, `diegoc`,
  `aleks`) — never by name and never by email. To hand over a task that
  ALREADY exists, use `paul_task_action` with action 'reassign' instead of
  creating a duplicate.
- A `queued: true` response is NOT an assignment: the autopilot is off for that
  department, so PAUL only queued a proposal for an admin to confirm. Do not
  report the work as assigned.
- Undo a wrong assignment immediately with `paul_undo_assignment` and the
  returned taskId; past the server's short window use `paul_task_action`
  action 'delete'.
- When the work is DONE, close the task: `paul_get_checkpoint` for the 3
  validation questions (call it once; every call spends AI budget), then
  `paul_submit_checkpoint`. Only close tasks you actually started and worked
  on.
- If the verdict includes a red_gate, resolve it immediately with
  `paul_resolve_red_gate` and an honest plan.
- If `paul_start_task` fails with error 'order', use `paul_reorder_task` with
  to=0 — it costs 1 of 5 weekly priority moves, spend them consciously. With
  'parallel_limit', finish or pause one first (`paul_task_action` action
  'pause').
- Task titles are plain fields: any wording is fine, including "dar de alta",
  "prioridad media" or "urgente".
- Found something broken? `paul_report_bug`. A `grouped: true` reply means the
  server merged your report into an existing bug — that is success. Ideas for
  improving PAUL itself go to `paul_create_idea` (they are product feedback,
  not work items).
- Don't poll `paul_tasks` in a loop: the state endpoint has server-side side
  effects (coach messages, nudges).
- Checkpoint answers MUST describe the real work from this session: what was
  done, files touched, PRs, test/build outcomes. Never generic filler.
- If PAUL rejects a checkpoint, add the one concrete detail it asked for and
  retry once. Report PAUL's verdict to the user verbatim.
- The paul_admin_* tools work only for accounts with the administrator role,
  and their writes hit a live panel with no undo. Never run one the user did
  not ask for.
```
