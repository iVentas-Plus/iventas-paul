import { afterEach, describe, expect, it, vi } from "vitest";
import { PaulClient, configFromEnv } from "../src/client.js";
import {
  registerTaskActionTool,
  registerUndoAssignmentTool,
} from "../src/tools/task-actions.js";
import {
  jsonResponse,
  mockFetchSequence,
  callInfo,
  captureToolHandler,
  TEST_ENV,
} from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "arturo", name: "Arturo", role: "dev" } };

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

function handler() {
  return captureToolHandler(registerTaskActionTool, makeClient());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_task_action routing", () => {
  it.each([
    ["pause", "action=pause_task", { id: 10 }],
    ["review", "action=wait_task", { id: 10 }],
    ["delete", "action=delete_task", { id: 10 }],
    ["bounce", "action=bounce_task", { id: 10 }],
    ["pull_week", "action=pull_week", { id: 10 }],
  ])("maps %s to %s with { id }", async (action, expectedAction, expectedBody) => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);

    const res = await handler()({ id: 10, action });

    expect(res.isError).toBeUndefined();
    expect(callInfo(mock, 1).url).toContain(expectedAction);
    expect(callInfo(mock, 1).body).toEqual(expectedBody);
  });

  it("sends id, to and reason for reassign", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, message: "Se la pasé a David." }),
    ]);

    const res = await handler()({
      id: 42,
      action: "reassign",
      toUid: "david",
      reason: "es su área",
    });

    expect(res.isError).toBeUndefined();
    expect(callInfo(mock, 1).url).toContain("action=task_reassign");
    expect(callInfo(mock, 1).body).toEqual({ id: 42, to: "david", reason: "es su área" });
  });

  it("sends id and reason for push_week", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);

    await handler()({ id: 7, action: "push_week", reason: "no alcanza la semana" });

    expect(callInfo(mock, 1).url).toContain("action=push_week");
    expect(callInfo(mock, 1).body).toEqual({ id: 7, reason: "no alcanza la semana" });
  });
});

describe("paul_task_action guards", () => {
  it("refuses reassign without a target uid, before any network call", async () => {
    const mock = mockFetchSequence([jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" })]);

    const res = await handler()({ id: 1, action: "reassign", reason: "porque sí" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("toUid");
    expect(mock.mock.calls).toHaveLength(0);
  });

  it("refuses reassign without a reason", async () => {
    mockFetchSequence([jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" })]);

    const res = await handler()({ id: 1, action: "reassign", toUid: "david" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("reason");
  });

  it("refuses push_week without a reason", async () => {
    mockFetchSequence([jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" })]);

    const res = await handler()({ id: 1, action: "push_week" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("reason");
  });
});

describe("paul_task_action results", () => {
  it("passes a queued deletion through instead of claiming the task is gone", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        ok: true,
        deleted: false,
        message: "Un administrador debe aprobar la eliminación.",
      }),
    ]);

    const res = await handler()({ id: 3, action: "delete" });

    const payload = JSON.parse(res.content[0].text) as { deleted: boolean; message: string };
    expect(payload.deleted).toBe(false);
    expect(payload.message).toContain("administrador");
    expect(res.isError).toBeUndefined();
  });

  it("marks ok:false responses as errors", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: false, message: "No puedes pausar una tarea que no está activa." }),
    ]);

    const res = await handler()({ id: 3, action: "pause" });

    expect(res.isError).toBe(true);
  });

  it("does not throw when PAUL answers with an empty body", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse(null),
    ]);

    const res = await handler()({ id: 3, action: "bounce" });

    expect(res.content[0].text).toContain('"action": "bounce"');
  });

  it("surfaces the read_only error an admin impersonation session produces", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse(
        { error: "read_only", message: "👁️ Vista de administrador (solo lectura)." },
        { status: 403 },
      ),
    ]);

    const res = await handler()({ id: 3, action: "delete" });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { api: { error: string } };
    expect(payload.api.error).toBe("read_only");
  });
});

describe("paul_undo_assignment", () => {
  it("posts the task id and reports success", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);
    const undo = captureToolHandler(registerUndoAssignmentTool, makeClient());

    const res = await undo({ taskId: 876 });

    expect(res.isError).toBeUndefined();
    expect(callInfo(mock, 1).url).toContain("action=assign_undo");
    expect(callInfo(mock, 1).body).toEqual({ id: 876 });
  });

  it("marks a refused undo as an error and keeps PAUL's explanation", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: false, message: "Ya pasó el tiempo para deshacer." }),
    ]);
    const undo = captureToolHandler(registerUndoAssignmentTool, makeClient());

    const res = await undo({ taskId: 876 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Ya pasó el tiempo");
  });
});
