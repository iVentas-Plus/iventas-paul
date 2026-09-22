import { textResult, errorResult } from "./shared.js";
export function registerTasksTool(server, client) {
    server.registerTool("paul_tasks", {
        title: "List PAUL tasks",
        description: "List the authenticated user's tasks (missions) in PAUL with a summary " +
            "of counts by status. Each task includes: id, title, status (pending | " +
            "active | waiting | confirm | done), priority (1=high), position in the " +
            "queue, estimated minutes, overdue info, requester, client, and week. " +
            "Call this FIRST to find the task id that matches the work performed, " +
            "before starting or closing anything. Note: PAUL only allows starting " +
            "the first pending task in queue order. Also returned: moves_left (the " +
            "weekly reorder budget paul_reorder_task spends from), budget_ok " +
            "(false = PAUL's AI spend cap is exhausted; fallback flows apply), ro " +
            "(true = the session is READ-ONLY and ALL writes will 403), and " +
            "pending_red_gate (an unresolved team-visible red flag — resolve it " +
            "via paul_resolve_red_gate) and notifs_new (unread @mentions and " +
            "request-thread activity — read them with paul_notifications). Do NOT " +
            "poll this tool in a loop: the " +
            "state endpoint has server-side side effects (coach messages, nudges).",
        inputSchema: {},
    }, async () => {
        try {
            const state = await client.state();
            const counts = {};
            for (const t of state.tasks)
                counts[t.status] = (counts[t.status] ?? 0) + 1;
            const tasks = state.tasks.map((t, i) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                priority: t.priority,
                position: i + 1,
                estMin: t.estMin,
                effMin: t.effMin,
                overdue: t.overdue,
                overdueMin: t.overdueMin,
                overdueLabel: t.overdueLabel,
                requester: t.requesterName,
                client: t.clientName,
                week: t.week,
                future: t.future,
            }));
            return textResult({
                user: state.user.name,
                week: state.week,
                summary: { total: tasks.length, byStatus: counts },
                moves_left: state.moves_left,
                budget_ok: state.budget?.ok ?? true,
                ro: state.ro ?? false,
                pending_red_gate: state.pending_red_gate ?? null,
                notifs_new: state.notifs_new ?? 0,
                tasks,
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
