/**
 * Protocol-boundary compatibility shims.
 *
 * The MCP specification makes `params.arguments` of a `tools/call` request
 * OPTIONAL, so a client is free to omit it for a tool that needs no input.
 * Codex does exactly that. The SDK, however, validates `params.arguments`
 * against the tool's declared input schema without defaulting it first
 * (`validateToolInput` in server/mcp.js: it returns early only when the tool
 * has NO `inputSchema`, otherwise it parses whatever arrived — including
 * `undefined`). The parse then fails with
 * "expected object, received undefined", and the call never reaches the
 * handler.
 *
 * Measured effect before this shim: every tool with no arguments or with only
 * optional ones — paul_tasks, paul_people, paul_bugs, paul_ideas, paul_tips —
 * failed for any client that omits the field, while working for clients that
 * send `{}`. A `null` was worse still: it was rejected one layer earlier, as a
 * malformed request.
 *
 * Normalizing at the transport is the right place: the defect is in how the
 * wire message is interpreted, not in any tool, so fixing it once here covers
 * every tool registered now or later.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Returns `message` with `params.arguments` defaulted to `{}` when a
 * `tools/call` request omits it or sends null. Any other message is returned
 * untouched, and the input is never mutated.
 */
export function normalizeCallToolArguments(message: unknown): unknown {
  if (message === null || typeof message !== "object") return message;
  const request = message as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call") return message;

  const params = request.params;
  if (params === null || typeof params !== "object") return message;

  const args = (params as Record<string, unknown>).arguments;
  if (args !== undefined && args !== null) return message;

  return { ...request, params: { ...(params as Record<string, unknown>), arguments: {} } };
}

/**
 * Installs the normalizer on a transport that is already connected.
 *
 * It must run AFTER `server.connect(transport)`, because that is what assigns
 * `transport.onmessage`; wrapping earlier would capture nothing.
 */
export function applyCallToolArgumentCompat(transport: Transport): void {
  const inner = transport.onmessage;
  if (!inner) return;
  transport.onmessage = (message, extra) => {
    inner(normalizeCallToolArguments(message) as Parameters<typeof inner>[0], extra);
  };
}
