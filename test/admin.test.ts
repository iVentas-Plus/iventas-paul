/**
 * Tool tests for the admin panel.
 *
 * The tools take the client as a parameter, so every test drives a fake
 * PaulAdminClient and no network is involved. HTML fixtures are trimmed
 * excerpts of markup really served by the panel.
 */
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaulAdminError, type PaulAdminClient } from "../src/admin-client.js";
import {
  registerAdminTools,
  registerAdminStatusTool,
  registerAdminTasksTool,
  registerAdminTaskWriteTool,
  registerAdminPeopleTool,
  registerAdminPageTool,
  registerAdminActionTool,
  registerAdminAskTool,
  MAX_TEXT_CHARS,
} from "../src/tools/admin.js";
import { captureToolHandler } from "./helpers.js";
import type { ToolResult } from "../src/tools/shared.js";

/* ---------- fixtures ---------- */

const REDFLAGS_HTML = `
<h2>🚩 Focos rojos</h2>
<div class="kpi"><div class="k-lbl">Focos rojos</div></div>
<table>
  <tr><th>Colaborador</th><th>Esta semana</th><th>Histórico</th></tr>
  <tr><td><b>Daniel</b></td><td>🔴🔴🔴</td><td>6</td></tr>
</table>`;

const NO_TABLES_HTML = "<h2>Sin datos</h2><p>Nada esta semana.</p>";

const ROSTER_HTML = `
<select name="u"><option value="aleks" selected>Aleks García — CEO</option>
<option value="arturo">Arturo García — Desarrollo</option></select>`;

const SINGLE_ROSTER_HTML = '<select name="u"><option value="solo">Solo — Dev</option></select>';

function board(id: number, title: string): string {
  return `<div class="adm-task" data-id="${id}"><form><input name="title" value="${title}">
    <input name="est_min" value="60"><span class="pill">pendiente</span></form></div>`;
}

const PEOPLE_HTML = `
<form><input type="hidden" name="_form" value="update_user">
<input type="hidden" name="uid" value="aleks"><input name="name" value="Aleks">
<input name="email" value="aleks@iventas.com"><input name="is_admin" checked></form>
<form><input type="hidden" name="_form" value="update_user">
<input type="hidden" name="uid" value="antonio"><input name="name" value="Antonio">
<input name="email" value="antonio@iventas.com"></form>
<form><input type="hidden" name="_form" value="delete_user">
<input type="hidden" name="uid" value="antonio"></form>`;

/* ---------- fake client ---------- */

function fakeAdmin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    page: vi.fn(async () => REDFLAGS_HTML),
    tasksPage: vi.fn(async () => board(1, "Una misión")),
    addTask: vi.fn(async () => board(1, "Una misión")),
    updateTask: vi.fn(async () => board(1, "Una misión")),
    deleteTask: vi.fn(async () => "<h2>Misiones</h2>"),
    completeTask: vi.fn(async () => "<h2>Misiones</h2>"),
    peoplePage: vi.fn(async () => PEOPLE_HTML),
    createUser: vi.fn(async () => PEOPLE_HTML),
    deleteUser: vi.fn(async () => PEOPLE_HTML),
    resetPassword: vi.fn(async () => `${PEOPLE_HTML}<p>Nueva contraseña: abc123</p>`),
    submit: vi.fn(async () => "<h2>Guardado</h2>"),
    ask: vi.fn(async () => "Aleks va más retrasado."),
    ...overrides,
  };
}

type Fake = ReturnType<typeof fakeAdmin>;

/** Registers one tool against a fake client and returns its handler. */
function handlerFor(
  register: (server: McpServer, admin: never) => void,
  admin: Fake,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return captureToolHandler(
    register as unknown as (server: McpServer, client: Fake) => void,
    admin,
  );
}

function payloadOf(res: ToolResult): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

/* ---------- registration ---------- */

describe("registerAdminTools", () => {
  it("registers the seven admin tools", () => {
    const names: string[] = [];
    const server = {
      registerTool: (name: string) => {
        names.push(name);
      },
    } as unknown as McpServer;

    registerAdminTools(server, fakeAdmin() as unknown as PaulAdminClient);

    expect(names).toEqual([
      "paul_admin_status",
      "paul_admin_tasks",
      "paul_admin_task_write",
      "paul_admin_people",
      "paul_admin_page",
      "paul_admin_action",
      "paul_admin_ask",
    ]);
  });
});

