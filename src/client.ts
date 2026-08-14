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

export interface PaulConfig {
  /** Base URL up to the app folder, e.g. https://example.com/iventas-coach */
  url: string;
  email: string;
  password: string;
}

/** Reads and validates configuration from environment variables. */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): PaulConfig {
  const missing: string[] = [];
  if (!env.PAUL_URL) missing.push("PAUL_URL");
  if (!env.PAUL_EMAIL) missing.push("PAUL_EMAIL");
  if (!env.PAUL_PASSWORD) missing.push("PAUL_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "Set PAUL_URL (base URL of the PAUL app up to its folder, e.g. " +
        "https://example.com/iventas-coach), PAUL_EMAIL and PAUL_PASSWORD " +
        "(the collaborator's login credentials).",
    );
  }
  return {
    url: (env.PAUL_URL as string).replace(/\/+$/, ""),
    email: env.PAUL_EMAIL as string,
    password: env.PAUL_PASSWORD as string,
  };
}

/* ---------- API response shapes (extracted from api.php) ---------- */

export interface PaulTask {
  id: number;
  title: string;
  type: string;
  estMin: number;
  priority: number;
  /** pending | active | paused | waiting | review | confirm | done */
  status: string;
  mood: string | null;
  elapsed: number;
  overdue: boolean;
  overdueMin: number;
  overdueLabel: string;
  overdueKind: string | null;
  execDelay: number;
  requesterName: string | null;
  clientName: string | null;
  /** Pre-filled client brief context; present when the task has a client. */
  clientContext?: string | null;
  /** Newline-separated client KPIs; present when the task has a client. */
  clientKpis?: string | null;
  /** true when PAUL auto-assigned the task — the only tasks that may be reassigned. */
  byPaul?: boolean;
  created: string;
  effMin: number;
  week: string | null;
  future: boolean;
  parallel: number;
}

export interface StateResponse {
  user: { name: string; role: string; uid?: string };
  company?: Record<string, unknown>;
  tasks: PaulTask[];
  race?: unknown[];
  week: { start: string; end: string };
  budget: {
    ok: boolean;
    today?: number;
    month?: number;
    daily_cap?: number;
    monthly_cap?: number;
    daily_left?: number;
    monthly_left?: number;
    [k: string]: unknown;
  };
  moves_left: number;
  /**
   * READ-ONLY session: an admin is viewing someone else's data through
   * `admin/view_as.php`. EVERY write is rejected with `read_only`, including
   * `action=login`. Only `admin/view_self.php` clears it.
   */
  ro?: boolean;
  /**
   * True only while a `view_as` impersonation is active — it is NOT an
   * "is admin" flag. Verified against production: an admin's own session
   * reports `view_admin: false`. The JSON API has no way to tell you whether
   * the account is an administrator; only the admin panel login does.
   */
  view_admin?: boolean;
  /** Unresolved team-visible red flag ({ flag_id, reason, title, ... }) awaiting red_gate_ack. */
  pending_red_gate?: unknown;
  /** How many red flags the user accumulated this week (visible to the whole team). */
  red_flags_week?: number;
  /** Count of unread team bug reports. */
  bugs_new?: number;
  /** Whether this user may see the bug tool at all. */
  sees_bugs?: boolean;
  [k: string]: unknown;
}

export interface StartTaskResponse {
  ok: boolean;
  parallel?: number;
  resumed?: boolean;
  /** Set when the task's client brief must be filled before it can start. */
  need_client_brief?: boolean;
}

export interface QuestionsResponse {
  questions: string[];
  /** false means the AI budget/key was unavailable and generic fallback questions were used */
  ai: boolean;
  reason?: "no_key" | "budget" | "http_error" | null;
}

export interface QA {
  q: string;
  a: string;
}

export interface Verdict {
  approved: boolean;
  message: string;
  ai: boolean;
  attempt: number;
  offer_review: boolean;
  red_gate?: unknown;
}

export interface ReorderResponse {
  ok: boolean;
  /** Weekly priority moves remaining after this call (5 per week, reset Monday). */
  moves_left: number;
  /** true when the task was already at the target position — no move was spent. */
  noop?: boolean;
}

export interface RedGateAckResponse {
  ok: boolean;
  /** false means the AI judged the plan not serious enough — rewrite it and retry. */
  approved: boolean;
  message?: string;
}

