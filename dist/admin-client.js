import { PaulApiError } from "./session.js";
import { isAdminLoginPage, parseAdminTasks } from "./admin-parse.js";
/** The admin pages that exist, as of build 2026.08.06-1. */
export const ADMIN_PAGES = [
    "hoy",
    "index",
    "people",
    "forecast",
    "commitments",
    "summary",
    "pulse",
    "redflags",
    "tasks",
    "checkpoints",
    "queue",
    "delays",
    "kicked",
    "persona",
    "clients",
    "findings",
    "rescate",
    "objectives",
    "context",
    "knowledge",
    "radar",
    "history",
    "usage",
    "settings",
];
/** Pages that show every collaborator in a single request — no `?u=` needed. */
export const TEAM_WIDE_PAGES = [
    "redflags",
    "delays",
    "kicked",
    "pulse",
    "forecast",
    "commitments",
    "history",
];
export class PaulAdminError extends Error {
    constructor(message) {
        super(message);
        this.name = "PaulAdminError";
    }
}
/** `?u=<uid>` when the collaborator is known, nothing at all when it is not. */
function boardParams(userUid) {
    return userUid ? { u: userUid } : undefined;
}
export class PaulAdminClient {
    config;
    session;
    loggedIn = false;
    /**
     * A legitimate page name: the bare file name of an `admin/*.php` script.
     * Anything else — a slash, a dot, a `?` — would let a caller-supplied string
     * escape the panel's directory or smuggle its own query string.
     */
    static PAGE_NAME = /^[A-Za-z0-9_-]+$/;
    constructor(config, session) {
        this.config = config;
        this.session = session;
    }
    url(page, params) {
        if (!PaulAdminClient.PAGE_NAME.test(page)) {
            throw new PaulAdminError(`"${page}" is not an admin page name. A page name is the bare file name ` +
                "without the `.php` extension and without a query string (letters, " +
                "digits, `_` and `-` only); anything else would build a URL outside the " +
                "panel's /admin/ directory. Pass the query string as `params` instead.");
        }
        const base = `${this.config.url}/admin/${page}.php`;
        if (!params)
            return base;
        const qs = Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&");
        return qs ? `${base}?${qs}` : base;
    }
    /**
     * Encodes a form body exactly as a browser would. URLSearchParams is used
     * rather than encodeURIComponent because the two differ on spaces (`+` vs
     * `%20`) and the panel's forms are the contract we are imitating.
     *
     * `false` is dropped rather than sent: an unchecked HTML checkbox submits no
     * field at all, and PAUL reads presence, not value.
     */
    static encodeForm(fields) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(fields)) {
            if (value === false || value === undefined || value === null)
                continue;
            params.append(key, value === true ? "1" : String(value));
        }
        return params.toString();
    }
    /**
     * Logs into the admin panel. Success is a 302 redirect; a 200 carrying the
     * login form again means the credentials are fine for the app but the
     * account has no administrator role.
     *
     * The panel is behind an edge filter that answers 403 to requests without a
     * browser User-Agent — PaulSession sets one for every request.
     */
    async login() {
        const res = await this.session.fetch(this.url("hoy"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: PaulAdminClient.encodeForm({
                _form: "login",
                email: this.config.email,
                password: this.config.password,
            }),
        });
        if (res.status === 302) {
            this.loggedIn = true;
            return;
        }
        if (res.status === 403) {
            throw new PaulAdminError("PAUL's admin panel refused the request (403). This is the edge filter, " +
                "not PAUL: the request needs a browser User-Agent.");
        }
        const html = await res.text().catch(() => "");
        if (res.status === 200 && isAdminLoginPage(html)) {
            throw new PaulAdminError(`PAUL rejected the admin login for ${this.config.email}. The panel only ` +
                "admits accounts flagged as administrator; the JSON API cannot report " +
                "that flag, so this is the only way to find out.");
        }
        if (res.status === 200) {
            // Already authenticated: the panel answered with a real page.
            this.loggedIn = true;
            return;
        }
        throw new PaulAdminError(`Unexpected admin login response (${res.status}).`);
    }
    /** True when this account can reach the admin panel. Never throws. */
    async isAdmin() {
        try {
            await this.login();
            return true;
        }
        catch {
            return false;
        }
    }
    /** GETs an admin page and returns its raw HTML, logging in if needed. */
    async page(page, params) {
        // Built first so an invalid page name is refused before any network call.
        const target = this.url(page, params);
        if (!this.loggedIn)
            await this.login();
        let html = await this.fetchText(target);
        if (isAdminLoginPage(html)) {
            this.loggedIn = false;
            await this.login();
            html = await this.fetchText(target);
            if (isAdminLoginPage(html)) {
                throw new PaulAdminError(`Could not stay authenticated for admin/${page}.php.`);
            }
        }
        return html;
    }
    /**
     * POSTs a form to an admin page and returns the resulting HTML. `fields`
     * must carry whatever discriminator the page expects — usually `_form`, but
     * findings.php, objectives.php and hoy.php key off a bare field name
     * instead.
     *
     * `params` matters more than it looks: the panel's forms carry no `action`
     * attribute, so a browser posts them to the CURRENT url INCLUDING its query
     * string. Posting to `tasks.php` with no `?u=` makes the panel apply and
     * re-render the board of whichever collaborator it defaults to, not the one
     * the caller meant.
     */
    async submit(page, fields, params) {
        // Built first so an invalid page name is refused before any network call.
        const target = this.url(page, params);
        if (!this.loggedIn)
            await this.login();
        const res = await this.session.fetch(target, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: PaulAdminClient.encodeForm(fields),
        });
        // A mutation that redirects is the panel's post/redirect/get; follow it —
        // with the SAME query string, or the panel re-renders somebody else's page.
        if (res.status === 302)
            return this.page(page, params);
        const html = await res.text().catch(() => "");
        if (isAdminLoginPage(html)) {
            this.loggedIn = false;
            throw new PaulAdminError(`The admin session expired while submitting to admin/${page}.php; nothing was changed.`);
        }
        if (!res.ok) {
            throw new PaulAdminError(`admin/${page}.php answered ${res.status} to the form POST.`);
        }
        return html;
    }
    /**
     * GETs a url and returns its body.
     *
     * `allowRedirect` is only for the endpoints whose SUCCESS is a redirect —
     * view_as, view_self and logout, which have no page of their own. For a real
     * page a 302 is never a valid answer: returning its empty body would hand the
     * caller a document with no tasks, no tables and no error, which reads
     * exactly like a collaborator who has nothing pending.
     */
    async fetchText(url, allowRedirect = false) {
        const res = await this.session.fetch(url);
        if (res.status === 302) {
            if (allowRedirect)
                return "";
            throw new PaulAdminError(`PAUL's admin panel redirected (302 → ${res.headers.get("location") ?? "unknown"}) ` +
                `instead of serving ${url}. That is not an empty page: the request was ` +
                "bounced, usually because the admin session is no longer valid.");
        }
        if (!res.ok) {
            throw new PaulApiError(`PAUL admin GET failed (${res.status}) for ${url}`, res.status, null);
        }
        return res.text();
    }
    /* ---------- Read-only impersonation ---------- */
    /**
     * Enters the read-only admin view of `uid`. While it is active the JSON API
     * returns THAT person's data and refuses every write with `read_only` —
     * `action=login` included, which answers 403. Prefer `withViewAs`, which
     * cannot leak the mode.
     */
    async viewAs(uid) {
        if (!this.loggedIn)
            await this.login();
        await this.fetchText(this.url("view_as", { uid }), true);
    }
    /** Leaves the read-only view and restores the admin's own write access. */
    async viewSelf() {
        await this.fetchText(this.url("view_self"), true);
    }
    /**
     * Runs `fn` while impersonating `uid`, and leaves the view no matter what.
     *
     * Leaving the view is the point of this method: a session left inside a
     * `view_as` cannot write anything and cannot even log in again, so an early
     * return or a thrown error inside `fn` would otherwise brick the session for
     * the rest of the process.
     *
     * This is deliberately NOT a `finally`. A `finally` that awaits lets a
     * failure from the cleanup REPLACE the failure from `fn`, and the caller is
     * then told about a redirect when the real news was that their read blew up.
     * So: `fn`'s error always wins, the exit is always attempted, and a failed
     * exit only surfaces when there is no other error to report.
     */
    async withViewAs(uid, fn) {
        await this.viewAs(uid);
        let value;
        try {
            value = await fn();
        }
        catch (err) {
            await this.viewSelf().catch(() => undefined);
            throw err;
        }
        // Nothing failed inside, so a failure to leave the view IS the news: the
        // session is still read-only and every later write would be refused.
        await this.viewSelf();
        return value;
    }
    /* ---------- Task board (admin/tasks.php, scoped by ?u=<uid>) ---------- */
    /** GETs one collaborator's mission board. */
    tasksPage(uid) {
        return this.page("tasks", { u: uid });
    }
    /**
     * Creates a task FOR `userUid`. The assignee is the hidden `user_uid` field;
     * `requesterUid` is who ASKED for it, which is a different thing.
     */
    addTask(input) {
        return this.submit("tasks", {
            _form: "add_task",
            user_uid: input.userUid,
            title: input.title,
            type: input.type ?? "",
            est_min: input.estMin ?? 60,
            priority: input.priority ?? 2,
            weeks: input.weeks ?? 0,
            context: input.context ?? "",
            requester_uid: input.requesterUid ?? "",
            client_name: input.clientName ?? "",
        }, { u: input.userUid });
    }
    /**
     * Deletes any task, for any collaborator. `userUid` does not pick the task —
     * the id does — but it scopes the page the panel re-renders afterwards, so
     * passing it makes the returned board the assignee's instead of a stranger's.
     */
    deleteTask(id, userUid) {
        return this.submit("tasks", { _form: "delete_task", id }, boardParams(userUid));
    }
    /** Marks a task complete without a checkpoint (the admin's manual close). */
    completeTask(id, userUid) {
        return this.submit("tasks", { _form: "complete_task", id }, boardParams(userUid));
    }
    /**
     * Edits a task in place, MERGING with what is stored.
     *
     * The panel's edit form posts all six fields at once and the server writes
     * every one of them, so a partial POST silently overwrites the rest with
     * whatever the client happened to default to — measured in production: a
     * title-only edit turned `asignada / 45 min / alta / "CTX-PRUEBA"` into
     * `general / 60 min / media / ""`. To avoid that, the stored row is read back
     * first and every field the caller omitted is re-sent unchanged.
     *
     * `userUid` is required because the edit form lives on `tasks.php?u=<uid>`
     * and there is no other way to reach the row. It also makes the refusal below
     * possible: an id that is not on that board would otherwise be POSTed blind.
     *
     * The panel exposes no assignee and no status field here, so neither can be
     * changed this way. It exposes no client dossier fields either — those are
     * edited by the collaborator in PAUL's own UI, not from the panel.
     */
    async updateTask(input) {
        const current = parseAdminTasks(await this.tasksPage(input.userUid)).find((task) => task.id === input.id);
        if (!current) {
            throw new PaulAdminError(`Task ${input.id} is not on ${input.userUid}'s board, so NOTHING WAS CHANGED. ` +
                "The panel's edit form only reaches the tasks of the collaborator the page " +
                "is scoped to, so `userUid` is most likely the wrong person — read the id " +
                "and its owner back from the board (paul_admin_tasks) and retry.");
        }
        return this.submit("tasks", {
            _form: "update_task",
            id: input.id,
            // `??`, never `||`: an explicit "" is the caller clearing the field.
            title: input.title ?? current.title,
            type: input.type ?? current.type ?? "",
            est_min: input.estMin ?? current.estMin ?? 60,
            priority: input.priority ?? current.priority ?? 2,
            context: input.context ?? current.context ?? "",
        }, { u: input.userUid });
    }
    /* ---------- People (admin/people.php) ---------- */
    peoplePage() {
        return this.page("people");
    }
    createUser(input) {
        return this.submit("people", {
            _form: "create_user",
            uid: input.uid,
            name: input.name,
            email: input.email ?? "",
            pass: input.pass ?? "",
            role: input.role ?? "",
            department_id: input.departmentId ?? "",
            work_context: input.workContext ?? "",
            aliases: input.aliases ?? "",
            ...(input.isAdmin ? { is_admin: "1" } : {}),
            ...(input.showClientBar ? { show_client_bar: "1" } : {}),
        });
    }
    /**
     * Deletes a collaborator. The panel renders no delete form for
     * administrators, so this will not remove one.
     */
    deleteUser(uid) {
        return this.submit("people", { _form: "delete_user", uid });
    }
    /** Issues a fresh password for a collaborator. */
    resetPassword(uid) {
        return this.submit("people", { _form: "reset_pin", uid });
    }
    /* ---------- Knowledge base (admin/knowledge.php) ---------- */
    /** Teaches PAUL something durable. `userUid` empty = company-wide knowledge. */
    addKnowledge(text, userUid = "") {
        return this.submit("knowledge", { _form: "add", user_uid: userUid, text });
    }
    /** Makes PAUL forget one knowledge entry. */
    deleteKnowledge(id) {
        return this.submit("knowledge", { _form: "delete", id });
    }
    /* ---------- Natural-language read over the whole dataset ---------- */
    /**
     * The panel's own copilot (`hoy.php?ajax=ask`), the only JSON endpoint in
     * the admin area that answers free-form questions across every table.
     * Costs AI budget on each call.
     */
    async ask(question, history = []) {
        if (!this.loggedIn)
            await this.login();
        const body = new URLSearchParams({
            q: question,
            hist: JSON.stringify(history.slice(-3)),
        });
        const res = await this.session.fetch(this.url("hoy", { ajax: "ask" }), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        // Read the body ONCE, as text: a dead session answers with the login FORM,
        // and blind JSON parsing turns that into the misleading "returned no
        // answer" instead of "log in again".
        const raw = await res.text().catch(() => "");
        if (isAdminLoginPage(raw)) {
            this.loggedIn = false;
            throw new PaulAdminError("The admin session expired: PAUL's copilot answered with the login form " +
                "instead of an answer. Nothing was asked; retry to log in again.");
        }
        if (!res.ok) {
            throw new PaulAdminError(`PAUL's copilot answered ${res.status} to the question.`);
        }
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            parsed = null;
        }
        if (!parsed?.answer) {
            throw new PaulAdminError(parsed?.error ?? "PAUL's copilot returned no answer.");
        }
        return parsed.answer;
    }
}