/* ---------- paul_admin_status ---------- */

describe("paul_admin_status", () => {
  it("returns headings, kpis and tables for a team-wide page", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminStatusTool, admin)({ page: "redflags" });

    expect(res.isError).toBeUndefined();
    const payload = payloadOf(res);
    expect(payload.headings).toEqual(["🚩 Focos rojos"]);
    expect(payload.kpis).toEqual(["Focos rojos"]);
    const tables = payload.tables as Array<{ headers: string[]; rows: string[][] }>;
    expect(tables[0].headers).toEqual(["Colaborador", "Esta semana", "Histórico"]);
    expect(tables[0].rows[0]).toEqual(["Daniel", "🔴🔴🔴", "6"]);
    expect(admin.page).toHaveBeenCalledWith("redflags", undefined);
  });

  it("forwards params such as {p:'week'} to the page", async () => {
    const admin = fakeAdmin();
    await handlerFor(registerAdminStatusTool, admin)({ page: "pulse", params: { p: "week" } });

    expect(admin.page).toHaveBeenCalledWith("pulse", { p: "week" });
  });

  it("boundary: a page with zero tables returns an empty table list", async () => {
    const admin = fakeAdmin({ page: vi.fn(async () => NO_TABLES_HTML) });
    const payload = payloadOf(await handlerFor(registerAdminStatusTool, admin)({ page: "delays" }));

    expect(payload.tables).toEqual([]);
    expect(payload.kpis).toEqual([]);
  });

  it("negative: a PaulAdminError is surfaced as an error result", async () => {
    const admin = fakeAdmin({
      page: vi.fn(async () => {
        throw new PaulAdminError("Could not stay authenticated for admin/redflags.php.");
      }),
    });
    const res = await handlerFor(registerAdminStatusTool, admin)({ page: "redflags" });

    expect(res.isError).toBe(true);
    expect(payloadOf(res).message).toContain("Could not stay authenticated");
  });

  it("robustness: malformed HTML does not throw", async () => {
    const admin = fakeAdmin({ page: vi.fn(async () => "<table><tr><td>a<h2>roto") });
    const res = await handlerFor(registerAdminStatusTool, admin)({ page: "kicked" });

    expect(res.isError).toBeUndefined();
  });
});

/* ---------- paul_admin_tasks ---------- */

describe("paul_admin_tasks", () => {
  it("returns one collaborator's board when a uid is given", async () => {
    const admin = fakeAdmin();
    const payload = payloadOf(await handlerFor(registerAdminTasksTool, admin)({ uid: "arturo" }));

    expect(admin.tasksPage).toHaveBeenCalledWith("arturo");
    expect(admin.page).not.toHaveBeenCalled();
    expect(payload.uid).toBe("arturo");
    expect(payload.total).toBe(1);
  });

  it("sweeps every uid in the panel's own select when no uid is given", async () => {
    const admin = fakeAdmin({
      page: vi.fn(async () => ROSTER_HTML),
      tasksPage: vi.fn(async (uid: string) =>
        uid === "aleks" ? board(1, "A") + board(2, "B") : board(3, "C"),
      ),
    });
    const payload = payloadOf(await handlerFor(registerAdminTasksTool, admin)({}));

    expect(admin.page).toHaveBeenCalledWith("tasks");
    expect(admin.tasksPage).toHaveBeenCalledTimes(2);
    expect(payload.swept).toBe(2);
    expect(payload.summary).toEqual([
      { uid: "aleks", name: "Aleks García — CEO", total: 2 },
      { uid: "arturo", name: "Arturo García — Desarrollo", total: 1 },
    ]);
  });

  it("boundary: a sweep over a single uid still returns a board", async () => {
    const admin = fakeAdmin({ page: vi.fn(async () => SINGLE_ROSTER_HTML) });
    const payload = payloadOf(await handlerFor(registerAdminTasksTool, admin)({}));

    expect(payload.swept).toBe(1);
    expect(admin.tasksPage).toHaveBeenCalledTimes(1);
    expect(admin.tasksPage).toHaveBeenCalledWith("solo");
  });

  it("boundary: a collaborator with zero tasks returns an empty list", async () => {
    const admin = fakeAdmin({ tasksPage: vi.fn(async () => '<div id="admTasks"></div>') });
    const payload = payloadOf(await handlerFor(registerAdminTasksTool, admin)({ uid: "javi" }));

    expect(payload.total).toBe(0);
    expect(payload.tasks).toEqual([]);
  });

  it("boundary: a tasks page with no roster select explains itself instead of throwing", async () => {
    const admin = fakeAdmin({ page: vi.fn(async () => "<h2>Misiones</h2>") });
    const payload = payloadOf(await handlerFor(registerAdminTasksTool, admin)({}));

    expect(payload.error).toBe(true);
    expect(String(payload.message)).toContain("user list");
  });

  it("negative: a PaulAdminError during the sweep is surfaced", async () => {
    const admin = fakeAdmin({
      page: vi.fn(async () => ROSTER_HTML),
      tasksPage: vi.fn(async () => {
        throw new PaulAdminError("admin/tasks.php answered 500.");
      }),
    });
    const res = await handlerFor(registerAdminTasksTool, admin)({});

    expect(res.isError).toBe(true);
    expect(payloadOf(res).message).toContain("answered 500");
  });
});

