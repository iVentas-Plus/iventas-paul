import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerNotificationsTool } from "../src/tools/notifications.js";
import type { ToolResult } from "../src/tools/shared.js";
import {
  jsonResponse,
  mockFetchSequence,
  callInfo,
  captureToolHandler,
  TEST_ENV,
} from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "arturo", name: "Arturo", role: "dev" } };

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

let schema: Record<string, z.ZodTypeAny> = {};

function tool(): Handler {
  return captureToolHandler((server: McpServer, client: PaulClient) => {
    const spy = {
      registerTool: (n: string, config: unknown, h: unknown) => {
        schema = (config as { inputSchema?: Record<string, z.ZodTypeAny> }).inputSchema ?? {};
        (server as unknown as { registerTool: (n: string, c: unknown, h: unknown) => void })
          .registerTool(n, config, h);
      },
    };
    registerNotificationsTool(spy as unknown as McpServer, client);
  }, makeClient());
}

const NOTIF = {
  id: 1,
  kind: "mencion",
  ref: "1",
  title: "No se puede cambiar la foto de perfil",
  body: "Aleks García: @Arturo saber si esto está funcionando",
  from: "Aleks",
  seen: false,
  at: "08-19 09:58",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_notifications", () => {
  it("posts action=notifs_list and reports the unseen count and each notification", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: [NOTIF], unseen: 1 }),
    ]);

    const res = await tool()({});

    expect(res.isError).toBeUndefined();
    expect(callInfo(mock, 1).url).toContain("action=notifs_list");
    expect(callInfo(mock, 1).method).toBe("POST");

    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.unseen).toBe(1);
    expect(payload.marked_seen).toBe(false);
    expect(payload.notifications).toEqual([
      {
        id: 1,
        kind: "mencion",
        requestId: 1,
        requestTitle: "No se puede cambiar la foto de perfil",
        from: "Aleks",
        body: "Aleks García: @Arturo saber si esto está funcionando",
        seen: false,
        at: "08-19 09:58",
      },
    ]);
  });

  it("does NOT mark anything seen unless asked", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: [NOTIF], unseen: 1 }),
    ]);

    await tool()({});

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls.some(([url]) => String(url).includes("notifs_seen"))).toBe(false);
  });

  it("marks everything seen when markSeen is true, after reading the list", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: [NOTIF], unseen: 1 }),
      jsonResponse({ ok: true }),
    ]);

    const res = await tool()({ markSeen: true });

    expect(callInfo(mock, 2).url).toContain("action=notifs_seen");
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.marked_seen).toBe(true);
    // The notifications are the ones read BEFORE the mark, so the caller still
    // sees which ones were new.
    expect(payload.notifications[0].seen).toBe(false);
  });

  it("still returns the notifications when marking them seen fails", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: [NOTIF], unseen: 1 }),
      new Error("ECONNRESET"),
    ]);

    const res = await tool()({ markSeen: true });

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;
    expect(payload.notifications).toHaveLength(1);
    expect(payload.marked_seen).toBe(false);
  });

  it("reports an empty inbox cleanly", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: [], unseen: 0 }),
    ]);

    const res = await tool()({});
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;

    expect(payload).toEqual({ unseen: 0, marked_seen: false, notifications: [] });
  });

  it("derives the unseen count when PAUL omits it", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: [NOTIF, { ...NOTIF, id: 2, seen: true }] }),
    ]);

    const res = await tool()({});

    expect(JSON.parse(res.content[0].text).unseen).toBe(1);
  });

  it("fuzz: a non-numeric or absent ref becomes a null requestId, never NaN", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        ok: true,
        notifs: [
          { ...NOTIF, id: 1, ref: "abc" },
          { ...NOTIF, id: 2, ref: null },
          // No `ref` key at all — the shape PAUL sends for a threadless notice.
          { id: 3, kind: "hilo", title: null, body: "x", from: "Aleks", seen: false, at: "08-19" },
        ],
        unseen: 3,
      }),
    ]);

    const res = await tool()({});
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;

    expect(payload.notifications.map((n: { requestId: unknown }) => n.requestId)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("fuzz: a non-array notifs is treated as empty", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true, notifs: { nope: true }, unseen: 4 }),
    ]);

    const res = await tool()({});
    const payload = JSON.parse(res.content[0].text) as Record<string, any>;

    expect(payload.notifications).toEqual([]);
    expect(payload.unseen).toBe(4);
  });

  it("surfaces a transport failure on the read as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      new Error("socket hang up"),
    ]);

    const res = await tool()({});

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toContain("socket hang up");
  });

  it("markSeen is optional and defaults to false", () => {
    tool();
    expect(schema.markSeen.safeParse(undefined).success).toBe(true);
    expect(schema.markSeen.parse(undefined)).toBe(false);
  });
});
