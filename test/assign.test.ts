import { afterEach, describe, expect, it, vi } from "vitest";
import { PaulClient, configFromEnv } from "../src/client.js";
import {
  assignTask,
  registerAssignTaskTool,
  registerRegisterTaskTool,
} from "../src/tools/assign.js";
import {
  jsonResponse,
  mockFetchSequence,
  callInfo,
  captureToolHandler,
  TEST_ENV,
} from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "arturo", name: "Arturo", role: "Desarrollo" } };

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assignTask", () => {
  it("creates the task in ONE call and reports undo_id as the task id", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, reply: "✅ Se la asigné a David.", undo_id: 876, queued: false }),
    ]);
    const client = makeClient();

    const res = await assignTask(client, {
      title: "Migrar el webhook de Gupshup",
      urgency: "alta",
      personUid: "david",
      estMin: 90,
      client: "UltraGym",
      reason: "es quien conoce el proveedor",
    });

    expect(res).toEqual({
      ok: true,
      taskId: 876,
      paulReply: "✅ Se la asigné a David.",
    });
    // Exactly two calls: the lazy login and the create. No coach_chat, no
    // state diffing — that is the whole point of the rewrite.
    expect(mock.mock.calls).toHaveLength(2);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=assign_confirm");
    expect(call.body).toEqual({
      person_uid: "david",
      title: "Migrar el webhook de Gupshup",
      urgency: "alta",
      est_min: 90,
      client: "UltraGym",
      reason: "es quien conoce el proveedor",
      suggested_uid: "david",
    });
  });

  it("defaults est_min, client, reason and suggested_uid when not given", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, undo_id: 1 }),
    ]);

    await assignTask(makeClient(), { title: "Algo", urgency: "baja", personUid: "mariel" });

    expect(callInfo(mock, 1).body).toEqual({
      person_uid: "mariel",
      title: "Algo",
      urgency: "baja",
      est_min: 60,
      client: "",
      reason: "",
      suggested_uid: "mariel",
    });
  });

  it("flags queued:true so the caller never claims the work was assigned", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, reply: "La dejé en la cola.", undo_id: null, queued: true }),
    ]);

    const res = await assignTask(makeClient(), {
      title: "Revisar cartera",
      urgency: "media",
      personUid: "alice",
    });

    expect(res.queued).toBe(true);
    expect(res.taskId).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("adds an explicit note when PAUL only QUEUED the proposal", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, reply: "La dejé en la cola.", queued: true }),
    ]);

    const res = await assignTask(makeClient(), {
      title: "Revisar cartera",
      urgency: "media",
      personUid: "alice",
    });

    expect(res.queued).toBe(true);
    expect(res.note).toMatch(/NOT assigned/i);
    expect(res.note).toMatch(/admin/i);
  });

  it("reports ok:false when PAUL refuses, keeping its message", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: false, message: "Ese colaborador no existe." }),
    ]);

    const res = await assignTask(makeClient(), {
      title: "Algo",
      urgency: "alta",
      personUid: "nadie",
    });

    expect(res.ok).toBe(false);
    expect(res.message).toBe("Ese colaborador no existe.");
  });

  it("does not throw when the response omits every optional field", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);

    const res = await assignTask(makeClient(), {
      title: "Algo",
      urgency: "alta",
      personUid: "javi",
    });

    expect(res).toEqual({ ok: true, paulReply: null });
  });

  // Every one of these titles was refused before the rewrite: travelling
  // inside a chat message, the urgency word read as an answer to PAUL's
  // urgency question. As a plain field they are unremarkable.
  it.each([
    "Dar de alta el bot de Refrimex",
    "Normalizar la prioridad media del tablero",
    "Bajar el consumo en horario regular",
    "Revisar la baja de un colaborador",
    "Marcar la tarea como urgente para el cliente",
  ])("accepts the title %j, which the old chat flow rejected", async (title) => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, undo_id: 12 }),
    ]);

    const res = await assignTask(makeClient(), { title, urgency: "media", personUid: "david" });

    expect(res.ok).toBe(true);
    expect(callInfo(mock, 1).body).toMatchObject({ title });
  });
});