/* ---------- paul_admin_task_write ---------- */

describe("paul_admin_task_write", () => {
  it("create forwards the assignee and every optional field", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminTaskWriteTool, admin)({
      action: "create",
      userUid: "arturo",
      title: "Arreglar el login",
      type: "asignada",
      estMin: 90,
      priority: 1,
      weeks: 2,
      context: "Contexto para PAUL",
      requesterUid: "aleks",
      clientName: "Prisma",
    });

    expect(admin.addTask).toHaveBeenCalledWith({
      userUid: "arturo",
      title: "Arreglar el login",
      type: "asignada",
      estMin: 90,
      priority: 1,
      weeks: 2,
      context: "Contexto para PAUL",
      requesterUid: "aleks",
      clientName: "Prisma",
    });
    expect(payloadOf(res).assignee).toBe("arturo");
  });

  it("create without the assignee refuses before making a request", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminTaskWriteTool, admin)({
      action: "create",
      title: "Sin dueño",
    });

    expect(res.isError).toBe(true);
    expect(String(payloadOf(res).message)).toContain("userUid");
    expect(admin.addTask).not.toHaveBeenCalled();
  });

  it("update forwards the editable fields (never an assignee or a status)", async () => {
    const admin = fakeAdmin();
    await handlerFor(registerAdminTaskWriteTool, admin)({
      action: "update",
      id: 698,
      title: "Nuevo título",
      type: "propia",
      estMin: 30,
      priority: 3,
      context: "ctx",
      clientContext: "cc",
      clientKpis: "k1\nk2",
    });

    expect(admin.updateTask).toHaveBeenCalledWith({
      id: 698,
      title: "Nuevo título",
      type: "propia",
      estMin: 30,
      priority: 3,
      context: "ctx",
      clientContext: "cc",
      clientKpis: "k1\nk2",
    });
  });

  it("update without an id refuses before making a request", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminTaskWriteTool, admin)({
      action: "update",
      title: "Sin id",
    });

    expect(res.isError).toBe(true);
    expect(admin.updateTask).not.toHaveBeenCalled();
  });

  it("delete and complete call their own client methods with the id", async () => {
    const admin = fakeAdmin();
    const handler = handlerFor(registerAdminTaskWriteTool, admin);

    await handler({ action: "delete", id: 12 });
    await handler({ action: "complete", id: 34 });

    expect(admin.deleteTask).toHaveBeenCalledWith(12);
    expect(admin.completeTask).toHaveBeenCalledWith(34);
  });

  it("negative: a PaulAdminError from the panel is surfaced as an error result", async () => {
    const admin = fakeAdmin({
      deleteTask: vi.fn(async () => {
        throw new PaulAdminError("The admin session expired while submitting.");
      }),
    });
    const res = await handlerFor(registerAdminTaskWriteTool, admin)({ action: "delete", id: 1 });

    expect(res.isError).toBe(true);
    expect(payloadOf(res).message).toContain("session expired");
  });

  it("robustness: an unparseable confirmation page still returns ok", async () => {
    const admin = fakeAdmin({ completeTask: vi.fn(async () => "<div data-id=\"x\"><form") });
    const res = await handlerFor(registerAdminTaskWriteTool, admin)({
      action: "complete",
      id: 5,
    });

    expect(res.isError).toBeUndefined();
    expect(payloadOf(res).ok).toBe(true);
  });
});

