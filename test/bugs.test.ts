import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerBugsTools } from "../src/tools/bugs.js";
import type { ToolResult } from "../src/tools/shared.js";
import {
  jsonResponse,
  mockFetchSequence,
  callInfo,
  captureToolHandler,
  TEST_ENV,
} from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "u1", name: "Diego", role: "dev" } };

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type Registrar = { registerTool: (n: string, c: unknown, h: unknown) => void };

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

/**
 * registerBugsTools installs three tools, and captureToolHandler keeps only
 * the last one, so every registration but the requested name is filtered out
 * before it reaches the capturing server. The tool's inputSchema is returned
 * too, so the zod limits can be asserted directly.
 */
function tool(name: string): { handler: Handler; input: Record<string, z.ZodTypeAny> } {
  let input: Record<string, z.ZodTypeAny> = {};
  const handler = captureToolHandler((server: McpServer, client: PaulClient) => {
    const only: Registrar = {
      registerTool: (n, config, h) => {
        if (n !== name) return;
        input = (config as { inputSchema?: Record<string, z.ZodTypeAny> }).inputSchema ?? {};
        (server as unknown as Registrar).registerTool(n, config, h);
      },
    };
    registerBugsTools(only as unknown as McpServer, client);
  }, makeClient());
  return { handler, input };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_bugs", () => {
  it("posts action=bugs_list and groups bugs by status with counts, can_assign and team", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        bugs: [
          {
            id: 1,
            title: "El cronómetro no para",
            status: "abierto",
            reports: 3,
            assignee: null,
            notes: [{ who: "Ana", note: "También me pasa", images: ["a.png"] }],
          },
          { id: 2, title: "Login lento", status: "en_proceso", reports: 1, assignee: "Diego", notes: [] },
          { id: 3, title: "Typo", status: "resuelto", reports: 1, assignee: "Ana", notes: [] },
        ],
        can_assign: true,
        team: [{ uid: "u2", name: "Ana", first: "Ana", dept: "dev" }],
      }),
    ]);

    const res = await tool("paul_bugs").handler({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.summary).toEqual({
      total: 3,
      byStatus: { abierto: 1, en_proceso: 1, resuelto: 1 },
    });
    expect(payload.can_assign).toBe(true);
    expect(payload.team).toEqual([{ uid: "u2", name: "Ana" }]);
    expect(payload.bugs.abierto[0]).toEqual({
      id: 1,
      title: "El cronómetro no para",
      status: "abierto",
      reports: 3,
      assignee: null,
      notes: [{ who: "Ana", note: "También me pasa", images: ["a.png"] }],
    });
    expect(payload.bugs.en_proceso.map((b: { id: number }) => b.id)).toEqual([2]);
    expect(payload.bugs.resuelto.map((b: { id: number }) => b.id)).toEqual([3]);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=bugs_list");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({});
  });

  it("surfaces an API error as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "forbidden", message: "No tienes acceso a bugs." }, { status: 403 }),
    ]);

    const res = await tool("paul_bugs").handler({});

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(403);
    expect(payload.api.error).toBe("forbidden");
  });

  it("returns empty groups and a zero summary for an empty bug list", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ bugs: [], can_assign: false, team: [] }),
    ]);

    const res = await tool("paul_bugs").handler({});

    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.summary).toEqual({ total: 0, byStatus: {} });
    expect(payload.bugs).toEqual({ abierto: [], en_proceso: [], resuelto: [] });
    expect(payload.team).toEqual([]);
    expect(payload.can_assign).toBe(false);
  });

  it("does not throw on a bug without notes, an unknown status or a missing team", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ bugs: [{ id: 9, title: "Sin notas", status: "archivado" }] }),
    ]);

    const res = await tool("paul_bugs").handler({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.summary).toEqual({ total: 1, byStatus: { archivado: 1 } });
    expect(payload.bugs.archivado[0]).toEqual({
      id: 9,
      title: "Sin notas",
      status: "archivado",
      reports: 1,
      assignee: null,
      notes: [],
    });
    expect(payload.can_assign).toBe(false);
    expect(payload.team).toEqual([]);
  });

  it("does not throw when bugs and team come back as something other than arrays", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ bugs: null, can_assign: true, team: "Ana" }),
    ]);

    const res = await tool("paul_bugs").handler({});

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({
      summary: { total: 0, byStatus: {} },
      can_assign: true,
      team: [],
      bugs: { abierto: [], en_proceso: [], resuelto: [] },
    });
  });
});