export interface AssignUndoResponse {
  ok: boolean;
  /** Set when the undo was rejected, e.g. "Ya pasó el tiempo para deshacer." */
  message?: string;
}

export interface ChatResponse {
  reply: string;
  ai: boolean;
  learned: boolean;
  mood?: string;
  assigned?: boolean;
  assign_preview?: unknown;
  assign_multi?: unknown;
  undo_id?: number | null;
  reordered?: boolean;
}

/* ---------- Assignment ---------- */

export type Urgency = "alta" | "media" | "baja";

/** A person PAUL can assign work to. `uid` is the ONLY assignment identifier. */
export interface PeerContact {
  uid: string;
  name: string;
  first: string;
  dept?: string;
  unread?: number;
  last?: string | null;
  last_at?: string | null;
}

export interface PeerContactsResponse {
  contacts: PeerContact[];
  unread_total?: number;
}

/** Response of `peer_assign`. Note it does NOT return the new task id. */
export interface PeerAssignResponse {
  ok: boolean;
  /** Display name of the person the task landed on. */
  assigned_to?: string;
  message?: string;
}

export interface AssignConfirmInput {
  personUid: string;
  title: string;
  urgency: Urgency;
  estMin?: number;
  client?: string;
  reason?: string;
  /** The uid PAUL originally suggested, so it can learn from an override. */
  suggestedUid?: string;
}

/**
 * Response of `assign_confirm`. `undo_id` IS the new task's id — verified
 * against production, where `assign_undo` with that id deleted the task.
 */
export interface AssignConfirmResponse {
  ok: boolean;
  reply?: string;
  undo_id?: number | null;
  /** true when the autopilot is off and the task went to the admin queue instead. */
  queued?: boolean;
  message?: string;
}

export interface SimpleOkResponse {
  ok?: boolean;
  message?: string;
  [k: string]: unknown;
}

export interface DeleteTaskResponse {
  ok: boolean;
  /** false/absent means it was queued for admin approval instead of deleted. */
  deleted?: boolean;
  message?: string;
}

/* ---------- Bugs, ideas, tips ---------- */

export interface BugNote {
  who: string;
  note: string | null;
  images: string[];
}

export interface Bug {
  id: number;
  title: string;
  /** abierto | en_proceso | resuelto */
  status: string;
  /** How many people reported the same thing (the server de-duplicates). */
  reports: number;
  /** Display NAME of the assignee, not a uid. */
  assignee: string | null;
  notes: BugNote[];
}

export interface BugsListResponse {
  bugs: Bug[];
  /** Whether this user is allowed to assign bugs at all. */
  can_assign: boolean;
  team: PeerContact[];
}

export interface BugCreateResponse {
  ok: boolean;
  /** true = the server merged this report into an existing bug as a note. */
  grouped?: boolean;
  message?: string;
}

export interface Idea {
  id: number;
  text: string;
  who: string;
  votes: number;
  /** Whether the current user already voted for it. */
  voted: boolean;
  /** abierta | planeada | lista | descartada */
  status: string;
}

export interface IdeasListResponse {
  ideas: Idea[];
}

export interface TipsResponse {
  /** Present only for per-task tips: the task's own title. */
  title?: string;
  tips: string[];
}

export interface RequestedTask {
  id: number;
  title: string;
  /** pending | active | review | confirm */
  status: string;
  executorName: string | null;
  clientName: string | null;
  /** true when the client still has to be told the work is done. */
  awaitingAck: boolean;
}

export interface RequestsResponse {
  requests: RequestedTask[];
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
  readonly session: PaulSession;
  /** uid of the authenticated collaborator, learned from the login response. */
  private uid: string | null = null;

  constructor(
    private readonly config: PaulConfig,
    fetchImpl?: typeof fetch,
    session?: PaulSession,
  ) {
    this.session = session ?? new PaulSession(fetchImpl);
  }

  /** Base URL of the PAUL installation, without a trailing slash. */
  get baseUrl(): string {
    return this.config.url;
  }

  private endpoint(action: string, params?: Record<string, string | number>): string {
    const url = `${this.config.url}/api.php?action=${encodeURIComponent(action)}`;
    if (!params) return url;
    const extra = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return extra ? `${url}&${extra}` : url;
  }