/* ---------- paul_admin_people ---------- */

describe("paul_admin_people", () => {
  it("list returns the roster with the admin/protected flags", async () => {
    const admin = fakeAdmin();
    const payload = payloadOf(await handlerFor(registerAdminPeopleTool, admin)({ action: "list" }));

    expect(payload.total).toBe(2);
    expect(payload.admins).toBe(1);
    const people = payload.people as Array<Record<string, unknown>>;
    expect(people[0]).toMatchObject({ uid: "aleks", isAdmin: true, protected: true });
    expect(people[1]).toMatchObject({ uid: "antonio", isAdmin: false, protected: false });
  });

  it("create forwards every field name the panel expects", async () => {
    const admin = fakeAdmin();
    await handlerFor(registerAdminPeopleTool, admin)({
      action: "create",
      uid: "nuevo",
      name: "Persona Nueva",
      email: "nuevo@iventas.com",
      role: "Desarrollo",
      departmentId: "2",
      workContext: "Hace cosas",
      aliases: "nuevo, el nuevo",
      isAdmin: false,
      showClientBar: true,
    });

    expect(admin.createUser).toHaveBeenCalledWith({
      uid: "nuevo",
      name: "Persona Nueva",
      email: "nuevo@iventas.com",
      role: "Desarrollo",
      departmentId: "2",
      workContext: "Hace cosas",
      aliases: "nuevo, el nuevo",
      isAdmin: false,
      showClientBar: true,
    });
  });

  it("delete and reset_password call their own client methods", async () => {
    const admin = fakeAdmin();
    const handler = handlerFor(registerAdminPeopleTool, admin);

    await handler({ action: "delete", uid: "antonio" });
    const reset = await handler({ action: "reset_password", uid: "antonio" });

    expect(admin.deleteUser).toHaveBeenCalledWith("antonio");
    expect(admin.resetPassword).toHaveBeenCalledWith("antonio");
    expect(String(payloadOf(reset).text)).toContain("Nueva contraseña: abc123");
  });

  it("a write without a uid refuses before making a request", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminPeopleTool, admin)({ action: "delete" });

    expect(res.isError).toBe(true);
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it("negative: a PaulAdminError is surfaced as an error result", async () => {
    const admin = fakeAdmin({
      peoplePage: vi.fn(async () => {
        throw new PaulAdminError("PAUL rejected the admin login.");
      }),
    });
    const res = await handlerFor(registerAdminPeopleTool, admin)({ action: "list" });

    expect(res.isError).toBe(true);
    expect(payloadOf(res).message).toContain("rejected the admin login");
  });

  it("robustness: a person form with no email, next to an unclosed one, does not throw", async () => {
    const admin = fakeAdmin({
      peoplePage: vi.fn(
        async () =>
          '<form><input name="_form" value="update_user"><input name="uid" value="x">' +
          '<input name="name" value="Sin Correo"></form>' +
          '<form><input name="_form" value="update_user"><input name="uid" value="roto"',
      ),
    });
    const res = await handlerFor(registerAdminPeopleTool, admin)({ action: "list" });

    expect(res.isError).toBeUndefined();
    const people = payloadOf(res).people as Array<Record<string, unknown>>;
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ uid: "x", name: "Sin Correo", email: null });
  });
});

/* ---------- paul_admin_page ---------- */

