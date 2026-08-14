import { z } from "zod";
import { textResult, errorResult } from "./shared.js";
/**
 * Creates a task for `personUid` through `assign_confirm`.
 *
 * This replaces an earlier implementation that drove PAUL's natural-language
 * coach chat and then diffed the task list to guess whether its own request
 * had landed. That was never necessary: `assign_confirm` is a direct,
 * single-call create — verified against production to work with no prior
 * dialogue and no server-side pending assignment — and its response carries
 * `undo_id`, which IS the new task's id.
 *
 * Dropping the chat path also removes three real defects:
 *   - titles containing an urgency word (media, baja, normal, regular…) were
 *     rejected outright, because in a chat message they read as an answer to
 *     PAUL's urgency question;
 *   - a stale pending assignment in the PHP session could commit a DIFFERENT
 *     task and report it as ours;
 *   - every create spent AI budget on 1-2 coach_chat calls.
 *
 * `assign_confirm` is preferred over `peer_assign`, which is equally direct
 * but returns no task id and accepts neither client nor reason.
 */
export async function assignTask(client, input) {
    const res = await client.assignConfirm({
        personUid: input.personUid,
        title: input.title,
        urgency: input.urgency,
        estMin: input.estMin,
        client: input.client,
        reason: input.reason,
    });
    const taskId = typeof res.undo_id === "number" ? res.undo_id : undefined;
    return {
        ok: res.ok === true,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(res.queued ? { queued: true } : {}),
        paulReply: res.reply ?? null,
        ...(res.message ? { message: res.message } : {}),
    };
}
const URGENCY = z
    .enum(["alta", "media", "baja"])
    .describe("Urgency PAUL expects: alta (high), media (medium), baja (low)");
const EST_MIN = z
    .number()
    .int()
    .min(5)
    .max(1440)
    .optional()
    .describe("Estimated minutes of work (default 60)");
/** Registers the self-assignment tool, kept under its historical name. */
export function registerRegisterTaskTool(server, client) {
    server.registerTool("paul_register_task", {
        title: "Register a new task for yourself in PAUL",
        description: "Create a NEW task in your OWN list in PAUL. One direct API call — no " +
            "chat, no AI budget spent, and the response carries the new taskId. " +
            "Returns { ok: true, taskId, paulReply }. Titles may contain any words " +
            "(an earlier version rejected titles holding 'alta', 'media', 'baja', " +
            "'normal' or 'regular'; that restriction is gone). Keep titles short, " +
            "concrete and action-oriented. To create a task for SOMEONE ELSE use " +
            "paul_assign_task instead. After registering, start the task with " +
            "paul_start_task so PAUL's timestamps reflect the real work — closing " +
            "right after creating raises a team-visible too_fast red flag.",
        inputSchema: {
            title: z.string().min(3).describe("Short, concrete task title"),
            urgency: URGENCY,
            estMin: EST_MIN,
            client: z.string().optional().describe("Client name this task belongs to, if any"),
        },
    }, async ({ title, urgency, estMin, client: clientName }) => {
        try {
            const uid = await client.currentUid();
            if (!uid) {
                return textResult({
                    ok: false,
                    error: "PAUL did not report your uid on login, so the task cannot be " +
                        "addressed. Use paul_people to find it and paul_assign_task with it.",
                }, true);
            }
            const result = await assignTask(client, {
                title,
                urgency,
                personUid: uid,
                estMin,
                client: clientName,
            });
            return textResult(result, !result.ok);
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
/** Registers the tool that assigns work to another collaborator. */
export function registerAssignTaskTool(server, client) {
    server.registerTool("paul_assign_task", {
        title: "Assign a task to another person in PAUL",
        description: "Create a task in ANOTHER collaborator's list. `personUid` is PAUL's " +
            "uid for that person (a short string like 'david', 'diegoc', 'aleks') " +
            "— NOT their name and NOT their email. Resolve it with paul_people " +
            "first; a wrong uid is rejected by the server. Returns { ok: true, " +
            "taskId, paulReply }. IMPORTANT: { queued: true } means the autopilot " +
            "is off for that person's department, so PAUL did NOT assign the task " +
            "— it queued a proposal for an admin to confirm in the panel; do not " +
            "tell the user the work was assigned in that case. Use " +
            "paul_undo_assignment with the returned taskId to revert a mistake, " +
            "but only right away: the server closes the undo window quickly. " +
            "To hand over a task that ALREADY exists, use paul_task_action with " +
            "action 'reassign' instead of creating a duplicate here.",
        inputSchema: {
            title: z.string().min(3).describe("Short, concrete task title"),
            personUid: z.string().min(1).describe("PAUL uid of the assignee (from paul_people)"),
            urgency: URGENCY,
            estMin: EST_MIN,
            client: z.string().optional().describe("Client name this task belongs to, if any"),
            reason: z
                .string()
                .optional()
                .describe("Why this person — PAUL records it and learns from it"),
        },
    }, async ({ title, personUid, urgency, estMin, client: clientName, reason }) => {
        try {
            const result = await assignTask(client, {
                title,
                urgency,
                personUid,
                estMin,
                client: clientName,
                reason,
            });
            return textResult(result, !result.ok);
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
