import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerIdeasTools } from "../src/tools/ideas.js";
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
 * registerIdeasTools installs three tools and captureToolHandler keeps only
 * the last one, so every registration but the requested name is filtered out
 * before it reaches the capturing server. The inputSchema is returned too, so
 * the zod limits can be asserted directly.
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
    registerIdeasTools(only as unknown as McpServer, client);
  }, makeClient());
  return { handler, input };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_ideas", () => {
  it("posts action=ideas_list and returns votes, who, status and voted", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        ideas: [
          { id: 4, text: "Modo oscuro", who: "Ana", votes: 7, voted: true, status: "abierta" },
          { id: 5, text: "Recordatorio diario", who: "Diego", votes: 2, voted: false, status: "planeada" },
        ],
      }),
    ]);

    const res = await tool("paul_ideas").handler({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.summary).toEqual({ total: 2, byStatus: { abierta: 1, planeada: 1 } });
    expect(payload.ideas[0]).toEqual({
      id: 4,
      text: "Modo oscuro",
      who: "Ana",
      votes: 7,
      voted: true,
      status: "abierta",
    });
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=ideas_list");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({});
  });

  it("surfaces an API error as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "server", message: "Falló la consulta." }, { status: 500 }),
    ]);

    const res = await tool("paul_ideas").handler({});

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(500);
    expect(payload.api.error).toBe("server");
  });

  it("returns an empty summary for an empty idea board", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ideas: [] }),
    ]);

    const res = await tool("paul_ideas").handler({});

    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload).toEqual({ summary: { total: 0, byStatus: {} }, ideas: [] });
  });

  it("does not throw when the response has no ideas key or incomplete ideas", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({}),
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ideas: [{ id: 8, text: "Sin metadatos" }] }),
    ]);

    const empty = await tool("paul_ideas").handler({});
    expect(empty.isError).toBeUndefined();
    expect(JSON.parse(empty.content[0].text)).toEqual({
      summary: { total: 0, byStatus: {} },
      ideas: [],
    });

    const partial = await tool("paul_ideas").handler({});
    expect(partial.isError).toBeUndefined();
    const payload = JSON.parse(partial.content[0].text) as Record<string, any>;
    expect(payload.ideas[0]).toEqual({
      id: 8,
      text: "Sin metadatos",
      who: null,
      votes: 0,
      voted: false,
      status: "abierta",
    });
    expect(payload.summary).toEqual({ total: 1, byStatus: { abierta: 1 } });
  });

  it("does not throw when ideas comes back as something other than an array", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ideas: "Modo oscuro" }),
    ]);

    const res = await tool("paul_ideas").handler({});

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({
      summary: { total: 0, byStatus: {} },
      ideas: [],
    });
  });
});

describe("paul_create_idea", () => {
  it("posts action=idea_create with { text } and confirms the idea via a re-read", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
      jsonResponse({
        ideas: [{ id: 11, text: "Modo oscuro para PAUL", who: "Diego", votes: 1, voted: true, status: "abierta" }],
      }),
    ]);

    const res = await tool("paul_create_idea").handler({ text: "Modo oscuro para PAUL" });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.submitted).toBe(true);
    expect(payload.confirmed).toBe(true);
    expect(payload.idea.id).toBe(11);
    expect(callInfo(mock, 1).url).toContain("action=idea_create");
    expect(callInfo(mock, 1).body).toEqual({ text: "Modo oscuro para PAUL" });
    expect(callInfo(mock, 2).url).toContain("action=ideas_list");
  });

  it("reports confirmed:false when the idea is not on the board after posting", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
      jsonResponse({ ideas: [{ id: 1, text: "Otra idea", who: "Ana", votes: 0, voted: false, status: "abierta" }] }),
    ]);

    const res = await tool("paul_create_idea").handler({ text: "Modo oscuro para PAUL" });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.confirmed).toBe(false);
    expect(payload.idea).toBeNull();
  });

  it("keeps the post successful when the confirmation re-read fails", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
      jsonResponse({ error: "server" }, { status: 500 }),
    ]);

    const res = await tool("paul_create_idea").handler({ text: "Modo oscuro para PAUL" });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.submitted).toBe(true);
    expect(payload.confirmed).toBe(false);
  });

  it("surfaces an API error on the create call itself", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "too_short", message: "La idea es muy corta." }, { status: 422 }),
    ]);

    const res = await tool("paul_create_idea").handler({ text: "Modo oscuro para PAUL" });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(422);
    expect(payload.api.error).toBe("too_short");
  });

  it("accepts text of exactly 6 and exactly 400 characters and rejects 5 and 401", () => {
    const { input } = tool("paul_create_idea");
    expect(input.text.safeParse("a".repeat(6)).success).toBe(true);
    expect(input.text.safeParse("a".repeat(400)).success).toBe(true);
    expect(input.text.safeParse("a".repeat(5)).success).toBe(false);
    expect(input.text.safeParse("a".repeat(401)).success).toBe(false);
  });

  it("forwards a 400-character idea verbatim", async () => {
    const text = "b".repeat(400);
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
      jsonResponse({ ideas: [{ id: 12, text, who: "Diego", votes: 0, voted: false, status: "abierta" }] }),
    ]);

    const res = await tool("paul_create_idea").handler({ text });

    expect(res.isError).toBeUndefined();
    expect(callInfo(mock, 1).body).toEqual({ text });
    expect((JSON.parse(res.content[0].text) as { confirmed: boolean }).confirmed).toBe(true);
  });
});

describe("paul_vote_idea", () => {
  it("posts action=idea_vote with { id }", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);

    const res = await tool("paul_vote_idea").handler({ id: 4 });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as { ok: boolean; api: unknown };
    expect(payload.ok).toBe(true);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=idea_vote");
    expect(call.body).toEqual({ id: 4 });
  });

  it("reports ok:true when the API answers 200 with an empty body", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({}),
    ]);

    const res = await tool("paul_vote_idea").handler({ id: 4 });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, api: {} });
  });

  it("surfaces a 404 for an unknown idea id", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "not_found", message: "Esa idea no existe." }, { status: 404 }),
    ]);

    const res = await tool("paul_vote_idea").handler({ id: 999999 });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { status: number; api: { error: string } };
    expect(payload.status).toBe(404);
    expect(payload.api.error).toBe("not_found");
  });
});