describe("paul_admin_page", () => {
  it("returns headings, kpis, tables and the page text", async () => {
    const admin = fakeAdmin();
    const payload = payloadOf(
      await handlerFor(registerAdminPageTool, admin)({ page: "knowledge" }),
    );

    expect(payload.headings).toEqual(["🚩 Focos rojos"]);
    expect(String(payload.text)).toContain("Daniel");
    expect(payload.note).toBeUndefined();
  });

  it("validation: a page not in ADMIN_PAGES is rejected without a request", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminPageTool, admin)({ page: "wp-admin" });

    expect(res.isError).toBe(true);
    expect(String(payloadOf(res).message)).toContain("is not an admin page");
    expect(admin.page).not.toHaveBeenCalled();
  });

  it(`boundary: text of exactly ${MAX_TEXT_CHARS} characters is NOT truncated`, async () => {
    const admin = fakeAdmin({ page: vi.fn(async () => `<p>${"a".repeat(MAX_TEXT_CHARS)}</p>`) });
    const payload = payloadOf(await handlerFor(registerAdminPageTool, admin)({ page: "usage" }));

    expect(String(payload.text)).toHaveLength(MAX_TEXT_CHARS);
    expect(payload.note).toBeUndefined();
  });

  it("boundary: one character over the limit is truncated with an explicit note", async () => {
    const admin = fakeAdmin({
      page: vi.fn(async () => `<p>${"a".repeat(MAX_TEXT_CHARS + 1)}</p>`),
    });
    const payload = payloadOf(await handlerFor(registerAdminPageTool, admin)({ page: "usage" }));

    expect(String(payload.text)).toHaveLength(MAX_TEXT_CHARS);
    expect(String(payload.note)).toContain("TRUNCATED");
    expect(String(payload.note)).toContain(String(MAX_TEXT_CHARS + 1));
  });

  it("negative: a PaulAdminError is surfaced as an error result", async () => {
    const admin = fakeAdmin({
      page: vi.fn(async () => {
        throw new PaulAdminError("admin/settings.php answered 500.");
      }),
    });
    const res = await handlerFor(registerAdminPageTool, admin)({ page: "settings" });

    expect(res.isError).toBe(true);
  });
});

/* ---------- paul_admin_action ---------- */

describe("paul_admin_action", () => {
  it("posts the given fields verbatim to the given page", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminActionTool, admin)({
      page: "knowledge",
      fields: { _form: "add", user_uid: "", text: "PAUL debe recordar esto" },
    });

    expect(admin.submit).toHaveBeenCalledWith("knowledge", {
      _form: "add",
      user_uid: "",
      text: "PAUL debe recordar esto",
    });
    expect(payloadOf(res).ok).toBe(true);
    expect(payloadOf(res).headings).toEqual(["Guardado"]);
  });

  it("validation: a page not in ADMIN_PAGES is rejected without posting anything", async () => {
    const admin = fakeAdmin();
    const res = await handlerFor(registerAdminActionTool, admin)({
      page: "drop-tables",
      fields: { _form: "add" },
    });

    expect(res.isError).toBe(true);
    expect(admin.submit).not.toHaveBeenCalled();
  });

  it("boundary: a long confirmation page is truncated with a note", async () => {
    const admin = fakeAdmin({
      submit: vi.fn(async () => `<p>${"b".repeat(MAX_TEXT_CHARS + 50)}</p>`),
    });
    const payload = payloadOf(
      await handlerFor(registerAdminActionTool, admin)({ page: "hoy", fields: { q: "x" } }),
    );

    expect(String(payload.text)).toHaveLength(MAX_TEXT_CHARS);
    expect(String(payload.note)).toContain("TRUNCATED");
  });

  it("negative: a PaulAdminError is surfaced as an error result", async () => {
    const admin = fakeAdmin({
      submit: vi.fn(async () => {
        throw new PaulAdminError("The admin session expired while submitting; nothing changed.");
      }),
    });
    const res = await handlerFor(registerAdminActionTool, admin)({
      page: "people",
      fields: { _form: "delete_user", uid: "x" },
    });

    expect(res.isError).toBe(true);
    expect(payloadOf(res).message).toContain("nothing changed");
  });
});

/* ---------- paul_admin_ask ---------- */

describe("paul_admin_ask", () => {
  it("returns PAUL's answer alongside the question", async () => {
    const admin = fakeAdmin();
    const payload = payloadOf(
      await handlerFor(registerAdminAskTool, admin)({ question: "¿quién va más retrasado?" }),
    );

    expect(admin.ask).toHaveBeenCalledWith("¿quién va más retrasado?");
    expect(payload.answer).toBe("Aleks va más retrasado.");
  });

  it("negative: a PaulAdminError (e.g. exhausted AI budget) is surfaced", async () => {
    const admin = fakeAdmin({
      ask: vi.fn(async () => {
        throw new PaulAdminError("PAUL's copilot returned no answer.");
      }),
    });
    const res = await handlerFor(registerAdminAskTool, admin)({ question: "hola" });

    expect(res.isError).toBe(true);
    expect(payloadOf(res).message).toContain("no answer");
  });
});
