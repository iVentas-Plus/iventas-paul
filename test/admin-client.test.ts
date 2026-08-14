import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/client.js";
import { PaulSession } from "../src/session.js";
import { PaulAdminClient, PaulAdminError, ADMIN_PAGES } from "../src/admin-client.js";
import { mockFetchSequence, TEST_ENV } from "./helpers.js";

const LOGIN_FORM = '<form method="post"><input type="hidden" name="_form" value="login"></form>';
const DASHBOARD = "<h1>Hoy</h1><table><tr><th>Colaborador</th></tr></table>";

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** A 302 with no body — how the panel signals a successful login or mutation. */
function redirect(location = "hoy.php"): Response {
  return new Response("", { status: 302, headers: { location } });
}

function makeAdmin(): PaulAdminClient {
  return new PaulAdminClient(configFromEnv({ ...TEST_ENV }), new PaulSession());
}

function bodyOf(mock: ReturnType<typeof mockFetchSequence>, index: number): string {
  const [, init] = mock.mock.calls[index] as [string, RequestInit];
  return String(init.body ?? "");
}

function urlOf(mock: ReturnType<typeof mockFetchSequence>, index: number): string {
  return String((mock.mock.calls[index] as [string, RequestInit])[0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PaulAdminClient.login", () => {
  it("treats a 302 as success and form-encodes the credentials", async () => {
    const mock = mockFetchSequence([redirect()]);

    await makeAdmin().login();

    expect(urlOf(mock, 0)).toBe("https://paul.example.com/iventas-coach/admin/hoy.php");
    const body = bodyOf(mock, 0);
    expect(body).toContain("_form=login");
    expect(body).toContain("email=dev%40example.com");
    expect(body).toContain("password=secret");
  });

  it("explains that the account lacks the admin role when the login form comes back", async () => {
    mockFetchSequence([htmlResponse(LOGIN_FORM)]);

    await expect(makeAdmin().login()).rejects.toThrow(PaulAdminError);
  });

  it("names the edge filter, not PAUL, on a 403", async () => {
    mockFetchSequence([htmlResponse("Forbidden", 403)]);

    await expect(makeAdmin().login()).rejects.toThrow(/User-Agent/);
  });

  it("isAdmin answers false instead of throwing when the panel refuses", async () => {
    mockFetchSequence([htmlResponse(LOGIN_FORM)]);

    await expect(makeAdmin().isAdmin()).resolves.toBe(false);
  });

  it("isAdmin answers true on a successful login", async () => {
    mockFetchSequence([redirect()]);

    await expect(makeAdmin().isAdmin()).resolves.toBe(true);
  });
});

describe("PaulAdminClient.page", () => {
  it("logs in lazily, then GETs the requested page with its params", async () => {
    const mock = mockFetchSequence([redirect(), htmlResponse(DASHBOARD)]);

    const html = await makeAdmin().page("tasks", { u: "david" });

    expect(html).toBe(DASHBOARD);
    expect(urlOf(mock, 1)).toBe(
      "https://paul.example.com/iventas-coach/admin/tasks.php?u=david",
    );
  });

  it("re-logins once when the session expired mid-flight", async () => {
    const mock = mockFetchSequence([
      redirect(),
      htmlResponse(LOGIN_FORM),
      redirect(),
      htmlResponse(DASHBOARD),
    ]);

    const html = await makeAdmin().page("pulse");

    expect(html).toBe(DASHBOARD);
    expect(mock.mock.calls).toHaveLength(4);
  });

  it("gives up rather than looping when the re-login does not take", async () => {
    mockFetchSequence([redirect(), htmlResponse(LOGIN_FORM), redirect(), htmlResponse(LOGIN_FORM)]);

    await expect(makeAdmin().page("pulse")).rejects.toThrow(/stay authenticated/);
  });
});

describe("PaulAdminClient.submit", () => {
  it("posts the form and follows the panel's post/redirect/get", async () => {
    const mock = mockFetchSequence([redirect(), redirect(), htmlResponse(DASHBOARD)]);

    const html = await makeAdmin().deleteTask(875);

    expect(html).toBe(DASHBOARD);
    expect(bodyOf(mock, 1)).toBe("_form=delete_task&id=875");
  });

  it("sends the assignee as user_uid on add_task", async () => {
    const mock = mockFetchSequence([redirect(), htmlResponse(DASHBOARD)]);

    await makeAdmin().addTask({ userUid: "david", title: "Indexar Client", priority: 1 });

    const body = bodyOf(mock, 1);
    expect(body).toContain("_form=add_task");
    expect(body).toContain("user_uid=david");
    expect(body).toContain("title=Indexar+Client");
    expect(body).toContain("priority=1");
  });

  it("omits checkbox fields that are false rather than sending an empty value", async () => {
    const mock = mockFetchSequence([redirect(), htmlResponse(DASHBOARD)]);

    await makeAdmin().createUser({ uid: "laura", name: "Laura", isAdmin: false });

    expect(bodyOf(mock, 1)).not.toContain("is_admin");
  });

  it("sends is_admin=1 when the flag is set", async () => {
    const mock = mockFetchSequence([redirect(), htmlResponse(DASHBOARD)]);

    await makeAdmin().createUser({ uid: "laura", name: "Laura", isAdmin: true });

    expect(bodyOf(mock, 1)).toContain("is_admin=1");
  });

  it("refuses to report success when the session died mid-submit", async () => {
    mockFetchSequence([redirect(), htmlResponse(LOGIN_FORM)]);

    await expect(makeAdmin().deleteTask(1)).rejects.toThrow(/nothing was changed/);
  });
});

describe("PaulAdminClient impersonation", () => {
  it("always leaves the read-only view, even when the body throws", async () => {
    const mock = mockFetchSequence([
      redirect(), // login
      redirect(), // view_as
      redirect(), // view_self, from the finally
    ]);
    const admin = makeAdmin();

    await expect(
      admin.withViewAs("david", async () => {
        throw new Error("something blew up inside the view");
      }),
    ).rejects.toThrow("something blew up inside the view");

    // Leaving the view is the whole point: a session left inside a view_as
    // cannot write anything and cannot even log in again.
    expect(urlOf(mock, 1)).toContain("view_as.php?uid=david");
    expect(urlOf(mock, 2)).toContain("view_self.php");
  });

  it("returns the body's value and still leaves the view on success", async () => {
    const mock = mockFetchSequence([redirect(), redirect(), redirect()]);

    const out = await makeAdmin().withViewAs("mariel", async () => "read something");

    expect(out).toBe("read something");
    expect(urlOf(mock, 2)).toContain("view_self.php");
  });
});

describe("PaulAdminClient.ask", () => {
  it("returns the copilot answer", async () => {
    mockFetchSequence([
      redirect(),
      new Response(JSON.stringify({ answer: "Aleks trae 27 misiones abiertas." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);

    await expect(makeAdmin().ask("¿quién viene sobrecargado?")).resolves.toContain("Aleks");
  });

  it("raises the copilot's error instead of returning an empty answer", async () => {
    mockFetchSequence([
      redirect(),
      new Response(JSON.stringify({ error: "presupuesto de IA agotado" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);

    await expect(makeAdmin().ask("algo")).rejects.toThrow(/presupuesto/);
  });
});

describe("ADMIN_PAGES", () => {
  it("lists every page of the panel without duplicates", () => {
    expect(new Set(ADMIN_PAGES).size).toBe(ADMIN_PAGES.length);
    expect(ADMIN_PAGES).toContain("tasks");
    expect(ADMIN_PAGES).toContain("people");
    expect(ADMIN_PAGES).toContain("settings");
  });
});
