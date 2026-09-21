import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { PaulClient, PaulApiError, configFromEnv } from "../src/client.js";
import { PaulSession } from "../src/session.js";
import { jsonResponse, mockFetchSequence, callInfo, TEST_ENV } from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "u1", name: "Diego", role: "dev" } };
const STATE_OK = {
  user: { name: "Diego", role: "dev" },
  tasks: [],
  week: { start: "2026-07-06", end: "2026-07-12" },
  budget: { ok: true },
  moves_left: 3,
};

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configFromEnv", () => {
  it("fails fast listing every missing credential variable", () => {
    expect(() => configFromEnv({})).toThrowError(/PAUL_EMAIL.*PAUL_PASSWORD/s);
  });

  it("lists only the variables that are actually missing", () => {
    const err = (() => {
      try {
        configFromEnv({ PAUL_EMAIL: "a@b.c" });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(Error);
    const missingList = err!.message.split(".")[0]; // "Missing required environment variables: ..."
    expect(missingList).toContain("PAUL_PASSWORD");
    expect(missingList).not.toContain("PAUL_EMAIL");
    expect(missingList).not.toContain("PAUL_URL");
  });

  it("defaults to the production PAUL URL", () => {
    const cfg = configFromEnv({ PAUL_EMAIL: "dev@example.com", PAUL_PASSWORD: "secret" });
    expect(cfg.url).toBe("https://iventas.cc/iventas-coach");
  });

  it("treats an empty PAUL_URL override as absent", () => {
    const cfg = configFromEnv({
      PAUL_EMAIL: "dev@example.com",
      PAUL_PASSWORD: "secret",
      PAUL_URL: "  ",
    });
    expect(cfg.url).toBe("https://iventas.cc/iventas-coach");
  });

  it("strips trailing slashes from PAUL_URL overrides", () => {
    const cfg = configFromEnv({ ...TEST_ENV, PAUL_URL: "https://x.example/app/" });
    expect(cfg.url).toBe("https://x.example/app");
  });
});

describe("PaulClient auth", () => {
  it("logs in lazily, captures the session cookie and sends it on later requests", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=abc123; path=/; HttpOnly" }),
      jsonResponse(STATE_OK),
    ]);
    const client = makeClient();
    const state = await client.state();

    expect(state.user.name).toBe("Diego");
    expect(mock).toHaveBeenCalledTimes(2);

    const login = callInfo(mock, 0);
    expect(login.url).toBe("https://paul.example.com/iventas-coach/api.php?action=login");
    expect(login.method).toBe("POST");
    expect(login.body).toEqual({ email: "dev@example.com", password: "secret" });

    const stateCall = callInfo(mock, 1);
    expect(stateCall.url).toBe("https://paul.example.com/iventas-coach/api.php?action=state");
    expect(stateCall.method).toBe("GET");
    expect(stateCall.headers["cookie"]).toBe("IVCOACH=abc123");
  });

  it("re-logins exactly once and retries the request on a 401", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=old" }),
      jsonResponse(STATE_OK),
      jsonResponse({ error: "no_auth" }, { status: 401 }),
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=fresh" }),
      jsonResponse(STATE_OK),
    ]);
    const client = makeClient();
    await client.state(); // primes login + first state
    const state = await client.state(); // 401 -> re-login -> retry

    expect(state.user.name).toBe("Diego");
    expect(mock).toHaveBeenCalledTimes(5);
    expect(callInfo(mock, 3).url).toContain("action=login");
    expect(callInfo(mock, 4).headers["cookie"]).toBe("IVCOACH=fresh");
  });

  it("does not retry more than once when auth keeps failing", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "no_auth" }, { status: 401 }),
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=b" }),
      jsonResponse({ error: "no_auth" }, { status: 401 }),
    ]);
    const client = makeClient();
    await expect(client.state()).rejects.toThrowError(PaulApiError);
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("surfaces the API message when login is rejected", async () => {
    mockFetchSequence([
      jsonResponse(
        { error: "bad_credentials", message: "Correo o contraseña incorrectos." },
        { status: 401 },
      ),
    ]);
    const client = makeClient();
    await expect(client.state()).rejects.toThrowError(/Correo o contraseña incorrectos/);
  });

  it("throws a PaulApiError carrying the API error body on non-auth errors", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse(
        { error: "order", message: "Esa no toca todavía." },
        { status: 409 },
      ),
    ]);
    const client = makeClient();
    const err = await client.startTask(9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaulApiError);
    expect((err as PaulApiError).status).toBe(409);
    expect((err as PaulApiError).body).toMatchObject({ error: "order" });
  });
});

