import { z } from "zod";
import { textResult, errorResult } from "./shared.js";
/** Statuses the bug board always reports, in board order (api.php bugs_list). */
const BUG_STATUSES = ["abierto", "en_proceso", "resuelto"];
/** Defensive read: the API omits `notes` on bugs that have none. */
function safeArray(value) {
    return Array.isArray(value) ? value : [];
}
function summarize(bug) {
    const notes = safeArray(bug.notes);
    return {
        id: bug.id,
        title: bug.title,
        status: bug.status,
        reports: bug.reports ?? 1,
        assignee: bug.assignee ?? null,
        notes: notes.map((n) => ({
            who: n.who ?? null,
            note: n.note ?? null,
            images: safeArray(n.images),
        })),
    };
}
export function registerBugsTools(server, client) {
    server.registerTool("paul_bugs", {
        title: "List PAUL bug reports",
        description: "List every bug reported against PAUL itself by the team, grouped by " +
            "status (abierto | en_proceso | resuelto) with a count summary. Each " +
            "bug carries: id, title, status, reports, assignee and notes. IMPORTANT: " +
            "`assignee` is a display NAME, not a uid — it can never be fed back into " +
            "paul_assign_bug. `reports` > 1 means several people reported the same " +
            "thing: the server de-duplicates equivalent reports and merges them into " +
            "one bug with extra notes, so do NOT read it as several distinct " +
            "problems. Also returned: `can_assign` (false = this account may not " +
            "assign bugs at all, so paul_assign_bug will be refused) and `team`, the " +
            "assignable roster as { uid, name } — those uids ARE valid for " +
            "paul_assign_bug. This is the HISTORICAL board: new work is filed in " +
            "the Peticiones queue (paul_requests), and a row here can be moved " +
            "there with paul_create_request migrateSrc 'bug' + migrateId.",
        inputSchema: {},
    }, async () => {
        try {
            const data = await client.bugsList();
            const bugs = safeArray(data?.bugs);
            const counts = {};
            const grouped = {};
            for (const status of BUG_STATUSES)
                grouped[status] = [];
            for (const bug of bugs) {
                const status = bug.status ?? "abierto";
                counts[status] = (counts[status] ?? 0) + 1;
                (grouped[status] ??= []).push(summarize(bug));
            }
            return textResult({
                summary: { total: bugs.length, byStatus: counts },
                can_assign: data?.can_assign ?? false,
                team: safeArray(data?.team).map((p) => ({ uid: p.uid, name: p.name })),
                bugs: grouped,
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool("paul_report_bug", {
        title: "Report a bug in PAUL (historical board)",
        description: "Report a bug in PAUL itself (the coach app), not in the user's own " +
            "product. PREFER paul_create_request with kind 'bug': PAUL moved team " +
            "requests to the Peticiones queue and now labels this board " +
            "'histórico'. It is still live — use it only when the user explicitly " +
            "asks for the bug board, or to add a note to a bug that already lives " +
            "here. The report is visible to the whole team. IMPORTANT: a " +
            "response with `grouped: true` means the server judged this report " +
            "equivalent to an existing bug and merged it in as a NOTE instead of " +
            "creating a new bug — that is a SUCCESS, not a failure: the report was " +
            "recorded, it just did not open a duplicate. Do not retry with a " +
            "reworded title when that happens. Image attachments are NOT supported " +
            "here: the real UI uploads them as multipart/form-data, which this tool " +
            "does not speak, so describe the visual evidence in `desc` instead.",
        inputSchema: {
            title: z
                .string()
                .min(4)
                .describe("Short bug title (the PAUL UI requires at least 4 characters)"),
            desc: z
                .string()
                .optional()
                .default("")
                .describe("Optional longer description: steps, expected vs actual behavior"),
        },
    }, async ({ title, desc }) => {
        try {
            const res = await client.bugCreate(title, desc ?? "");
            return textResult({
                ok: res?.ok ?? false,
                grouped: res?.grouped ?? false,
                message: res?.message ?? null,
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool("paul_assign_bug", {
        title: "Assign a PAUL bug to a person",
        description: "Assign an open bug to a teammate with an urgency level. `personUid` " +
            "MUST be a uid taken from paul_people or from the `team` array of " +
            "paul_bugs — never the `assignee` field, which is a display name. The " +
            "server only accepts bugs that are still UNASSIGNED and not resolved " +
            "(assigning an already-assigned or resolved bug is refused), and only " +
            "when `can_assign` is true for this account, so read paul_bugs first " +
            "and check both conditions before calling.",
        inputSchema: {
            bugId: z.number().int().positive().describe("Bug id from paul_bugs"),
            personUid: z
                .string()
                .min(1)
                .describe("uid of the assignee, from paul_people or the team array of paul_bugs"),
            urgency: z
                .enum(["alta", "media", "baja"])
                .describe("Urgency the bug lands with in the assignee's queue"),
        },
    }, async ({ bugId, personUid, urgency }) => {
        try {
            const res = await client.bugAssign(bugId, personUid, urgency);
            // A non-2xx response throws, so reaching here means PAUL accepted the
            // assignment even when the body carries no explicit `ok`.
            return textResult({ ok: res?.ok ?? true, message: res?.message ?? null });
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
