/**
 * HTTP client for the PAUL (iVentas COACH) JSON API.
 *
 * The backend is a single PHP router: `<base>/api.php?action=...`.
 * Auth is a PHP session cookie (name IVCOACH) obtained via `action=login`.
 * Request bodies are JSON (parsed by body_json() in lib/helpers.php);
 * every response is JSON (json_out()).
 */
import { PaulSession, PaulApiError, DEFAULT_TIMEOUT_MS } from "./session.js";
export { PaulApiError } from "./session.js";
export { DEFAULT_TIMEOUT_MS } from "./session.js";
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
        timeoutMs: timeoutFromEnv(env.PAUL_TIMEOUT_MS),
    };
}
/**
 * Reads the optional `PAUL_TIMEOUT_MS` override.
 *
 * Absent, empty, non-numeric or non-positive all fall back to the default:
 * a misconfigured deadline must not be the reason the server refuses to
 * start, and no value can disable the deadline altogether.
 */
function timeoutFromEnv(raw) {
    const parsed = Number(raw?.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
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
    /**
     * The session `uid` was captured on. `-1` means "never captured", which no
     * real session version can equal.
     */
    uidVersion = -1;
    constructor(config, fetchImpl, session) {
        this.config = config;
        this.session = session ?? new PaulSession(fetchImpl, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
        // Recorded AFTER the call, so it names the session this login landed on:
        // `session.fetch` has already captured whatever cookie PAUL handed back.
        this.uidVersion = this.session.sessionVersion();
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
        // The trigger is the MISSING uid, never the missing cookie. All three
        // planes share one IVCOACH cookie, so an admin-panel login leaves
        // `hasCookie()` true while api.php was never authenticated and no uid was
        // ever reported. Keying on the cookie made this return null after an admin
        // login, and paul_register_task then blamed PAUL for "not reporting the
        // uid" — reproduced in production.
        //
        // The second trigger is a CHANGED session. All three planes share one
        // IVCOACH cookie, so an admin login can make PHP regenerate the session
        // id after we cached the uid; the cached value then names an identity the
        // current session no longer holds, and paul_register_task would file the
        // task against the wrong collaborator.
        if (this.uid === null || this.uidVersion !== this.session.sessionVersion()) {
            await this.login();
        }
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
    /**
     * POST action=confirm_notified with { id } — closes a task that is parked
     * waiting for its REQUESTER to state the client was told the work is done.
     * A task created with a "Solicitada por" is NOT closed by its executor: the
     * app leaves it in that waiting state and the requester clears it with the
     * button labelled "✓ YA AVISÉ YO" (admin/tasks.php), which fires exactly
     * this action.
     *
     * NOT verified against production, unlike every other action in this file:
     * reaching that state requires closing a real client task. The shape follows
     * the app's own `api('confirm_notified', { id })` call and matches every
     * other single-id action here.
     */
    confirmNotified(id) {
        return this.request("confirm_notified", { id });
    }
    /** GET action=requests — tasks the user delegated to others. */
    requests() {
        return this.request("requests");
    }
    /* ---------- Peticiones (the team request queue) ---------- */
    /** POST action=req_list with {} — the whole queue, plus the assignable roster. */
    reqList() {
        return this.request("req_list", {});
    }
    /**
     * POST action=req_create — files a request.
     *
     * The server validates `kind` (400 bad_kind) and the title length (400
     * short), but NOT `urgency`: an unknown value is silently stored as `media`,
     * verified in production with "altisima". The caller must therefore close
     * that enum itself, or a request meant to be urgent lands as medium with no
     * error to notice.
     *
     * `money_month`/`months_min` are ignored by the UI when `money_kind` is
     * `otro` — that branch means "no amount, judge it by context" — so this
     * method drops the amount in that case rather than sending a number the
     * board would render as a value it does not have.
     */
    reqCreate(input) {
        const isOther = (input.moneyKind ?? "gana") === "otro";
        return this.request("req_create", {
            kind: input.kind,
            title: input.title,
            detail: input.detail ?? "",
            money_kind: input.moneyKind ?? "gana",
            money_other: isOther ? (input.moneyOther ?? "no_se") : null,
            money_month: isOther ? 0 : (input.moneyMonth ?? 0),
            months_min: input.monthsMin ?? 1,
            urgency: input.urgency ?? "media",
            ...(input.migrateSrc && input.migrateId !== undefined
                ? { migrate_src: input.migrateSrc, migrate_id: input.migrateId }
                : {}),
        });
    }
    /**
     * POST action=req_thread with { id } — the request, its whole comment thread
     * and the roster of people who can be @-mentioned in it. 404 not_found for an
     * id that does not exist. Open to everyone, including accounts whose
     * `can_assign` is false.
     */
    reqThread(id) {
        return this.request("req_thread", { id });
    }
    /**
     * POST action=req_comment with { id, body, mentions } — posts to the thread.
     *
     * `mentions` carries EXACT uids and is what actually rings someone's bell;
     * the `@Name` text in the body is only display. PAUL also tries to resolve
     * names on its own and answers `had_at: true, mentioned: 0` when the body
     * had an `@` that matched nobody (an ambiguous first name like `@Diego`, of
     * which the roster has two) — the comment is still posted.
     */
    reqComment(id, body, mentions = []) {
        return this.request("req_comment", { id, body, mentions });
    }
    /**
     * POST action=req_take with { id } — claim a `nueva` request for yourself.
     * Answers 409 bad_status once somebody else already took it.
     */
    reqTake(id) {
        return this.request("req_take", { id });
    }
    /**
     * POST action=req_assign with { id, person_uid, urgency } — hand a `nueva`
     * request to a teammate. 400 bad_person for a uid outside the roster,
     * 409 bad_status once it is assigned.
     */
    reqAssign(id, personUid, urgency) {
        return this.request("req_assign", {
            id,
            person_uid: personUid,
            urgency,
        });
    }
    /**
     * POST action=req_status with { id, status, reason } — closes a request as
     * `hecha` or discards it as `descartada`. Those are the ONLY two values the
     * server accepts; `nueva` and `asignada` answer 400 bad_status, so a request
     * cannot be reopened this way. No state machine is enforced beyond that: a
     * `hecha` request can still be moved to `descartada`.
     *
     * Discarding does NOT delete the task that `req_take`/`req_assign` created —
     * that task stays on its owner's board and must be removed separately.
     */
    reqStatus(id, status, reason = "") {
        return this.request("req_status", { id, status, reason });
    }
    /* ---------- Notifications (the bell) ---------- */
    /** POST action=notifs_list with {} — mentions and thread activity for this user. */
    notifsList() {
        return this.request("notifs_list", {});
    }
    /** POST action=notifs_seen with {} — marks EVERY notification as read. */
    notifsSeen() {
        return this.request("notifs_seen", {});
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