describe("PaulClient.currentUid", () => {
  it("logs in when the uid is unknown, even though the session already has a cookie", async () => {
    // Reproduces the production failure: the ADMIN plane logged in first, so
    // the shared IVCOACH cookie is present while api.php was never
    // authenticated and no uid was ever reported. Keying the lazy login on the
    // cookie made currentUid() return null and paul_register_task claim "PAUL
    // did not report your uid on login".
    const mock = mockFetchSequence([
      new Response("", {
        status: 302,
        headers: { location: "hoy.php", "set-cookie": "IVCOACH=shared; path=/" },
      }),
      jsonResponse(LOGIN_OK),
    ]);
    const session = new PaulSession();
    await session.fetch("https://paul.example.com/iventas-coach/admin/hoy.php", {
      method: "POST",
    });
    expect(session.hasCookie()).toBe(true);

    const client = new PaulClient(configFromEnv({ ...TEST_ENV }), undefined, session);

    expect(await client.currentUid()).toBe("u1");
    expect(mock).toHaveBeenCalledTimes(2);
    expect(callInfo(mock, 1).url).toContain("action=login");
  });

  it("logs in only once when the uid is already known", async () => {
    const mock = mockFetchSequence([jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" })]);
    const client = makeClient();

    expect(await client.currentUid()).toBe("u1");
    expect(await client.currentUid()).toBe("u1");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("returns null without looping when PAUL logs in but reports no uid", async () => {
    const mock = mockFetchSequence([
      jsonResponse({ ok: true, user: { name: "Sin uid", role: "dev" } }, { cookie: "IVCOACH=a" }),
    ]);
    const client = makeClient();

    expect(await client.currentUid()).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("PaulClient.confirmNotified", () => {
  it("posts { id } to action=confirm_notified", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);
    const client = makeClient();

    const res = await client.confirmNotified(41);

    expect(res.ok).toBe(true);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=confirm_notified");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ id: 41 });
  });
});

describe("PaulClient actions", () => {
  it("start_task posts { id } and returns the API payload", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, parallel: 1 }),
    ]);
    const client = makeClient();
    const res = await client.startTask(7);
    expect(res).toEqual({ ok: true, parallel: 1 });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=start_task");
    expect(call.body).toEqual({ id: 7 });
  });

  it("assign_undo posts { id } and returns the undo verdict", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: false, message: "Ya pasó el tiempo para deshacer." }),
    ]);
    const client = makeClient();
    const res = await client.assignUndo(43);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/deshacer/);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=assign_undo");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ id: 43 });
  });

  it("request_questions posts { id } and returns questions with ai flag", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ questions: ["¿Q1?", "¿Q2?", "¿Q3?"], ai: false, reason: "budget" }),
    ]);
    const client = makeClient();
    const res = await client.requestQuestions(7);
    expect(res.questions).toHaveLength(3);
    expect(res.ai).toBe(false);
    expect(res.reason).toBe("budget");
    expect(callInfo(mock, 1).body).toEqual({ id: 7 });
  });
});

describe("PaulClient.reorderTask", () => {
  it("posts { id, to, reason } to action=reorder_task and returns the payload", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, moves_left: 4 }),
    ]);
    const client = makeClient();
    const res = await client.reorderTask(7, 0, "Blocked release depends on this task");
    expect(res).toEqual({ ok: true, moves_left: 4 });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=reorder_task");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ id: 7, to: 0, reason: "Blocked release depends on this task" });
  });

  it("passes through the noop response when the task did not move", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, moves_left: 4, noop: true }),
    ]);
    const client = makeClient();
    const res = await client.reorderTask(7, 0, "Already at the top, just checking");
    expect(res.noop).toBe(true);
    expect(res.moves_left).toBe(4);
  });

  it("throws a PaulApiError carrying the no_moves body on 429", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "no_moves", moves_left: 0 }, { status: 429 }),
    ]);
    const client = makeClient();
    const err = await client
      .reorderTask(7, 0, "Blocked release depends on this task")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaulApiError);
    expect((err as PaulApiError).status).toBe(429);
    expect((err as PaulApiError).body).toMatchObject({ error: "no_moves", moves_left: 0 });
  });
});

describe("PaulClient.redGateAck", () => {
  const PLAN =
    "Registrar e iniciar la tarea en PAUL al comenzar el trabajo real y cerrarla al terminar.";

  it("posts { flag_id, qa keyed by 'mejora', plan } to action=red_gate_ack", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, approved: true, message: "Plan aceptado." }),
    ]);
    const client = makeClient();
    const res = await client.redGateAck(12, PLAN);
    expect(res.ok).toBe(true);
    expect(res.approved).toBe(true);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=red_gate_ack");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      flag_id: 12,
      // The gate has a single question and the server keys it by the literal
      // string 'mejora' — which is what PAUL's own web client sends. Sending
      // the Spanish sentence instead (as this client used to) relies on the
      // server matching on prose it never receives from the real UI.
      qa: [{ q: "mejora", a: PLAN }],
      plan: PLAN,
    });
  });

  it("passes through approved:false so the caller can rewrite the plan", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, approved: false, message: "El plan es muy vago, sé concreto." }),
    ]);
    const client = makeClient();
    const res = await client.redGateAck(12, PLAN);
    expect(res.ok).toBe(true);
    expect(res.approved).toBe(false);
    expect(res.message).toMatch(/muy vago/);
  });
});

describe("PaulClient.submitValidation", () => {
  const QA = [
    { q: "¿Qué se hizo?", a: "Se implementó X en src/foo.ts y pasaron los tests." },
    { q: "¿Cómo se validó?", a: "npm test en verde y build limpio." },
    { q: "¿Qué falta?", a: "Nada; el PR #12 quedó mergeado." },
  ];

  it("posts { id, qa } and returns the approved verdict", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        approved: true,
        message: "Misión cumplida. ¡Vamos por la siguiente!",
        ai: true,
        attempt: 1,
        offer_review: false,
      }),
    ]);
    const client = makeClient();
    const verdict = await client.submitValidation(7, QA);
    expect(verdict.approved).toBe(true);
    expect(verdict.attempt).toBe(1);
    expect(verdict.message).toMatch(/Misión cumplida/);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=submit_validation");
    expect(call.body).toEqual({ id: 7, qa: QA });
  });

  it("returns the rejected verdict with PAUL's requested improvement", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        approved: false,
        message: "Va bien, pero dime qué archivo exacto cambiaste.",
        ai: true,
        attempt: 1,
        offer_review: false,
      }),
    ]);
    const client = makeClient();
    const verdict = await client.submitValidation(7, QA);
    expect(verdict.approved).toBe(false);
    expect(verdict.message).toMatch(/archivo exacto/);
  });
});
