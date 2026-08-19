import { z } from "zod";
import { textResult, errorResult } from "./shared.js";
export function registerStartTaskTool(server, client) {
    server.registerTool("paul_start_task", {
        title: "Start a PAUL task",
        description: "Start (activate) a mission by task id. A task must be started before " +
            "it can be closed through the checkpoint flow, and it must be started " +
            "when the real work BEGINS (not after) so PAUL's timestamps reflect " +
            "reality. Three 409 errors and their recoveries: 'order' — only the " +
            "FIRST pending task in queue order can be started; use paul_reorder_task " +
            "with to=0 to move this task to the top (spends a weekly move) or " +
            "finish the current first pending first. 'parallel_limit' — at most 4 " +
            "tasks active at the same time; paused tasks do NOT count toward the " +
            "limit, so finish or pause one to free a slot. 'need_client_brief' — " +
            "sales-department users on client tasks only; the user must fill the " +
            "client context/KPIs in PAUL's UI, this MCP cannot. A task in 'waiting' " +
            "status resumes with this same tool and SKIPS the order gate. If the " +
            "task is already active this succeeds as a no-op.",
        inputSchema: {
            id: z.number().int().positive().describe("Task id from paul_tasks"),
        },
    }, async ({ id }) => {
        try {
            return textResult(await client.startTask(id));
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
