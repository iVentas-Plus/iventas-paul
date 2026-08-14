import { afterEach, describe, expect, it, vi } from "vitest";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerTipsTools } from "../src/tools/tips.js";
import {
  jsonResponse,
  mockFetchSequence,
  callInfo,
  captureToolHandler,
  TEST_ENV,
} from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "u1", name: "Diego", role: "dev" } };

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

function handler() {
  return captureToolHandler(registerTipsTools, makeClient());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_tips", () => {
  it("without taskId posts action=paul_tips and returns the daily tips", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ tips: ["Arranca por la tarea vencida", "Cierra antes de abrir otra"] }),
    ]);

    const res = await handler()({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(payload).toEqual({
      scope: "daily",
      taskId: null,
      title: null,
      count: 2,
      tips: ["Arranca por la tarea vencida", "Cierra antes de abrir otra"],
    });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=paul_tips");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({});
  });

  it("with taskId calls action=tips&id=<taskId> and returns the task title", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ title: "Arreglar el login", tips: ["Revisa el caso del token expirado"] }),
    ]);

    const res = await handler()({ taskId: 480 });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(payload).toEqual({
      scope: "task",
      taskId: 480,
      title: "Arreglar el login",
      count: 1,
      tips: ["Revisa el caso del token expirado"],
    });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=tips");
    expect(call.url).toContain("id=480");
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
  });

  it("surfaces an API error as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "budget", message: "Sin presupuesto de IA hoy." }, { status: 429 }),
    ]);

    const res = await handler()({});

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(429);
    expect(payload.api.error).toBe("budget");
  });

  it("surfaces a 404 for an unknown task id", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "not_found" }, { status: 404 }),
    ]);

    const res = await handler()({ taskId: 999999 });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(404);
    expect(payload.api.error).toBe("not_found");
  });

  it("reports count 0 for an empty tips array", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ tips: [] }),
    ]);

    const res = await handler()({});

    const payload = JSON.parse(res.content[0].text) as { count: number; tips: unknown[] };
    expect(payload.count).toBe(0);
    expect(payload.tips).toEqual([]);
  });

  it("does not throw when the response has no tips key", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ title: "Arreglar el login" }),
    ]);

    const res = await handler()({ taskId: 7 });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({
      scope: "task",
      taskId: 7,
      title: "Arreglar el login",
      count: 0,
      tips: [],
    });
  });

  it("does not throw when tips comes back as something other than an array", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ tips: "Arranca por la tarea vencida" }),
    ]);

    const res = await handler()({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as { count: number; tips: unknown[] };
    expect(payload.count).toBe(0);
    expect(payload.tips).toEqual([]);
  });

  it("does not throw when the API answers 200 with an unparseable body", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      new Response("not json", { status: 200 }),
    ]);

    const res = await handler()({});

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({
      scope: "daily",
      taskId: null,
      title: null,
      count: 0,
      tips: [],
    });
  });
});
