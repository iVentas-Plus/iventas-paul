import { z } from "zod";
import { textResult, errorResult } from "./shared.js";
/**
 * Registers the tool that clears the "waiting for the client to be told"
 * state.
 *
 * A task created with a requester ("Solicitada por") is NOT closed by whoever
 * executed it: PAUL parks it until the requester states they told the client
 * the work is done. Without this tool a task the MCP created could get stuck
 * in that state forever, because nothing else here can clear it.
 */
export function registerConfirmNotifiedTool(server, client) {
    server.registerTool("paul_confirm_notified", {
        title: "Confirm you already told the client the work is done",
        description: "Close a task that is parked waiting for its REQUESTER to confirm the " +
            "CLIENT was told the work is finished (the app's '✓ YA AVISÉ YO' " +
            "button). This records a HUMAN action: it asserts that the user " +
            "personally notified the client. Call it ONLY when the user has " +
            "explicitly said they notified the client — never infer it, never " +
            "assume it from the work being done, from a message you drafted, or " +
            "from the task looking finished. It closes the task for good: there " +
            "is no undo, and a false confirmation leaves a client who was never " +
            "told while PAUL reports the loop as closed. If the user has not said " +
            "so, ask them first. The app only renders that button for the task's " +
            "requester, so a call from anyone else is expected to be refused — " +
            "that gate was read off the UI and NOT verified against the server, so " +
            "treat a refusal as informative rather than surprising.",
        inputSchema: {
            id: z
                .number()
                .int()
                .positive()
                .describe("Task id awaiting the client notice (from paul_tasks)"),
        },
    }, async ({ id }) => {
        try {
            const res = await client.confirmNotified(id);
            // A non-2xx response throws, so reaching here means PAUL accepted it.
            return textResult({ ok: res?.ok ?? true, api: res ?? null });
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
