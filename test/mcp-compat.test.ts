import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  normalizeCallToolArguments,
  applyCallToolArgumentCompat,
} from "../src/mcp-compat.js";

const CALL = { jsonrpc: "2.0", id: 1, method: "tools/call" } as const;

describe("normalizeCallToolArguments", () => {
  it("defaults a missing arguments field to an empty object", () => {
    // This is the exact message Codex sends for a tool with no inputs, and
    // what made every no-argument tool fail.
    const out = normalizeCallToolArguments({ ...CALL, params: { name: "paul_people" } });

    expect(out).toEqual({ ...CALL, params: { name: "paul_people", arguments: {} } });
  });

  it("replaces a null arguments field, which is rejected even earlier", () => {
    const out = normalizeCallToolArguments({
      ...CALL,
      params: { name: "paul_tasks", arguments: null },
    });

    expect(out).toEqual({ ...CALL, params: { name: "paul_tasks", arguments: {} } });
  });

  it("leaves real arguments untouched", () => {
    const message = { ...CALL, params: { name: "paul_assign_task", arguments: { title: "x" } } };

    expect(normalizeCallToolArguments(message)).toEqual(message);
  });

  it("preserves an explicitly empty arguments object", () => {
    const message = { ...CALL, params: { name: "paul_bugs", arguments: {} } };

    expect(normalizeCallToolArguments(message)).toEqual(message);
  });

  it("does not mutate the message it was given", () => {
    const message = { ...CALL, params: { name: "paul_people" } };
    const snapshot = JSON.parse(JSON.stringify(message)) as unknown;

    normalizeCallToolArguments(message);

    expect(message).toEqual(snapshot);
  });

  it.each([
    ["a different method", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
    ["a notification", { jsonrpc: "2.0", method: "notifications/initialized" }],
    ["params that are not an object", { ...CALL, params: "nope" }],
    ["params that are null", { ...CALL, params: null }],
    ["a message with no params", { ...CALL }],
  ])("passes through %s unchanged", (_label, message) => {
    expect(normalizeCallToolArguments(message)).toBe(message);
  });

  it.each([[null], [undefined], ["a string"], [42], [true]])(
    "survives the non-object payload %j",
    (payload) => {
      expect(normalizeCallToolArguments(payload)).toBe(payload);
    },
  );
});

describe("applyCallToolArgumentCompat", () => {
  function fakeTransport(): Transport & { onmessage?: (m: unknown, e?: unknown) => void } {
    return { onmessage: vi.fn() } as unknown as Transport & {
      onmessage?: (m: unknown, e?: unknown) => void;
    };
  }

  it("normalizes messages before the SDK handler sees them", () => {
    const transport = fakeTransport();
    const inner = transport.onmessage as ReturnType<typeof vi.fn>;

    applyCallToolArgumentCompat(transport);
    transport.onmessage?.({ ...CALL, params: { name: "paul_ideas" } });

    expect(inner).toHaveBeenCalledWith(
      { ...CALL, params: { name: "paul_ideas", arguments: {} } },
      undefined,
    );
  });

  it("forwards the extra argument the SDK relies on", () => {
    const transport = fakeTransport();
    const inner = transport.onmessage as ReturnType<typeof vi.fn>;
    const extra = { authInfo: { token: "t" } };

    applyCallToolArgumentCompat(transport);
    transport.onmessage?.({ jsonrpc: "2.0", method: "tools/list" }, extra);

    expect(inner).toHaveBeenCalledWith({ jsonrpc: "2.0", method: "tools/list" }, extra);
  });

  it("does nothing when the transport has no handler yet", () => {
    // Calling before server.connect() would otherwise wrap nothing and
    // silently disable the shim.
    const transport = { onmessage: undefined } as unknown as Transport;

    expect(() => applyCallToolArgumentCompat(transport)).not.toThrow();
    expect(transport.onmessage).toBeUndefined();
  });
});
