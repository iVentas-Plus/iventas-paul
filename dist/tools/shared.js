import { PaulApiError } from "../client.js";
/** Wraps a JSON-serializable payload as an MCP text result. */
export function textResult(payload, isError = false) {
    const result = {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
    if (isError)
        result.isError = true;
    return result;
}
/**
 * Converts an exception into an MCP error result. PaulApiError bodies are
 * passed through verbatim: the API returns actionable Spanish messages
 * (e.g. "order", "parallel_limit") the calling agent should read.
 */
export function errorResult(err) {
    if (err instanceof PaulApiError) {
        return textResult({ error: true, status: err.status, api: err.body }, true);
    }
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, message }, true);
}
/**
 * Converts a failed CREATE into a tool result, distinguishing the one thing
 * that decides what the caller should do next: did PAUL answer?
 *
 * An error that carries a status — `PaulApiError` on the JSON plane,
 * `PaulAdminError` on the panel — means the server replied, so the outcome is
 * deterministic and a retry is safe to reason about. Anything else failed at
 * the transport level with no answer at all, and the write may sit on either
 * side of the server's commit. Neither plane de-duplicates (measured in
 * production: two identical `assign_confirm` calls created tasks 947 and 948),
 * so reporting a bare failure is what turns one ambiguous create into two real
 * rows in somebody's board.
 *
 * `answered` tells this helper which error types count as "the server
 * replied"; `verifyWith` names the tool the caller must read BEFORE retrying.
 */
export function createFailureResult(err, answered, verifyWith) {
    if (answered(err))
        return errorResult(err);
    return textResult({
        error: true,
        outcome: "unknown",
        message: err instanceof Error ? err.message : String(err),
        warning: "The row MAY have been created: the request failed before PAUL's " +
            "answer could be read, so the outcome is UNKNOWN. PAUL does NOT " +
            "de-duplicate — two identical calls create two rows (verified in " +
            `production). Do NOT retry blindly: verify first with ${verifyWith} ` +
            "and only create it again if it is not there.",
    }, true);
}
