/**
 * Client for PAUL's admin panel (`<base>/admin/*.php`).
 *
 * The panel is a different world from the JSON API: server-rendered PHP, its
 * own login, mutations as form POSTs discriminated by a hidden `_form` field,
 * and no CSRF token. It shares the IVCOACH cookie with the JSON API but NOT
 * its authentication — each plane must be logged into separately, and both
 * can be active on the same session at once.
 */
import type { PaulConfig } from "./client.js";
import { PaulSession, PaulApiError } from "./session.js";
import { isAdminLoginPage } from "./admin-parse.js";

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
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number];

/** Pages that show every collaborator in a single request — no `?u=` needed. */
export const TEAM_WIDE_PAGES = [
  "redflags",
  "delays",
  "kicked",
  "pulse",
  "forecast",
  "commitments",
  "history",
] as const;

export class PaulAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaulAdminError";
  }
}

export class PaulAdminClient {
  private loggedIn = false;

  constructor(
    private readonly config: PaulConfig,
    private readonly session: PaulSession,
  ) {}

  private url(page: string, params?: Record<string, string | number>): string {
    const base = `${this.config.url}/admin/${page}.php`;
    if (!params) return base;
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
  private static encodeForm(fields: Record<string, string | number | boolean>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === false || value === undefined || value === null) continue;
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
  async login(): Promise<void> {
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
      throw new PaulAdminError(
        "PAUL's admin panel refused the request (403). This is the edge filter, " +
          "not PAUL: the request needs a browser User-Agent.",
      );
    }
    const html = await res.text().catch(() => "");
    if (res.status === 200 && isAdminLoginPage(html)) {
      throw new PaulAdminError(
        `PAUL rejected the admin login for ${this.config.email}. The panel only ` +
          "admits accounts flagged as administrator; the JSON API cannot report " +
          "that flag, so this is the only way to find out.",
      );
    }
    if (res.status === 200) {
      // Already authenticated: the panel answered with a real page.
      this.loggedIn = true;
      return;
    }
    throw new PaulAdminError(`Unexpected admin login response (${res.status}).`);
  }

  /** True when this account can reach the admin panel. Never throws. */
  async isAdmin(): Promise<boolean> {
    try {
      await this.login();
      return true;
    } catch {
      return false;
    }
  }

  /** GETs an admin page and returns its raw HTML, logging in if needed. */
  async page(page: string, params?: Record<string, string | number>): Promise<string> {
    if (!this.loggedIn) await this.login();
    let html = await this.fetchText(this.url(page, params));
    if (isAdminLoginPage(html)) {
      this.loggedIn = false;
      await this.login();
      html = await this.fetchText(this.url(page, params));
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
   */
  async submit(
    page: string,
    fields: Record<string, string | number | boolean>,
  ): Promise<string> {
    if (!this.loggedIn) await this.login();
    const res = await this.session.fetch(this.url(page), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: PaulAdminClient.encodeForm(fields),
    });
    // A mutation that redirects is the panel's post/redirect/get; follow it.
    if (res.status === 302) return this.page(page);
    const html = await res.text().catch(() => "");
    if (isAdminLoginPage(html)) {
      this.loggedIn = false;
      throw new PaulAdminError(
        `The admin session expired while submitting to admin/${page}.php; nothing was changed.`,
      );
    }
    if (!res.ok) {
      throw new PaulAdminError(`admin/${page}.php answered ${res.status} to the form POST.`);
    }
    return html;
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.session.fetch(url);
    if (res.status === 302) {
      // view_as / view_self redirect out of the panel; treat as empty body.
      return "";
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
  async viewAs(uid: string): Promise<void> {
    if (!this.loggedIn) await this.login();
    await this.session.fetch(this.url("view_as", { uid }));
  }

  /** Leaves the read-only view and restores the admin's own write access. */
  async viewSelf(): Promise<void> {
    await this.session.fetch(this.url("view_self"));
  }

  /**
   * Runs `fn` while impersonating `uid`, and leaves the view no matter what.
   *
   * The `finally` is the point of this method: a session left inside a
   * `view_as` cannot write anything and cannot even log in again, so an early
   * return or a thrown error inside `fn` would otherwise brick the session for
   * the rest of the process.
   */
  async withViewAs<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    await this.viewAs(uid);
    try {
      return await fn();
    } finally {
      await this.viewSelf();
    }
  }

  /* ---------- Task board (admin/tasks.php, scoped by ?u=<uid>) ---------- */

  /** GETs one collaborator's mission board. */
  tasksPage(uid: string): Promise<string> {
    return this.page("tasks", { u: uid });
  }

  /**
   * Creates a task FOR `userUid`. The assignee is the hidden `user_uid` field;
   * `requesterUid` is who ASKED for it, which is a different thing.
   */
  addTask(input: {
    userUid: string;
    title: string;
    type?: string;
    estMin?: number;
    /** 1 = alta, 2 = media, 3 = baja. */
    priority?: 1 | 2 | 3;
    /** 0 = this week, 1..4 = that many weeks ahead. */
    weeks?: 0 | 1 | 2 | 3 | 4;
    context?: string;
    requesterUid?: string;
    clientName?: string;
  }): Promise<string> {
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
    });
  }

