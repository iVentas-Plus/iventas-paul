import { afterEach, describe, expect, it, vi } from "vitest";
import { PaulSession } from "../src/session.js";
import { PaulClient, configFromEnv } from "../src/client.js";
import { PaulAdminClient } from "../src/admin-client.js";
import { jsonResponse, mockFetchSequence, TEST_ENV } from "./helpers.js";

function initOf(mock: ReturnType<typeof mockFetchSequence>, index: number): RequestInit {
  return (mock.mock.calls[index] as [string, RequestInit])[1];
}

function headerOf(mock: ReturnType<typeof mockFetchSequence>, index: number, name: string) {
  const headers = (initOf(mock, index).headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PaulSession", () => {
  it("sends a browser User-Agent, without which the admin panel answers 403", async () => {
    const mock = mockFetchSequence([jsonResponse({ ok: true })]);

    await new PaulSession().fetch("https://paul.example.com/x");

    expect(headerOf(mock, 0, "user-agent")).toMatch(/Mozilla\/5\.0/);
  });

  it("captures the IVCOACH cookie and replays it on later requests", async () => {
    const mock = mockFetchSequence([
      jsonResponse({ ok: true }, { cookie: "IVCOACH=abc; path=/; HttpOnly" }),
      jsonResponse({ ok: true }),
    ]);
    const session = new PaulSession();

    expect(session.hasCookie()).toBe(false);
    await session.fetch("https://paul.example.com/login");
    expect(session.hasCookie()).toBe(true);
    await session.fetch("https://paul.example.com/next");

    expect(headerOf(mock, 0, "cookie")).toBeUndefined();
    expect(headerOf(mock, 1, "cookie")).toBe("IVCOACH=abc");
  });

  it("never follows redirects, because the admin panel signals success with a 302", async () => {
    const mock = mockFetchSequence([jsonResponse({ ok: true })]);

    await new PaulSession().fetch("https://paul.example.com/x");

    expect(initOf(mock, 0).redirect).toBe("manual");
  });

  it("ignores an unrelated cookie so an edge/WAF cookie cannot hijack the session", async () => {
    // This install sits behind nginx/Plesk. If the edge sets a cookie of its
    // own on any response, adopting it would silently replace the whole PAUL
    // session with something that authenticates nothing.
    const mock = mockFetchSequence([
      jsonResponse({ ok: true }, { cookie: "IVCOACH=real; path=/" }),
      jsonResponse({ ok: true }, { cookie: "PLESK_WAF=deadbeef; path=/" }),
      jsonResponse({ ok: true }),
    ]);
    const session = new PaulSession();

    await session.fetch("https://paul.example.com/login");
    await session.fetch("https://paul.example.com/next");
    await session.fetch("https://paul.example.com/third");

    expect(headerOf(mock, 2, "cookie")).toBe("IVCOACH=real");
  });

  it("does not adopt an unrelated cookie when no session cookie exists yet", async () => {
    const mock = mockFetchSequence([
      jsonResponse({ ok: true }, { cookie: "PLESK_WAF=deadbeef; path=/" }),
      jsonResponse({ ok: true }),
    ]);
    const session = new PaulSession();

    await session.fetch("https://paul.example.com/first");

    expect(session.hasCookie()).toBe(false);
    await session.fetch("https://paul.example.com/second");
    expect(headerOf(mock, 1, "cookie")).toBeUndefined();
  });

  it("merges a Headers instance, not only a plain object", async () => {
    // RequestInit allows a plain object, a Headers instance and an array of
    // tuples. Spreading `init.headers` as if it were always a plain object
    // dropped the other two silently — a POST would go out with no
    // Content-Type and PAUL would parse no body at all.
    const mock = mockFetchSequence([jsonResponse({ ok: true })]);

    await new PaulSession().fetch("https://paul.example.com/x", {
      headers: new Headers({ "Content-Type": "application/json" }),
    });

    expect(headerOf(mock, 0, "content-type")).toBe("application/json");
    expect(headerOf(mock, 0, "user-agent")).toMatch(/Mozilla\/5\.0/);
  });

  it("merges an array of header tuples", async () => {
    const mock = mockFetchSequence([jsonResponse({ ok: true })]);

    await new PaulSession().fetch("https://paul.example.com/x", {
      headers: [["Content-Type", "application/x-www-form-urlencoded"]],
    });

    expect(headerOf(mock, 0, "content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("lets the caller's own header win over the default User-Agent", async () => {
    const mock = mockFetchSequence([jsonResponse({ ok: true })]);

    await new PaulSession().fetch("https://paul.example.com/x", {
      headers: { "User-Agent": "propio" },
    });

    expect(headerOf(mock, 0, "user-agent")).toBe("propio");
  });

  it("aborts a request PAUL accepts but never answers", async () => {
    // The MCP server is a single stdio process: a promise that never settles
    // hangs the tool that called it with no error to report, so every request
    // carries a deadline.
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("request aborted by timeout")),
          );
        }),
    );
    vi.stubGlobal("fetch", hanging);

    await expect(
      new PaulSession(undefined, 20).fetch("https://paul.example.com/x"),
    ).rejects.toThrow(/abort/i);
  });

  it("keeps a caller-supplied signal instead of overriding it with the deadline", async () => {
    const mock = mockFetchSequence([jsonResponse({ ok: true })]);
    const controller = new AbortController();

    await new PaulSession().fetch("https://paul.example.com/x", { signal: controller.signal });

    expect(initOf(mock, 0).signal).toBe(controller.signal);
  });

  it("clear() forces the next call to authenticate again", async () => {
    mockFetchSequence([jsonResponse({ ok: true }, { cookie: "IVCOACH=abc" })]);
    const session = new PaulSession();

    await session.fetch("https://paul.example.com/login");
    session.clear();

    expect(session.hasCookie()).toBe(false);
  });
});

describe("shared session across planes", () => {
  it("carries one cookie across both planes but authenticates each separately", async () => {
    // PAUL is one PHP app with one IVCOACH cookie and TWO independent logins.
    // Verified against production: after the admin form login, api.php still
    // answers `no_auth` — so the JSON client must log in on its own, on the
    // very same session. Both authentications then coexist.
    const mock = mockFetchSequence([
      new Response("", {
        status: 302,
        headers: { location: "hoy.php", "set-cookie": "IVCOACH=shared; path=/" },
      }),
      jsonResponse({ error: "no_auth" }, { status: 401 }),
      jsonResponse({ ok: true, user: { uid: "arturo" } }),
      jsonResponse({ contacts: [{ uid: "david", name: "David", first: "David" }] }),
    ]);
    const config = configFromEnv({ ...TEST_ENV });
    const session = new PaulSession();
    const admin = new PaulAdminClient(config, session);
    const client = new PaulClient(config, undefined, session);

    await admin.login();
    const contacts = await client.peerContacts();

    expect(contacts.contacts).toHaveLength(1);
    // The admin cookie is presented on the first JSON call...
    expect(headerOf(mock, 1, "cookie")).toBe("IVCOACH=shared");
    // ...it is refused, the JSON plane logs in, and the retry succeeds on the
    // same session rather than starting a second one.
    expect(String(mock.mock.calls[2][0])).toContain("action=login");
    expect(headerOf(mock, 3, "cookie")).toBe("IVCOACH=shared");
  });
});