describe("paul_assign_task", () => {
  it("forwards the assignee uid and surfaces PAUL's reply", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, reply: "Listo", undo_id: 500 }),
    ]);
    const handler = captureToolHandler(registerAssignTaskTool, makeClient());

    const res = await handler({
      title: "Indexar Client en producción",
      personUid: "diegoc",
      urgency: "alta",
    });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as { taskId: number; paulReply: string };
    expect(payload.taskId).toBe(500);
    expect(payload.paulReply).toBe("Listo");
    expect(callInfo(mock, 1).body).toMatchObject({ person_uid: "diegoc" });
  });

  it("marks the result as an error when PAUL answers ok:false", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: false, message: "uid inválido" }),
    ]);
    const handler = captureToolHandler(registerAssignTaskTool, makeClient());

    const res = await handler({ title: "Algo", personUid: "xxx", urgency: "baja" });

    expect(res.isError).toBe(true);
  });

  it("surfaces a transport/API failure through errorResult", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "server", message: "boom" }, { status: 500 }),
    ]);
    const handler = captureToolHandler(registerAssignTaskTool, makeClient());

    const res = await handler({ title: "Algo", personUid: "david", urgency: "baja" });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number };
    expect(payload.status).toBe(500);
  });
});

describe("ambiguous create failures", () => {
  // Measured in production: assign_confirm is NOT idempotent — two identical
  // calls created tasks 947 and 948. So a failure with no HTTP status (the
  // server never answered) leaves the outcome UNKNOWN, and a blind retry is
  // how a duplicate lands in a panel that has no undo.
  const AMBIGUOUS = /may (already )?have been created/i;

  it("warns that paul_assign_task may have created the task on a transport failure", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      new TypeError("fetch failed"),
    ]);
    const handler = captureToolHandler(registerAssignTaskTool, makeClient());

    const res = await handler({ title: "Algo", personUid: "david", urgency: "alta" });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toMatch(AMBIGUOUS);
    expect(text).toMatch(/de-duplicate/i);
    expect(text).toContain("paul_tasks");
    expect(text).toContain("paul_admin_tasks");
  });

  it("warns the same way from paul_register_task", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      new TypeError("fetch failed"),
    ]);
    const handler = captureToolHandler(registerRegisterTaskTool, makeClient());

    const res = await handler({ title: "Algo", urgency: "alta" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(AMBIGUOUS);
  });

  it("does NOT warn when the server answered: the outcome is deterministic", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "server", message: "boom" }, { status: 500 }),
    ]);
    const handler = captureToolHandler(registerAssignTaskTool, makeClient());

    const res = await handler({ title: "Algo", personUid: "david", urgency: "baja" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toMatch(AMBIGUOUS);
    expect(JSON.parse(res.content[0].text).status).toBe(500);
  });

  it("does not claim ambiguity when the LOGIN itself failed — nothing was created", async () => {
    mockFetchSequence([new TypeError("fetch failed")]);
    const handler = captureToolHandler(registerRegisterTaskTool, makeClient());

    const res = await handler({ title: "Algo", urgency: "alta" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toMatch(AMBIGUOUS);
  });
});

describe("paul_register_task", () => {
  it("assigns to the caller's own uid, taken from the login response", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, undo_id: 77, reply: "Te la agregué" }),
    ]);
    const handler = captureToolHandler(registerRegisterTaskTool, makeClient());

    const res = await handler({ title: "Escribir el spec del MCP", urgency: "media" });

    expect(res.isError).toBeUndefined();
    // Only login + create: `state` is never called, because it has
    // server-side side effects (coach nudges).
    expect(mock.mock.calls).toHaveLength(2);
    expect(callInfo(mock, 1).url).toContain("action=assign_confirm");
    expect(callInfo(mock, 1).body).toMatchObject({ person_uid: "arturo" });
  });

  it("fails cleanly when PAUL's login response carries no uid", async () => {
    mockFetchSequence([
      jsonResponse({ ok: true, user: { name: "Sin uid", role: "dev" } }, { cookie: "IVCOACH=a" }),
    ]);
    const handler = captureToolHandler(registerRegisterTaskTool, makeClient());

    const res = await handler({ title: "Algo", urgency: "alta" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("paul_people");
  });
});
