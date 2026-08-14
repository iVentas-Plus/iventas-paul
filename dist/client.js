/**
 * HTTP client for the PAUL (iVentas COACH) JSON API.
 *
 * The backend is a single PHP router: `<base>/api.php?action=...`.
 * Auth is a PHP session cookie (name IVCOACH) obtained via `action=login`.
 * Request bodies are JSON (parsed by body_json() in lib/helpers.php);
 * every response is JSON (json_out()).
 */
import { PaulSession, PaulApiError } from "./session.js";
export { PaulApiError } from "./session.js";
/** Reads and validates configuration from environment variables. */
export function configFromEnv(env = process.env) {
    const missing = [];
    if (!env.PAUL_URL)
        missing.push("PAUL_URL");
    if (!env.PAUL_EMAIL)
        missing.push("PAUL_EMAIL");
    if (!env.PAUL_PASSWORD)
        missing.push("PAUL_PASSWORD");
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}. ` +
            "Set PAUL_URL (base URL of the PAUL app up to its folder, e.g. " +
            "https://example.com/iventas-coach), PAUL_EMAIL and PAUL_PASSWORD " +
            "(the collaborator's login credentials).");
    }
    return {
        url: env.PAUL_URL.replace(/\/+$/, ""),
        email: env.PAUL_EMAIL,
        password: env.PAUL_PASSWORD,
    };
}
/**
 * The red-gate answer key. The real UI sends the literal string `mejora` as
 * the question id (app index.html, red_gate_ack call) and treats the fetched
 * question purely as display text — so the server matches on this key, not on
 * the Spanish sentence.
 */
export const RED_GATE_QUESTION_KEY = "mejora";
/**
 * Fallback wording of the single red-gate question, used only for display
 * when `red_gate_questions` cannot be reached. The server hardcodes the same
 * sentence in lib/ai.php.
 */
export const RED_GATE_QUESTION = "¿Qué vas a hacer para que esto no vuelva a pasar?";
/* ---------- Client ---------- */
export class PaulClient {
    config;
    session;
    /** uid of the authenticated collaborator, learned from the login response. */
    uid = null;
    constructor(config, fetchImpl, session) {
        this.config = config;
        this.session = session ?? new PaulSession(fetchImpl);
    }
    /** Base URL of the PAUL installation, without a trailing slash. */
    get baseUrl() {
        return this.config.url;
    }
    endpoint(action, params) {
        const url = `${this.config.url}/api.php?action=${encodeURIComponent(action)}`;
        if (!params)
            return url;
        const extra = Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&");
        return extra ? `${url}&${extra}` : url;
    }
    /** Authenticates the JSON API plane and captures the IVCOACH session cookie. */
    async login() {
        const res = await this.session.fetch(this.endpoint("login"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: this.config.email, password: this.config.password }),
        });
        const body = (await res.json().catch(() => null));
        if (body?.user?.uid)
            this.uid = body.user.uid;
        if (!res.ok || !body?.ok) {
            // A 403 here almost always means the session is stuck in an admin
            // read-only view, where even logging in is refused.
            const hint = res.status === 403
                ? " (the session may be in an admin read-only view — call adminViewSelf() to leave it)"
                : "";
            throw new PaulApiError(`PAUL login failed (${res.status}): ${body?.message ?? body?.error ?? "unexpected response"}${hint}`, res.status, body);
        }
    }
    /**
     * Low-level call to api.php. GET when no body is given, POST with a JSON
     * body otherwise. Logs in lazily on first use; on a 401 / no_auth response
     * it re-logins once and retries the request once.
     */
    async request(action, body, params) {
        if (!this.session.hasCookie())
            await this.login();
        let attempt = await this.doFetch(action, body, params);
        if (attempt.noAuth) {
            await this.login();
            attempt = await this.doFetch(action, body, params);
        }
        const { res, parsed } = attempt;
        if (!res.ok) {
            const b = parsed;
            throw new PaulApiError(`PAUL API error on action=${action} (${res.status}): ${b?.message ?? b?.error ?? "unexpected response"}`, res.status, parsed);
        }
        return parsed;
    }
    async doFetch(action, body, params) {
        const headers = {};
        let init = { method: "GET", headers };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
            init = { method: "POST", headers, body: JSON.stringify(body) };
        }
        const res = await this.session.fetch(this.endpoint(action, params), init);
        const parsed = (await res.json().catch(() => null));
        const noAuth = res.status === 401 || parsed?.error === "no_auth";
        return { res, parsed, noAuth };
    }
    /* ---------- Typed wrappers over api.php actions ---------- */
    /**
     * The authenticated collaborator's own uid, logging in if needed.
     *
     * It comes from the login response, NOT from `state` — `state.user` carries
     * only name and role. That matters: `state` has server-side side effects
     * (coach nudges), so it must never be called merely to learn who we are.
     */
    async currentUid() {
        if (!this.session.hasCookie())
            await this.login();
        return this.uid;
    }
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
    /** POST action=red_gate_questions with { flag_id } — the question and its minimum length. */
    redGateQuestions(flagId) {
        return this.request("red_gate_questions", {
            flag_id: flagId,
        });
    }
    /**
     * POST action=red_gate_ack with { flag_id, qa, plan } — resolves a
     * team-visible red flag from a checkpoint verdict. The gate has exactly one
     * question, keyed server-side by the literal string `mejora`; the AI
     * evaluates the plan's seriousness and may answer
     * { ok: true, approved: false } asking for a more concrete plan.
     */
    redGateAck(flagId, plan) {
        return this.request("red_gate_ack", {
            flag_id: flagId,
            qa: [{ q: RED_GATE_QUESTION_KEY, a: plan }],
            plan,
        });
    }
    /** POST action=coach_chat with { message }. */
    coachChat(message) {
        return this.request("coach_chat", { message });
    }
    /* ---------- Assignment ---------- */
    /** GET action=peer_contacts — the roster, and the only source of valid uids. */
    peerContacts() {
        return this.request("peer_contacts");
    }
    /**
     * POST action=peer_assign — creates a task for `person_uid` in ONE call.
     * Verified against production as working "cold": it needs no prior chat and
     * no server-side pending assignment. It does NOT return the new task id.
     */
    peerAssign(input) {
        return this.request("peer_assign", {
            title: input.title,
            person_uid: input.personUid,
            est_min: input.estMin,
            urgency: input.urgency,
        });
    }
    /**
     * POST action=assign_confirm — the richer direct create. Also verified to
     * work cold. Preferred over peer_assign because the response carries
     * `undo_id`, which IS the new task's id.
     */
    assignConfirm(input) {
        return this.request("assign_confirm", {
            person_uid: input.personUid,
            title: input.title,
            urgency: input.urgency,
            est_min: input.estMin ?? 60,
            client: input.client ?? "",
            reason: input.reason ?? "",
            suggested_uid: input.suggestedUid ?? input.personUid,
        });
    }
    /**
     * POST action=assign_undo with { id } — id is the TASK id. The API deletes
     * the task and answers { ok: true } only while it is not active, the caller
     * is its requester or assignee, and it is within the server's undo window;
     * otherwise it answers 200 with { ok: false, message }.
     */
    assignUndo(id) {
        return this.request("assign_undo", { id });
    }
    /**
     * POST action=task_reassign with { id, to, reason } — hands an EXISTING
     * task to another uid. The UI offers it only on tasks PAUL itself assigned
     * (`byPaul`), and the server notifies the admins with the reason.
     */
    taskReassign(id, to, reason) {
        return this.request("task_reassign", { id, to, reason });
    }
    /**
     * POST action=bounce_task with { id } — returns a task to whoever requested
     * it ("this isn't mine"). Takes no target: the requester is implicit.
     */
    bounceTask(id) {
        return this.request("bounce_task", { id });
    }
    /**
     * POST action=delete_task with { id }. When the autopilot is off the server
     * queues the deletion for admin approval instead of performing it, so check
     * `deleted` rather than assuming `ok` means gone.
     */
    deleteTask(id) {
        return this.request("delete_task", { id });
    }
    /* ---------- Task clock ---------- */
    /** POST action=wait_task with { id } — sends to review; the clock stops. */
    waitTask(id) {
        return this.request("wait_task", { id });
    }
    /** POST action=pause_task with { id } — freezes the clock and frees a parallel slot. */
    pauseTask(id) {
        return this.request("pause_task", { id });
    }
    /** POST action=push_week with { id, reason } — moves a task to next week. */
    pushWeek(id, reason) {
        return this.request("push_week", { id, reason });
    }
    /** POST action=pull_week with { id } — pulls a future task into this week. */
    pullWeek(id) {
        return this.request("pull_week", { id });
    }
    /** GET action=requests — tasks the user delegated to others. */
    requests() {
        return this.request("requests");
    }
    /* ---------- Bugs ---------- */
    /** POST action=bugs_list with {} — every team bug, plus the assignable roster. */
    bugsList() {
        return this.request("bugs_list", {});
    }
    /**
     * POST action=bug_create with { title, desc, images }. The server
     * de-duplicates: an equivalent report is merged into an existing bug as a
     * note and comes back with `grouped: true`.
     */
    bugCreate(title, desc, images = []) {
        return this.request("bug_create", { title, desc, images });
    }
    /** POST action=bug_assign with { bug_id, person_uid, urgency }. */
    bugAssign(bugId, personUid, urgency) {
        return this.request("bug_assign", {
            bug_id: bugId,
            person_uid: personUid,
            urgency,
        });
    }
    /* ---------- Ideas ---------- */
    /** POST action=ideas_list with {} — the upvote board of ideas to improve PAUL. */
    ideasList() {
        return this.request("ideas_list", {});
    }
    /** POST action=idea_create with { text }. The server returns no useful body. */
    ideaCreate(text) {
        return this.request("idea_create", { text });
    }
    /** POST action=idea_vote with { id }. */
    ideaVote(id) {
        return this.request("idea_vote", { id });
    }
    /* ---------- Tips (PAUL emits these; they are not user-authored) ---------- */
    /** POST action=paul_tips with {} — freshly generated daily coaching tips. */
    paulTips() {
        return this.request("paul_tips", {});
    }
    /** GET action=tips&id=<taskId> — perspective hints for one task. */
    taskTips(taskId) {
        return this.request("tips", undefined, { id: taskId });
    }
}
