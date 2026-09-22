/**
 * Cookie-bearing HTTP session shared by every PAUL plane.
 *
 * PAUL is one PHP app with a single session cookie (IVCOACH) but THREE
 * independent authentication planes that coexist on it:
 *
 *   1. Collaborator JSON API — `api.php?action=login`. Grants writes as yourself.
 *   2. Admin panel — form POST `_form=login` on any `admin/*.php`. Grants the
 *      panel; does NOT authenticate api.php (that answers `no_auth`).
 *   3. Read-only impersonation — `admin/view_as.php?uid=X`. Makes api.php return
 *      X's data and rejects EVERY write with `read_only` — including
 *      `action=login`, which answers 403. `admin/view_self.php` is the only exit.
 *
 * Because all three ride the same cookie, they must share one jar; that is the
 * whole reason this class exists.
 */
/** Error carrying the HTTP status and the parsed body from a PAUL response. */
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
 * PAUL's edge (nginx/Plesk) answers 403 to requests without a browser-like
 * User-Agent — the admin form login is rejected outright without it. Verified
 * against production: the same POST returns 302 with this header and 403
 * without it.
 */
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/**
 * How long a single PAUL request may take before it is aborted.
 *
 * This is not a performance knob. The MCP server is one stdio process: a
 * promise that never settles hangs the tool that called it with no error to
 * report and no way for the agent to recover. PAUL's slowest observed calls
 * are the AI-backed ones (checkpoint questions, the copilot), which answer in
 * seconds, so 30 s leaves a wide margin while still bounding the failure.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Normalizes the three shapes `RequestInit.headers` accepts into entries.
 *
 * Casting it to `Record<string, string>` and spreading it — as this used to —
 * is only correct for a plain object. A `Headers` instance and an array of
 * tuples both spread to nothing, so the caller's `Content-Type` vanished and
 * PAUL received a body it would not parse. The public signature promises all
 * three, so all three are supported.
 */
function headerEntries(headers) {
    if (!headers)
        return [];
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
        return Array.from(headers.entries());
    }
    if (Array.isArray(headers))
        return headers.map(([name, value]) => [name, value]);
    return Object.entries(headers);
}
export class PaulSession {
    fetchImpl;
    timeoutMs;
    cookie = null;
    /**
     * Bumped every time a DIFFERENT IVCOACH cookie takes over. Anything cached
     * from a session — the collaborator's uid, above all — is only valid while
     * this number is unchanged.
     */
    version = 0;
    constructor(fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    /** True once any plane has authenticated and handed us a session cookie. */
    hasCookie() {
        return this.cookie !== null;
    }
    /**
     * Identifies the PHP session currently in the jar. It changes when PAUL
     * hands back a different IVCOACH cookie — which is what happens when
     * another plane logs in and PHP regenerates the session id.
     */
    sessionVersion() {
        return this.version;
    }
    /** Drops the session cookie, forcing the next call to re-authenticate. */
    clear() {
        if (this.cookie === null)
            return;
        this.cookie = null;
        this.version += 1;
    }
    /**
     * Performs the request with the session cookie attached, and captures any
     * Set-Cookie the response carries. Redirects are NOT followed: the admin
     * plane signals success with a 302 whose body is empty, so following it
     * would discard the only signal we have.
     *
     * Every request carries a deadline unless the caller brought its own signal.
     */
    async fetch(url, init = {}) {
        const headers = { "User-Agent": USER_AGENT };
        for (const [name, value] of headerEntries(init.headers))
            headers[name] = value;
        if (this.cookie)
            headers["Cookie"] = this.cookie;
        const res = await this.fetchImpl(url, {
            ...init,
            headers,
            redirect: "manual",
            signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
        });
        this.captureCookie(res);
        return res;
    }
    /**
     * Extracts the IVCOACH cookie from a response, if it set one.
     *
     * ONLY a cookie literally named IVCOACH is accepted, and a response that
     * carries none leaves the current cookie untouched. This install sits behind
     * nginx/Plesk, which sets cookies of its own; falling back to the first
     * Set-Cookie (as this used to) let any edge/WAF cookie silently replace the
     * whole PAUL session with one that authenticates nothing.
     *
     * The deliberate consequence: if PAUL ever renames its session cookie, this
     * captures nothing and every call fails loudly with `no_auth` — which is the
     * intended outcome. A renamed session cookie must break visibly, never be
     * swapped in silently.
     */
    captureCookie(res) {
        const setCookies = typeof res.headers.getSetCookie === "function"
            ? res.headers.getSetCookie()
            : res.headers.get("set-cookie")
                ? [res.headers.get("set-cookie")]
                : [];
        const session = setCookies.find((c) => c.startsWith("IVCOACH="));
        if (!session)
            return;
        const next = session.split(";")[0];
        // PAUL re-sends the same cookie on ordinary responses; only a genuinely
        // different value means a new PHP session, and only that invalidates what
        // callers cached from the old one.
        if (next === this.cookie)
            return;
        this.cookie = next;
        this.version += 1;
    }
}
