import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaulClient, configFromEnv } from "../src/client.js";
import { registerConfirmNotifiedTool } from "../src/tools/notify.js";
import { jsonResponse, mockFetchSequence, callInfo, captureToolHandler, TEST_ENV } from "./helpers.js";

const LOGIN_OK = { ok: true, user: { uid: "arturo", name: "Arturo", role: "Desarrollo" } };

function makeClient(): PaulClient {
  return new PaulClient(configFromEnv({ ...TEST_ENV }));
}

/** Captures the registration metadata, so the description can be asserted. */
function captureToolConfig(): { name: string; description: string } {
  let name = "";
  let description = "";
  const server = {
    registerTool: (n: string, config: { description?: string }) => {
      name = n;
      description = config.description ?? "";
    },
  } as unknown as McpServer;
  registerConfirmNotifiedTool(server, makeClient());
  return { name, description };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paul_confirm_notified", () => {
  it("posts { id } to action=confirm_notified", async () => {
    const mock = mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ ok: true }),
    ]);
    const handler = captureToolHandler(registerConfirmNotifiedTool, makeClient());

    const res = await handler({ id: 41 });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    const call = callInfo(mock, 1);
    expect(call.url).toContain("action=confirm_notified");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ id: 41 });
  });

  it("surfaces an API refusal as an error result", async () => {
    mockFetchSequence([
      jsonResponse(LOGIN_OK, { cookie: "IVCOACH=a" }),
      jsonResponse({ error: "bad_status", message: "Esa tarea no espera aviso." }, { status: 409 }),
    ]);
    const handler = captureToolHandler(registerConfirmNotifiedTool, makeClient());

    const res = await handler({ id: 41 });

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).status).toBe(409);
  });

  it("is registered under the tool name the spec fixes", () => {
    expect(captureToolConfig().name).toBe("paul_confirm_notified");
  });

  it("tells the agent it may never infer that the client was notified", () => {
    // The tool records a HUMAN action. An agent that assumes it happened
    // closes a task while the client was never told anything.
    const { description } = captureToolConfig();

    expect(description).toMatch(/never (infer|assume)/i);
    expect(description).toMatch(/human/i);
    expect(description).toMatch(/closes the task/i);
  });
});
