/**
 * Returns `message` with `params.arguments` defaulted to `{}` when a
 * `tools/call` request omits it or sends null. Any other message is returned
 * untouched, and the input is never mutated.
 */
export function normalizeCallToolArguments(message) {
    if (message === null || typeof message !== "object")
        return message;
    const request = message;
    if (request.method !== "tools/call")
        return message;
    const params = request.params;
    if (params === null || typeof params !== "object")
        return message;
    const args = params.arguments;
    if (args !== undefined && args !== null)
        return message;
    return { ...request, params: { ...params, arguments: {} } };
}
/**
 * Installs the normalizer on a transport that is already connected.
 *
 * It must run AFTER `server.connect(transport)`, because that is what assigns
 * `transport.onmessage`; wrapping earlier would capture nothing.
 */
export function applyCallToolArgumentCompat(transport) {
    const inner = transport.onmessage;
    if (!inner)
        return;
    transport.onmessage = (message, extra) => {
        inner(normalizeCallToolArguments(message), extra);
    };
}
