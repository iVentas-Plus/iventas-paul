import { afterEach, describe, expect, it, vi } from "vitest";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerTasksTool } from "../src/tools/tasks.js";
import {
  jsonResponse,
  mockFetchSequence,
  captureToolHandler,
  TEST_ENV,
} from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "u1", name: "Diego", role: "dev" } };

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_tasks", () => {
  it("summary includes moves_left, budget_ok, ro and pending_red_gate", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        user: { name: "Diego", role: "dev" },
        tasks: [{ id: 7, title: "Fix login", status: "pending", priority: 1, estMin: 60 }],
        week: { start: "2026-07-06", end: "2026-07-12" },
        budget: { ok: false },
        moves_left: 2,
        ro: true,
        pending_red_gate: { flag_id: 3, reason: "too_fast", title: "Fix login" },
        notifs_new: 4,
      }),
    ]);
    const handler = captureToolHandler(registerTasksTool, makeClient());

    const res = await handler({});

    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(payload.notifs_new).toBe(4);
    expect(payload.moves_left).toBe(2);
    expect(payload.budget_ok).toBe(false);
    expect(payload.ro).toBe(true);
    expect(payload.pending_red_gate).toEqual({
      flag_id: 3,
      reason: "too_fast",
      title: "Fix login",
    });
  });

  it("defaults ro to false and pending_red_gate to null when the state omits them", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({
        user: { name: "Diego", role: "dev" },
        tasks: [],
        week: { start: "2026-07-06", end: "2026-07-12" },
        budget: { ok: true },
        moves_left: 5,
      }),
    ]);
    const handler = captureToolHandler(registerTasksTool, makeClient());

    const res = await handler({});

    const payload = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(payload.moves_left).toBe(5);
    expect(payload.budget_ok).toBe(true);
    expect(payload.ro).toBe(false);
    expect(payload.pending_red_gate).toBeNull();
    // A build of PAUL without the bell must read as "nothing pending", never NaN.
    expect(payload.notifs_new).toBe(0);
  });
});
