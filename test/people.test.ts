import { afterEach, describe, expect, it, vi } from "vitest";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerPeopleTool } from "../src/tools/people.js";
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
  return captureToolHandler(registerPeopleTool, makeClient());
}

interface Payload {
  total: number;
  people: Array<{ uid: string; name: string; first: string; dept: string | null }>;
  bot: { uid: string } | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_people", () => {
  it("GETs peer_contacts and returns uid, name, first and dept", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        contacts: [
          { uid: "david", name: "David Guerrero", first: "David", dept: "Soporte Técnico" },
          { uid: "mariel", name: "Mariel Arellano", first: "Mariel", dept: "PostVenta" },
        ],
        unread_total: 0,
      }),
    ]);

    const res = await handler()({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Payload;
    expect(payload.total).toBe(2);
    expect(payload.people).toEqual([
      { uid: "david", name: "David Guerrero", first: "David", dept: "Soporte Técnico" },
      { uid: "mariel", name: "Mariel Arellano", first: "Mariel", dept: "PostVenta" },
    ]);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=peer_contacts");
    expect(call.method).toBe("GET");
  });

  it("separates the PAUL bot from the humans so it is never assigned work", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        contacts: [
          { uid: "paul", name: "PAUL", first: "PAUL", dept: "" },
          { uid: "javi", name: "Javier", first: "Javier", dept: "Ventas" },
        ],
      }),
    ]);

    const payload = JSON.parse((await handler()({})).content[0].text) as Payload;

    expect(payload.people.map((p) => p.uid)).toEqual(["javi"]);
    expect(payload.bot?.uid).toBe("paul");
    // `total` counts the humans it is printed next to, never the bot.
    expect(payload.total).toBe(1);
  });

  it("handles an empty roster without throwing", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ contacts: [] }),
    ]);

    const payload = JSON.parse((await handler()({})).content[0].text) as Payload;

    expect(payload.total).toBe(0);
    expect(payload.people).toEqual([]);
    expect(payload.bot).toBeNull();
  });

  it("handles a response with no contacts key at all", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({}),
    ]);

    const res = await handler()({});

    expect(res.isError).toBeUndefined();
    expect((JSON.parse(res.content[0].text) as Payload).total).toBe(0);
  });

  it("normalizes a missing dept to null instead of undefined", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ contacts: [{ uid: "daniel", name: "Daniel", first: "Daniel" }] }),
    ]);

    const payload = JSON.parse((await handler()({})).content[0].text) as Payload;

    expect(payload.people[0].dept).toBeNull();
  });

  it("surfaces an API failure as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "boom" }, { status: 500 }),
    ]);

    const res = await handler()({});

    expect(res.isError).toBe(true);
  });

  it("reports the read_only refusal an impersonating admin session hits", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse(
        { error: "read_only", message: "👁️ Vista de administrador (solo lectura)." },
        { status: 403 },
      ),
    ]);

    const res = await handler()({});

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as { api: { error: string } };
    expect(payload.api.error).toBe("read_only");
  });
});
