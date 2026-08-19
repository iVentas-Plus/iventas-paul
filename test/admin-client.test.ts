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

/* ---------- task board scoping (?u=) and merge-on-update ---------- */

/** One mission card exactly as admin/tasks.php renders it, with every field set. */
const TASK_CARD = `<h2>Misiones</h2>
<div class="adm-task" data-id="698">
  <form>
    <input name="title" value="Indexar Client">
    <input name="type" value="asignada">
    <input name="est_min" value="45">
    <select name="priority"><option value="1" selected>alta</option><option value="2">media</option></select>
    <textarea name="context">CTX-PRUEBA</textarea>
    <span class="pill">pendiente</span>
  </form>
</div>`;

/** Body of a form POST parsed back into a plain object. */
function fieldsOf(mock: ReturnType<typeof mockFetchSequence>, index: number): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(bodyOf(mock, index)));
}

describe("PaulAdminClient task board scoping", () => {
  it("addTask posts to tasks.php?u=<assignee> and re-reads THAT board", async () => {
    const mock = mockFetchSequence([redirect(), redirect(), htmlResponse(TASK_CARD)]);

    await makeAdmin().addTask({ userUid: "arturo", title: "Nueva misión" });

    // Without the query string the panel scopes the POST to whichever
    // collaborator comes first alphabetically, not the assignee.
    expect(urlOf(mock, 1)).toBe(
      "https://paul.example.com/iventas-coach/admin/tasks.php?u=arturo",
    );
    expect(urlOf(mock, 2)).toBe(
      "https://paul.example.com/iventas-coach/admin/tasks.php?u=arturo",
    );
  });

  it("deleteTask carries ?u= when the collaborator is known, and omits it otherwise", async () => {
    const withUid = mockFetchSequence([redirect(), redirect(), htmlResponse(TASK_CARD)]);
    await makeAdmin().deleteTask(875, "arturo");
    expect(urlOf(withUid, 1)).toContain("tasks.php?u=arturo");
    vi.unstubAllGlobals();

    const without = mockFetchSequence([redirect(), redirect(), htmlResponse(TASK_CARD)]);
    await makeAdmin().deleteTask(875);
    expect(urlOf(without, 1)).toBe("https://paul.example.com/iventas-coach/admin/tasks.php");
  });

  it("completeTask carries ?u= when given", async () => {
    const mock = mockFetchSequence([redirect(), redirect(), htmlResponse(TASK_CARD)]);

    await makeAdmin().completeTask(698, "arturo");

    expect(urlOf(mock, 1)).toContain("tasks.php?u=arturo");
  });
});

describe("PaulAdminClient.updateTask", () => {
  it("a title-only edit preserves type, estMin, priority and context", async () => {
    const mock = mockFetchSequence([
      redirect(), // login
      htmlResponse(TASK_CARD), // GET the board to read the stored row
      redirect(), // POST
      htmlResponse(TASK_CARD), // post/redirect/get
    ]);

    await makeAdmin().updateTask({ id: 698, userUid: "arturo", title: "Otro título" });

    expect(urlOf(mock, 1)).toContain("tasks.php?u=arturo");
    expect(fieldsOf(mock, 2)).toEqual({
      _form: "update_task",
      id: "698",
      title: "Otro título",
      type: "asignada",
      est_min: "45",
      priority: "1",
      context: "CTX-PRUEBA",
    });
    expect(urlOf(mock, 2)).toContain("tasks.php?u=arturo");
  });

  it("an explicit empty string clears the field instead of being ignored", async () => {
    const mock = mockFetchSequence([
      redirect(),
      htmlResponse(TASK_CARD),
      redirect(),
      htmlResponse(TASK_CARD),
    ]);

    await makeAdmin().updateTask({ id: 698, userUid: "arturo", context: "" });

    const sent = fieldsOf(mock, 2);
    expect(sent.context).toBe("");
    expect(sent.title).toBe("Indexar Client");
  });

  it("refuses without POSTing when the id is not on that collaborator's board", async () => {
    const mock = mockFetchSequence([redirect(), htmlResponse(TASK_CARD)]);
    const admin = makeAdmin();

    await expect(admin.updateTask({ id: 999, userUid: "arturo", title: "x" })).rejects.toThrow(
      /nothing was changed/i,
    );
    // Only the login and the board read happened: no form was posted.
    expect(mock.mock.calls).toHaveLength(2);
  });

  it("names userUid as the likely mistake when the task is missing", async () => {
    mockFetchSequence([redirect(), htmlResponse(TASK_CARD)]);

    await expect(
      makeAdmin().updateTask({ id: 999, userUid: "arturo", title: "x" }),
    ).rejects.toThrow(/userUid/);
  });
});

describe("PaulAdminClient.submit failures", () => {
  it("raises the status when the panel answers a non-OK page that is not the login form", async () => {
    mockFetchSequence([redirect(), htmlResponse("<h1>Server Error</h1>", 500)]);

    await expect(makeAdmin().deleteTask(1)).rejects.toThrow(/answered 500/);
  });
});

describe("PaulAdminClient.page redirects", () => {
  it("refuses to treat an unexpected 302 as an empty page", async () => {
    mockFetchSequence([redirect(), redirect("login.php")]);

    await expect(makeAdmin().page("tasks", { u: "arturo" })).rejects.toThrow(PaulAdminError);
  });
});

describe("PaulAdminClient.url validation", () => {
  it("rejects a page name that would escape the admin directory", async () => {
    mockFetchSequence([]);

    await expect(makeAdmin().page("../../wp-config")).rejects.toThrow(PaulAdminError);
  });

  it("rejects a page name carrying its own query string", async () => {
    mockFetchSequence([]);

    await expect(makeAdmin().page("tasks.php?u=x")).rejects.toThrow(PaulAdminError);
  });

  it("keeps every real admin page working", async () => {
    for (const page of ADMIN_PAGES) {
      const mock = mockFetchSequence([redirect(), htmlResponse(DASHBOARD)]);
      await expect(makeAdmin().page(page)).resolves.toBe(DASHBOARD);
      expect(urlOf(mock, 1)).toBe(
        `https://paul.example.com/iventas-coach/admin/${page}.php`,
      );
      vi.unstubAllGlobals();
    }
  });
});

describe("PaulAdminClient.withViewAs cleanup", () => {
  it("propagates the body's error even when leaving the view also fails", async () => {
    const mock = mockFetchSequence([
      redirect(), // login
      redirect(), // view_as
      new Error("view_self never answered"), // leaving the view fails too
    ]);
    const admin = makeAdmin();

    await expect(
      admin.withViewAs("david", async () => {
        throw new Error("the real failure");
      }),
    ).rejects.toThrow("the real failure");

    // The view is still left: the session must never stay read-only.
    expect(urlOf(mock, 2)).toContain("view_self.php");
  });

  it("surfaces a failure to leave the view when the body succeeded", async () => {
    mockFetchSequence([redirect(), redirect(), htmlResponse("boom", 500)]);

    await expect(makeAdmin().withViewAs("david", async () => "ok")).rejects.toThrow();
  });
});

describe("PaulAdminClient.ask session handling", () => {
  it("says the admin session expired when the copilot answers the login form", async () => {
    mockFetchSequence([redirect(), htmlResponse(LOGIN_FORM)]);

    await expect(makeAdmin().ask("¿quién va retrasado?")).rejects.toThrow(/session expired/i);
  });

  it("reports the status when the copilot answers a non-OK response", async () => {
    mockFetchSequence([redirect(), htmlResponse("nope", 503)]);

    await expect(makeAdmin().ask("algo")).rejects.toThrow(/503/);
  });
});