describe("paul_report_bug", () => {
  it("posts action=bug_create with { title, desc, images } and reports the result", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);

    const res = await tool("paul_report_bug").handler({
      title: "El cronómetro no para",
      desc: "Pasa al cerrar la tarea desde el celular",
    });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({
      ok: true,
      grouped: false,
      message: null,
    });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=bug_create");
    expect(call.body).toEqual({
      title: "El cronómetro no para",
      desc: "Pasa al cerrar la tarea desde el celular",
      images: [],
    });
  });

  it("treats grouped:true as a success, not an error", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, grouped: true, message: "Se sumó a un reporte existente." }),
    ]);

    const res = await tool("paul_report_bug").handler({ title: "Cronómetro roto", desc: "" });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as { ok: boolean; grouped: boolean };
    expect(payload).toEqual({
      ok: true,
      grouped: true,
      message: "Se sumó a un reporte existente.",
    });
  });

  it("surfaces a 422 from the API as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "bad_title", message: "Título muy corto." }, { status: 422 }),
    ]);

    const res = await tool("paul_report_bug").handler({ title: "Bug!", desc: "" });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(422);
    expect(payload.api.error).toBe("bad_title");
  });

  it("accepts a 4-character title, rejects a 3-character one, and defaults desc to ''", async () => {
    const { handler, input } = tool("paul_report_bug");
    expect(input.title.safeParse("Bug!").success).toBe(true);
    expect(input.title.safeParse("Bug").success).toBe(false);
    expect(input.desc.parse(undefined)).toBe("");

    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);
    const res = await handler({ title: "Bug!" });

    expect(res.isError).toBeUndefined();
    expect(callInfo(mock, 1).body).toEqual({ title: "Bug!", desc: "", images: [] });
  });

  it("does not throw when the API answers 200 with an unparseable body", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      new Response("not json", { status: 200 }),
    ]);

    const res = await tool("paul_report_bug").handler({ title: "Bug!", desc: "" });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: false, grouped: false, message: null });
  });
});

describe("paul_assign_bug", () => {
  it("posts action=bug_assign with { bug_id, person_uid, urgency }", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, message: "Asignado a Ana" }),
    ]);

    const res = await tool("paul_assign_bug").handler({
      bugId: 12,
      personUid: "u2",
      urgency: "alta",
    });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, message: "Asignado a Ana" });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=bug_assign");
    expect(call.body).toEqual({ bug_id: 12, person_uid: "u2", urgency: "alta" });
  });

  it("rejects an urgency outside the enum before any call", () => {
    const { input } = tool("paul_assign_bug");
    expect(input.urgency.safeParse("alta").success).toBe(true);
    expect(input.urgency.safeParse("urgente").success).toBe(false);
    expect(input.personUid.safeParse("").success).toBe(false);
  });

  it("surfaces a 409 from an already assigned or resolved bug", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "bad_status", message: "Ese bug ya está asignado." }, { status: 409 }),
    ]);

    const res = await tool("paul_assign_bug").handler({
      bugId: 12,
      personUid: "u2",
      urgency: "media",
    });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(409);
    expect(payload.api.error).toBe("bad_status");
  });

  it("reports ok:true when the API answers 200 with an empty body", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({}),
    ]);

    const res = await tool("paul_assign_bug").handler({
      bugId: 12,
      personUid: "u2",
      urgency: "baja",
    });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, message: null });
  });
});