  /** Authenticates the JSON API plane and captures the IVCOACH session cookie. */
  async login(): Promise<void> {
    const res = await this.session.fetch(this.endpoint("login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });

    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; message?: string; error?: string; user?: { uid?: string } }
      | null;
    if (body?.user?.uid) this.uid = body.user.uid;
    if (!res.ok || !body?.ok) {
      // A 403 here almost always means the session is stuck in an admin
      // read-only view, where even logging in is refused.
      const hint =
        res.status === 403
          ? " (the session may be in an admin read-only view — call adminViewSelf() to leave it)"
          : "";
      throw new PaulApiError(
        `PAUL login failed (${res.status}): ${body?.message ?? body?.error ?? "unexpected response"}${hint}`,
        res.status,
        body,
      );
    }
  }

  /**
   * Low-level call to api.php. GET when no body is given, POST with a JSON
   * body otherwise. Logs in lazily on first use; on a 401 / no_auth response
   * it re-logins once and retries the request once.
   */
  async request<T>(
    action: string,
    body?: unknown,
    params?: Record<string, string | number>,
  ): Promise<T> {
    if (!this.session.hasCookie()) await this.login();

    let attempt = await this.doFetch(action, body, params);
    if (attempt.noAuth) {
      await this.login();
      attempt = await this.doFetch(action, body, params);
    }
    const { res, parsed } = attempt;
    if (!res.ok) {
      const b = parsed as { message?: string; error?: string } | null;
      throw new PaulApiError(
        `PAUL API error on action=${action} (${res.status}): ${b?.message ?? b?.error ?? "unexpected response"}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  private async doFetch(
    action: string,
    body?: unknown,
    params?: Record<string, string | number>,
  ): Promise<{ res: Response; parsed: unknown; noAuth: boolean }> {
    const headers: Record<string, string> = {};
    let init: RequestInit = { method: "GET", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init = { method: "POST", headers, body: JSON.stringify(body) };
    }
    const res = await this.session.fetch(this.endpoint(action, params), init);
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
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
  async currentUid(): Promise<string | null> {
    if (!this.session.hasCookie()) await this.login();
    return this.uid;
  }

  /** GET action=state — full dashboard state including the user's tasks. */
  state(): Promise<StateResponse> {
    return this.request<StateResponse>("state");
  }

  /** POST action=start_task with { id }. */
  startTask(id: number): Promise<StartTaskResponse> {
    return this.request<StartTaskResponse>("start_task", { id });
  }

  /** POST action=request_questions with { id } — begins the close flow. */
  requestQuestions(id: number): Promise<QuestionsResponse> {
    return this.request<QuestionsResponse>("request_questions", { id });
  }

  /** POST action=submit_validation with { id, qa: [{ q, a }, ...] }. */
  submitValidation(id: number, qa: QA[]): Promise<Verdict> {
    return this.request<Verdict>("submit_validation", { id, qa });
  }

  /**
   * POST action=reorder_task with { id, to, reason } — moves a PENDING task
   * to a 0-based index within the user's open list (pending+active+waiting
   * ordered by position). Costs 1 of the 5 weekly priority moves; the API
   * answers 409 bad_status for non-pending tasks, 422 need_reason without a
   * reason, and 429 { error: "no_moves", moves_left: 0 } when the weekly
   * budget is spent (api.php:183-230).
   */
  reorderTask(id: number, to: number, reason: string): Promise<ReorderResponse> {
    return this.request<ReorderResponse>("reorder_task", { id, to, reason });
  }

  /** POST action=red_gate_questions with { flag_id } — the question and its minimum length. */
  redGateQuestions(flagId: number): Promise<{ questions: string[]; min?: number }> {
    return this.request<{ questions: string[]; min?: number }>("red_gate_questions", {
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
  redGateAck(flagId: number, plan: string): Promise<RedGateAckResponse> {
    return this.request<RedGateAckResponse>("red_gate_ack", {
      flag_id: flagId,
      qa: [{ q: RED_GATE_QUESTION_KEY, a: plan }],
      plan,
    });
  }

  /** POST action=coach_chat with { message }. */
  coachChat(message: string): Promise<ChatResponse> {
    return this.request<ChatResponse>("coach_chat", { message });
  }

  /* ---------- Assignment ---------- */

  /** GET action=peer_contacts — the roster, and the only source of valid uids. */
  peerContacts(): Promise<PeerContactsResponse> {
    return this.request<PeerContactsResponse>("peer_contacts");
  }

  /**
   * POST action=peer_assign — creates a task for `person_uid` in ONE call.
   * Verified against production as working "cold": it needs no prior chat and
   * no server-side pending assignment. It does NOT return the new task id.
   */
  peerAssign(input: {
    title: string;
    personUid: string;
    estMin: number;
    urgency: Urgency;
  }): Promise<PeerAssignResponse> {
    return this.request<PeerAssignResponse>("peer_assign", {
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
  assignConfirm(input: AssignConfirmInput): Promise<AssignConfirmResponse> {
    return this.request<AssignConfirmResponse>("assign_confirm", {
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
  assignUndo(id: number): Promise<AssignUndoResponse> {
    return this.request<AssignUndoResponse>("assign_undo", { id });
  }

  /**
   * POST action=task_reassign with { id, to, reason } — hands an EXISTING
   * task to another uid. The UI offers it only on tasks PAUL itself assigned
   * (`byPaul`), and the server notifies the admins with the reason.
   */
  taskReassign(id: number, to: string, reason: string): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("task_reassign", { id, to, reason });
  }

  /**
   * POST action=bounce_task with { id } — returns a task to whoever requested
   * it ("this isn't mine"). Takes no target: the requester is implicit.
   */
  bounceTask(id: number): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("bounce_task", { id });
  }

  /**
   * POST action=delete_task with { id }. When the autopilot is off the server
   * queues the deletion for admin approval instead of performing it, so check
   * `deleted` rather than assuming `ok` means gone.
   */
  deleteTask(id: number): Promise<DeleteTaskResponse> {
    return this.request<DeleteTaskResponse>("delete_task", { id });
  }

  /* ---------- Task clock ---------- */

  /** POST action=wait_task with { id } — sends to review; the clock stops. */
  waitTask(id: number): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("wait_task", { id });
  }

  /** POST action=pause_task with { id } — freezes the clock and frees a parallel slot. */
  pauseTask(id: number): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("pause_task", { id });
  }

  /** POST action=push_week with { id, reason } — moves a task to next week. */
  pushWeek(id: number, reason: string): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("push_week", { id, reason });
  }

  /** POST action=pull_week with { id } — pulls a future task into this week. */
  pullWeek(id: number): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("pull_week", { id });
  }

  /** GET action=requests — tasks the user delegated to others. */
  requests(): Promise<RequestsResponse> {
    return this.request<RequestsResponse>("requests");
  }

  /* ---------- Bugs ---------- */

  /** POST action=bugs_list with {} — every team bug, plus the assignable roster. */
  bugsList(): Promise<BugsListResponse> {
    return this.request<BugsListResponse>("bugs_list", {});
  }

  /**
   * POST action=bug_create with { title, desc, images }. The server
   * de-duplicates: an equivalent report is merged into an existing bug as a
   * note and comes back with `grouped: true`.
   */
  bugCreate(title: string, desc: string, images: string[] = []): Promise<BugCreateResponse> {
    return this.request<BugCreateResponse>("bug_create", { title, desc, images });
  }

  /** POST action=bug_assign with { bug_id, person_uid, urgency }. */
  bugAssign(bugId: number, personUid: string, urgency: Urgency): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("bug_assign", {
      bug_id: bugId,
      person_uid: personUid,
      urgency,
    });
  }

  /* ---------- Ideas ---------- */

  /** POST action=ideas_list with {} — the upvote board of ideas to improve PAUL. */
  ideasList(): Promise<IdeasListResponse> {
    return this.request<IdeasListResponse>("ideas_list", {});
  }

  /** POST action=idea_create with { text }. The server returns no useful body. */
  ideaCreate(text: string): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("idea_create", { text });
  }

  /** POST action=idea_vote with { id }. */
  ideaVote(id: number): Promise<SimpleOkResponse> {
    return this.request<SimpleOkResponse>("idea_vote", { id });
  }

  /* ---------- Tips (PAUL emits these; they are not user-authored) ---------- */

  /** POST action=paul_tips with {} — freshly generated daily coaching tips. */
  paulTips(): Promise<TipsResponse> {
    return this.request<TipsResponse>("paul_tips", {});
  }

  /** GET action=tips&id=<taskId> — perspective hints for one task. */
  taskTips(taskId: number): Promise<TipsResponse> {
    return this.request<TipsResponse>("tips", undefined, { id: taskId });
  }
}
