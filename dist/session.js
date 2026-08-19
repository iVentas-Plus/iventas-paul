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
export class PaulSession {
    fetchImpl;
    cookie = null;
    constructor(fetchImpl = (...args) => globalThis.fetch(...args)) {
        this.fetchImpl = fetchImpl;
    }
    /** True once any plane has authenticated and handed us a session cookie. */
    hasCookie() {
        return this.cookie !== null;
    }
    /** Drops the session cookie, forcing the next call to re-authenticate. */
    clear() {
        this.cookie = null;
    }
    /**
     * Performs the request with the session cookie attached, and captures any
     * Set-Cookie the response carries. Redirects are NOT followed: the admin
     * plane signals success with a 302 whose body is empty, so following it
     * would discard the only signal we have.
     */
    async fetch(url, init = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            ...(init.headers ?? {}),
        };
        if (this.cookie)
            headers["Cookie"] = this.cookie;
        const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
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
        if (session)
            this.cookie = session.split(";")[0];
    }
}
