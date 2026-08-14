import { z } from "zod";
import { textResult, errorResult } from "./shared.js";
/**
 * Every lifecycle action PAUL exposes for an EXISTING task, behind one tool.
 * They share a shape — an id plus at most a reason or a target — so a single
 * dispatcher is the honest abstraction; one tool per verb would be seven
 * near-identical registrations competing for the agent's attention.
 */
const ACTIONS = [
    "pause",
    "review",
    "delete",
    "bounce",
    "reassign",
    "push_week",
    "pull_week",
];
async function runAction(client, action, id, toUid, reason) {
    switch (action) {
        case "pause":
            return client.pauseTask(id);
        case "review":
            return client.waitTask(id);
        case "delete":
            return client.deleteTask(id);
        case "bounce":
            return client.bounceTask(id);
        case "reassign":
            if (!toUid) {
                throw new Error("action 'reassign' needs `toUid` — the uid of the new owner.");
            }
            if (!reason) {
                throw new Error("action 'reassign' needs `reason`: PAUL forwards it to the admins and learns from it.");
            }
            return client.taskReassign(id, toUid, reason);
        case "push_week":
            if (!reason) {
                throw new Error("action 'push_week' needs `reason` — PAUL records why it slipped.");
            }
            return client.pushWeek(id, reason);
        case "pull_week":
            return client.pullWeek(id);
    }
}
export function registerTaskActionTool(server, client) {
    server.registerTool("paul_task_action", {
        title: "Act on an existing PAUL task",
        description: "Run a lifecycle action on a task that already exists. Actions: " +
            "'pause' freezes the clock and frees a parallel slot (resume with " +
            "paul_start_task); 'review' sends it to human review, also stopping " +
            "the clock; 'delete' removes it — but when the autopilot is off for " +
            "that department the server QUEUES the deletion for an admin instead, " +
            "so check `deleted` in the response rather than assuming it is gone; " +
            "'bounce' returns it to whoever requested it ('this isn't mine') and " +
            "takes no target, since the requester is implicit; 'reassign' hands it " +
            "to another person (needs toUid AND reason — PAUL notifies the admins " +
            "with that reason) and the real UI only offers it on tasks PAUL itself " +
            "assigned; 'push_week' moves it to next week (needs reason); " +
            "'pull_week' brings a future task into this week. Resolve toUid with " +
            "paul_people. To CREATE a task use paul_register_task or " +
            "paul_assign_task instead.",
        inputSchema: {
            id: z.number().int().positive().describe("Task id, from paul_tasks"),
            action: z.enum(ACTIONS).describe("What to do with the task"),
            toUid: z.string().optional().describe("New owner's uid — 'reassign' only"),
            reason: z
                .string()
                .optional()
                .describe("Why — required by 'reassign' and 'push_week'"),
        },
    }, async ({ id, action, toUid, reason }) => {
        try {
            const res = (await runAction(client, action, id, toUid, reason));
            return textResult({ action, id, ...res }, res?.ok === false);
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
export function registerUndoAssignmentTool(server, client) {
    server.registerTool("paul_undo_assignment", {
        title: "Undo a task you just created",
        description: "Delete a task that was just created, using the taskId returned by " +
            "paul_assign_task or paul_register_task. Use it immediately: the " +
            "server only accepts the undo while the task is untouched, young, and " +
            "you are its requester or assignee — otherwise it answers " +
            "{ ok: false, message } explaining the refusal, which is NOT an error " +
            "to retry. Past that window, remove the task with paul_task_action " +
            "action 'delete'.",
        inputSchema: {
            taskId: z
                .number()
                .int()
                .positive()
                .describe("The taskId returned when the task was created"),
        },
    }, async ({ taskId }) => {
        try {
            const res = await client.assignUndo(taskId);
            return textResult({ taskId, ...res }, res.ok !== true);
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
