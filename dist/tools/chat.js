import { z } from "zod";
import { textResult, errorResult } from "./shared.js";
export function registerChatTool(server, client) {
    server.registerTool("paul_chat", {
        title: "Chat with PAUL",
        description: "Send a free-form message to PAUL, the coach, and get its reply. What " +
            "it can actually do: (1) reorder — ask to skip to the next task; this " +
            "needs at least 2 open tasks (with only one, PAUL replies there is " +
            "nothing to skip to) and settles the current task's clock while it " +
            "moves down; (2) register a task conversationally — but prefer " +
            "paul_register_task: it is a single direct call that returns the new " +
            "task id, spending no AI budget and leaving no chat reply to parse; " +
            "(3) ask questions about " +
            "the team or teach PAUL knowledge, or recover when another tool's flow " +
            "did not converge. Do NOT use chat to pause or park a task: " +
            "paul_task_action does that for real (action 'pause' to freeze the " +
            "clock, action 'review' to send it to human review), so never claim " +
            "work was paused in PAUL based on a chat reply. " +
            "Write messages in Spanish for best " +
            "results — PAUL replies in Spanish. Do NOT use this to close tasks " +
            "(use the checkpoint tools). If PAUL's AI spend cap is exhausted the " +
            "reply is a canned non-AI message saying so; the rest of the tools " +
            "keep working.",
        inputSchema: {
            message: z.string().min(1).describe("Message for PAUL (Spanish recommended)"),
        },
    }, async ({ message }) => {
        try {
            const res = await client.coachChat(message);
            return textResult({
                reply: res.reply,
                ai: res.ai,
                mood: res.mood,
                assigned: res.assigned,
                reordered: res.reordered,
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
