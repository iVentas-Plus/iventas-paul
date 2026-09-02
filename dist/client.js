/**
 * HTTP client for the PAUL (iVentas COACH) JSON API.
 *
 * The backend is a single PHP router: `<base>/api.php?action=...`.
 * Auth is a PHP session cookie (name IVCOACH) obtained via `action=login`.
 * Request bodies are JSON (parsed by body_json() in lib/helpers.php);
 * every response is JSON (json_out()).
 */
export const DEFAULT_PAUL_URL = "https://iventas.cc/iventas-coach";
function processEnv() {
    // SAFETY: this package runs only as a Node.js MCP server, where globalThis.process.env exists.
    return globalThis
        .process.env;
}
/** Reads and validates configuration from environment variables. */
export function configFromEnv(env = processEnv()) {
    const missing = [];
    if (!env.PAUL_EMAIL)
        missing.push("PAUL_EMAIL");
    if (!env.PAUL_PASSWORD)
        missing.push("PAUL_PASSWORD");
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}. ` +
            "Set PAUL_EMAIL and PAUL_PASSWORD (the collaborator's login credentials). " +
            "PAUL_URL is optional and defaults to https://iventas.cc/iventas-coach.");
    }
    const rawUrl = env.PAUL_URL?.trim() || DEFAULT_PAUL_URL;
    return {
        url: rawUrl.replace(/\/+$/, ""),
        email: env.PAUL_EMAIL,
        password: env.PAUL_PASSWORD,
    };
}
/** Error carrying the HTTP status and the parsed JSON error body from the API. */
export class PaulApiError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "PaulApiError";
    }
}
/**
 * The single red-gate question, hardcoded server-side in lib/ai.php:548.
 * red_gate_ack expects it back verbatim in the qa array.
 */
export const RED_GATE_QUESTION = "¿Qué vas a hacer para que esto no vuelva a pasar?";
/* ---------- Client ---------- */
export class PaulClient {
    config;
    fetchImpl;
    cookie = null;
    constructor(config, fetchImpl = (...args) => globalThis.fetch(...args)) {
        this.config = config;
        this.fetchImpl = fetchImpl;
    }
    endpoint(action) {
        return `${this.config.url}/api.php?action=${encodeURIComponent(action)}`;
    }
    /** Authenticates and captures the IVCOACH session cookie (in memory only). */
    async login() {
        const res = await this.fetchImpl(this.endpoint("login"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: this.config.email, password: this.config.password }),
        });
        const setCookies = typeof res.headers.getSetCookie === "function"
            ? res.headers.getSetCookie()
            : res.headers.get("set-cookie")
                ? [res.headers.get("set-cookie")]
                : [];
        const session = setCookies.find((c) => c.startsWith("IVCOACH=")) ?? setCookies[0];
        if (session)
            this.cookie = session.split(";")[0];
        const body = (await res.json().catch(() => null));
        if (!res.ok || !body?.ok) {
            throw new PaulApiError(`PAUL login failed (${res.status}): ${body?.message ?? body?.error ?? "unexpected response"}`, res.status, body);
        }
    }
    /**
     * Low-level call to api.php. GET when no body is given, POST with a JSON
     * body otherwise. Logs in lazily on first use; on a 401 / no_auth response
     * it re-logins once and retries the request once.
     */
    async request(action, body) {
        if (!this.cookie)
            await this.login();
        let attempt = await this.doFetch(action, body);
        if (attempt.noAuth) {
            await this.login();
            attempt = await this.doFetch(action, body);
        }
        const { res, parsed } = attempt;
        if (!res.ok) {
            const b = parsed;
            throw new PaulApiError(`PAUL API error on action=${action} (${res.status}): ${b?.message ?? b?.error ?? "unexpected response"}`, res.status, parsed);
        }
        return parsed;
    }
    async doFetch(action, body) {
        const headers = {};
        if (this.cookie)
            headers["Cookie"] = this.cookie;
        let init = { method: "GET", headers };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
            init = { method: "POST", headers, body: JSON.stringify(body) };
        }
        const res = await this.fetchImpl(this.endpoint(action), init);
        const parsed = (await res.json().catch(() => null));
        const noAuth = res.status === 401 || parsed?.error === "no_auth";
        return { res, parsed, noAuth };
    }
    /* ---------- Typed wrappers over api.php actions ---------- */
    /** GET action=state — full dashboard state including the user's tasks. */
    state() {
        return this.request("state");
    }
    /** POST action=start_task with { id }. */
    startTask(id) {
        return this.request("start_task", { id });
    }
    /** POST action=request_questions with { id } — begins the close flow. */
    requestQuestions(id) {
        return this.request("request_questions", { id });
    }
    /** POST action=submit_validation with { id, qa: [{ q, a }, ...] }. */
    submitValidation(id, qa) {
        return this.request("submit_validation", { id, qa });
    }
    /**
     * POST action=reorder_task with { id, to, reason } — moves a PENDING task
     * to a 0-based index within the user's open list (pending+active+waiting
     * ordered by position). Costs 1 of the 5 weekly priority moves; the API
     * answers 409 bad_status for non-pending tasks, 422 need_reason without a
     * reason, and 429 { error: "no_moves", moves_left: 0 } when the weekly
     * budget is spent (api.php:183-230).
     */
    reorderTask(id, to, reason) {
        return this.request("reorder_task", { id, to, reason });
    }
    /**
     * POST action=red_gate_ack with { flag_id, qa, plan } — resolves a
     * team-visible red flag from a checkpoint verdict. The gate has exactly one
     * hardcoded question (lib/ai.php:546-577), so the qa array is built here
     * from the plan; the AI evaluates the plan's seriousness and may answer
     * { ok: true, approved: false } asking for a more concrete plan.
     */
    redGateAck(flagId, plan) {
        return this.request("red_gate_ack", {
            flag_id: flagId,
            qa: [{ q: RED_GATE_QUESTION, a: plan }],
            plan,
        });
    }
    /** POST action=coach_chat with { message }. */
    coachChat(message) {
        return this.request("coach_chat", { message });
    }
    /**
     * POST action=assign_undo with { id } — id is the TASK id (the `undo_id`
     * coach_chat returns is commit_assignment's task_id). The API deletes the
     * task and answers { ok: true } only while it is not active, the caller is
     * its requester or assignee, and it is at most 30 seconds old; otherwise it
     * answers 200 with { ok: false, message }.
     *
     * Intentionally NOT wired into the register flow: undo_id only exists on
     * legitimate self-assign commits (the stale pending_assign hijack path
     * returns none), so auto-undoing there could only ever delete a task PAUL
     * really created for the caller.
     */
    assignUndo(id) {
        return this.request("assign_undo", { id });
    }
}