  /** Deletes any task, for any collaborator. */
  deleteTask(id: number): Promise<string> {
    return this.submit("tasks", { _form: "delete_task", id });
  }

  /** Marks a task complete without a checkpoint (the admin's manual close). */
  completeTask(id: number): Promise<string> {
    return this.submit("tasks", { _form: "complete_task", id });
  }

  /**
   * Edits a task in place. The panel exposes no assignee and no status field
   * here, so neither can be changed this way.
   */
  updateTask(input: {
    id: number;
    title: string;
    type?: string;
    estMin?: number;
    priority?: 1 | 2 | 3;
    context?: string;
    clientContext?: string;
    clientKpis?: string;
  }): Promise<string> {
    const fields: Record<string, string | number> = {
      _form: "update_task",
      id: input.id,
      title: input.title,
      type: input.type ?? "",
      est_min: input.estMin ?? 60,
      priority: input.priority ?? 2,
      context: input.context ?? "",
    };
    if (input.clientContext !== undefined) fields.client_context = input.clientContext;
    if (input.clientKpis !== undefined) fields.client_kpis = input.clientKpis;
    return this.submit("tasks", fields);
  }

  /* ---------- People (admin/people.php) ---------- */

  peoplePage(): Promise<string> {
    return this.page("people");
  }

  createUser(input: {
    uid: string;
    name: string;
    email?: string;
    pass?: string;
    role?: string;
    departmentId?: string | number;
    workContext?: string;
    aliases?: string;
    isAdmin?: boolean;
    showClientBar?: boolean;
  }): Promise<string> {
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
  deleteUser(uid: string): Promise<string> {
    return this.submit("people", { _form: "delete_user", uid });
  }

  /** Issues a fresh password for a collaborator. */
  resetPassword(uid: string): Promise<string> {
    return this.submit("people", { _form: "reset_pin", uid });
  }

  /* ---------- Knowledge base (admin/knowledge.php) ---------- */

  /** Teaches PAUL something durable. `userUid` empty = company-wide knowledge. */
  addKnowledge(text: string, userUid = ""): Promise<string> {
    return this.submit("knowledge", { _form: "add", user_uid: userUid, text });
  }

  /** Makes PAUL forget one knowledge entry. */
  deleteKnowledge(id: number): Promise<string> {
    return this.submit("knowledge", { _form: "delete", id });
  }

  /* ---------- Natural-language read over the whole dataset ---------- */

  /**
   * The panel's own copilot (`hoy.php?ajax=ask`), the only JSON endpoint in
   * the admin area that answers free-form questions across every table.
   * Costs AI budget on each call.
   */
  async ask(question: string, history: Array<{ q: string; a: string }> = []): Promise<string> {
    if (!this.loggedIn) await this.login();
    const body = new URLSearchParams({
      q: question,
      hist: JSON.stringify(history.slice(-3)),
    });
    const res = await this.session.fetch(this.url("hoy", { ajax: "ask" }), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const parsed = (await res.json().catch(() => null)) as
      | { answer?: string; error?: string }
      | null;
    if (!parsed?.answer) {
      throw new PaulAdminError(parsed?.error ?? "PAUL's copilot returned no answer.");
    }
    return parsed.answer;
  }
}
