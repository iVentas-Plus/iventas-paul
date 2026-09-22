/**
 * Parser tests for PAUL's admin panel HTML.
 *
 * Every fixture below is a trimmed excerpt of markup really served by the live
 * panel (build 2026.08.06-1) — a couple of rows, a couple of cards — so the
 * assertions are about what PAUL actually prints, not about an idealized DOM.
 */
import { describe, expect, it } from "vitest";
import {
  parseTables,
  parseHeadings,
  parseKpis,
  parseAdminTasks,
  parseAdminPeople,
  parseSelectOptions,
  stripTags,
  isAdminLoginPage,
  decodeEntities,
} from "../src/admin-parse.js";

/** admin/redflags.php — the weekly count is glyphs, the historic one is a digit. */
const REDFLAGS_HTML = `
<h1>PAUL · admin</h1>
<h2>🚩 Focos rojos</h2>
<table>
  <tr><th>Colaborador</th><th>Esta semana</th><th>Pendientes</th><th>Histórico</th></tr>
  <tr><td><b>Daniel</b></td><td>🔴🔴🔴🔴🔴</td><td>&mdash;</td><td>6</td></tr>
  <tr><td><b>Aleks Garc&iacute;a</b></td><td>🔴</td><td>&mdash;</td><td>17</td></tr>
  <tr><td><b>Jason Bautista</b></td><td>&mdash;</td><td>&mdash;</td><td>18</td></tr>
</table>`;

/** admin/forecast.php — balances are printed with U+2212 MINUS SIGN. */
const FORECAST_HTML = `
<h2>🔮 Pronóstico de la semana</h2>
<table>
  <tr><th></th><th>Colaborador</th><th>Abiertas</th><th>Estimado</th><th>Proyección real</th><th>Capacidad restante</th><th>Balance</th></tr>
  <tr>
    <td style="font-size:17px">🔴</td>
    <td><b>Aleks Garc&iacute;a</b><br><span class="note">CEO / Founder · factor 2.15x (n=45)</span></td>
    <td>27</td><td>48.3h</td><td><b>107.7h</b></td><td>9.0h</td>
    <td style="color:var(--danger,#c0392b)"><b>−98.7h</b></td>
  </tr>
</table>`;

const TASK_CARD_HTML = `
<div id="admTasks">
  <div class="frame adm-task" data-id="698">
    <span class="rank">1</span>
    <form method="post">
      <input type="hidden" name="_form" value="update_task">
      <input type="hidden" name="id" value="698">
      <input name="title" value="Crear cotizaci&oacute;n para Christian Mu&ntilde;iz">
      <input name="type" value="asignada">
      <input name="est_min" type="number" value="120">
      <select name="priority"><option value="1" selected>Alta</option><option value="2">Media</option><option value="3">Baja</option></select>
      <textarea name="context">Contexto: propuesta comercial que depende de Aleks.</textarea>
      <textarea name="client_context"></textarea>
      <div class="note">🤝 Solicitada por <b>Arturo Garc&iacute;a</b> · cliente: <b>Prisma</b></div>
      <span class="pill">done</span>
    </form>
  </div>
  <div class="frame adm-task" data-id="712">
    <span class="rank">2</span>
    <form method="post">
      <input type="hidden" name="_form" value="update_task">
      <input type="hidden" name="id" value="712">
      <input name="title" value="Revisar el login de la app">
      <input name="type" value="propia">
      <input name="est_min" type="number" value="60">
      <select name="priority"><option value="1">Alta</option><option value="2" selected>Media</option></select>
      <textarea name="context"></textarea>
      <div class="note">sem. del 08-17</div>
      <span class="pill">pendiente</span>
    </form>
  </div>
</div>`;

const USER_SELECT_HTML = `
<form method="get">
  <select name="u" onchange="this.form.submit()">
    <option value="aleks" selected>Aleks Garc&iacute;a — CEO / Founder</option>
    <option value="arturo" >Arturo Garc&iacute;a — Desarrollo</option>
    <option value="paul" >PAUL — Coach IA</option>
  </select>
</form>`;

/** admin/people.php — `aleks` is an admin, so no delete form is rendered for him. */
const PEOPLE_HTML = `
<form method="post">
  <input type="hidden" name="_form" value="update_user">
  <input type="hidden" name="uid" value="aleks">
  <input name="name" value="Aleks Garc&iacute;a">
  <input name="role" value="CEO / Founder">
  <input name="email" type="email" value="aleks@iventas.com">
  <input type="checkbox" name="is_admin" checked>
</form>
<form method="post">
  <input type="hidden" name="_form" value="update_user">
  <input type="hidden" name="uid" value="antonio">
  <input name="name" value="Antonio">
  <input name="role" value="Desarrollo">
  <input name="email" type="email" value="antonio@iventas.com">
  <input type="checkbox" name="is_admin">
</form>
<form method="post" onsubmit="return confirm('¿Eliminar a Antonio?')">
  <input type="hidden" name="_form" value="delete_user"><input type="hidden" name="uid" value="antonio">
  <button class="btn-sm btn-danger">Eliminar</button>
</form>`;

const KPI_HTML = `
<div class="kpi">
  <div class="k-lbl">Tareas completadas</div>
</div>
<div class="kpi">
  <div class="k-lbl">🚩 Focos rojos</div>
</div>`;

describe("parseTables", () => {
  it("extracts headers and rows from the red-flags table", () => {
    const [table] = parseTables(REDFLAGS_HTML);

    expect(table.section).toBe("🚩 Focos rojos");
    expect(table.headers).toEqual(["Colaborador", "Esta semana", "Pendientes", "Histórico"]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[1]).toEqual(["Aleks García", "🔴", "—", "17"]);
  });

  it("GOTCHA: the weekly red-flag count is repeated 🔴 glyphs, never a digit", () => {
    const [table] = parseTables(REDFLAGS_HTML);
    const weekly = (cell: string): number =>
      Array.from(cell).filter((ch) => ch === "🔴").length;

    // Reading the cell as a number is the trap: Number("🔴🔴🔴🔴🔴") is NaN.
    expect(Number(table.rows[0][1])).toBeNaN();
    expect(weekly(table.rows[0][1])).toBe(5);
    expect(weekly(table.rows[1][1])).toBe(1);
    // An em dash means zero flags this week — not a missing value.
    expect(weekly(table.rows[2][1])).toBe(0);
    // The historic column, by contrast, really is a number.
    expect(Number(table.rows[2][3])).toBe(18);
  });

  it("GOTCHA: forecast balances use U+2212 MINUS SIGN, not an ASCII hyphen", () => {
    const [table] = parseTables(FORECAST_HTML);
    const balance = table.rows[0][6];

    expect(balance).toBe("−98.7h");
    expect(balance.charCodeAt(0)).toBe(0x2212);
    expect(balance.includes("-")).toBe(false); // an ASCII '-' check silently fails
    expect(Number.parseFloat(balance)).toBeNaN(); // and so does a naive parse
    expect(Number.parseFloat(balance.replace(/−/g, "-"))).toBeCloseTo(-98.7);
  });

  it("keeps the real factor readable in the collaborator cell", () => {
    const [table] = parseTables(FORECAST_HTML);
    expect(table.rows[0][1]).toContain("factor 2.15x (n=45)");
  });

  it("returns an empty list for a page with zero tables", () => {
    expect(parseTables("<h2>Nada por aquí</h2><p>sin tablas</p>")).toEqual([]);
  });

  it("keeps a table that has no <th> at all, with empty headers", () => {
    const tables = parseTables("<table><tr><td>a</td><td>b</td></tr></table>");
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual([]);
    expect(tables[0].rows).toEqual([["a", "b"]]);
  });

  it("does not throw on unclosed tags", () => {
    expect(() =>
      parseTables("<table><tr><td>a<td>b</tr><table><h2>roto"),
    ).not.toThrow();
  });
});

describe("parseHeadings / parseKpis", () => {
  it("lists every h1/h2 in document order", () => {
    expect(parseHeadings(REDFLAGS_HTML)).toEqual(["PAUL · admin", "🚩 Focos rojos"]);
  });

  it("reads the KPI tiles", () => {
    expect(parseKpis(KPI_HTML)).toEqual(["Tareas completadas", "🚩 Focos rojos"]);
  });

  it("returns empty lists for a page with neither", () => {
    expect(parseHeadings("<p>hola</p>")).toEqual([]);
    expect(parseKpis("<p>hola</p>")).toEqual([]);
  });
});

describe("parseAdminTasks", () => {
  it("parses both mission cards with their fields", () => {
    const tasks = parseAdminTasks(TASK_CARD_HTML);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: 698,
      title: "Crear cotización para Christian Muñiz",
      type: "asignada",
      estMin: 120,
      priority: 1,
      status: "done",
      rank: 1,
      requester: "Arturo García",
      client: "Prisma",
    });
    expect(tasks[1]).toMatchObject({
      id: 712,
      priority: 2,
      status: "pendiente",
      rank: 2,
      week: "08-17",
      context: "",
    });
  });

  it("returns an empty board when the collaborator has no tasks", () => {
    expect(parseAdminTasks('<div id="admTasks"></div>')).toEqual([]);
  });

  it("does not throw on a card with unclosed tags and missing fields", () => {
    const broken = '<div class="adm-task" data-id="9"><form><input name="title" value="x">';
    expect(() => parseAdminTasks(broken)).not.toThrow();
    const [task] = parseAdminTasks(broken);
    expect(task.id).toBe(9);
    expect(task.estMin).toBeNull();
    expect(task.status).toBeNull();
  });
});

describe("parseAdminPeople", () => {
  it("reads uid, name, email, role and the admin flag", () => {
    const people = parseAdminPeople(PEOPLE_HTML);

    expect(people.map((p) => p.uid)).toEqual(["aleks", "antonio"]);
    expect(people[0]).toMatchObject({
      name: "Aleks García",
      email: "aleks@iventas.com",
      role: "CEO / Founder",
      isAdmin: true,
    });
  });

  it("marks as protected exactly the people with no delete form (the admins)", () => {
    const people = parseAdminPeople(PEOPLE_HTML);
    expect(people[0].protected).toBe(true); // admin: the panel renders no delete form
    expect(people[1].protected).toBe(false);
  });

  it("does not throw on a person form with no email", () => {
    const html =
      '<form><input type="hidden" name="_form" value="update_user">' +
      '<input type="hidden" name="uid" value="nemail"><input name="name" value="Sin Correo"></form>';
    expect(() => parseAdminPeople(html)).not.toThrow();
    expect(parseAdminPeople(html)[0]).toMatchObject({ uid: "nemail", email: null });
  });

  it("returns an empty roster when there are no person forms", () => {
    expect(parseAdminPeople("<h2>Personas</h2>")).toEqual([]);
  });
});

describe("parseSelectOptions", () => {
  it("reads the uid roster from the tasks page select", () => {
    expect(parseSelectOptions(USER_SELECT_HTML, "u")).toEqual([
      { value: "aleks", label: "Aleks García — CEO / Founder" },
      { value: "arturo", label: "Arturo García — Desarrollo" },
      { value: "paul", label: "PAUL — Coach IA" },
    ]);
  });

  it("returns an empty list when the select is absent", () => {
    expect(parseSelectOptions(USER_SELECT_HTML, "nope")).toEqual([]);
  });
});

describe("decodeEntities", () => {
  it("decodes a decimal numeric entity", () => {
    expect(decodeEntities("Garc&#237;a")).toBe("García");
  });

  it("decodes a hexadecimal numeric entity", () => {
    expect(decodeEntities("Garc&#xED;a")).toBe("García");
  });

  it("leaves an out-of-range decimal entity untouched instead of throwing", () => {
    // U+110000 is one past the last legal code point.
    expect(decodeEntities("a&#1114112;b")).toBe("a&#1114112;b");
    expect(decodeEntities("&#99999999999999999999999;")).toBe(
      "&#99999999999999999999999;",
    );
  });

  it("leaves an out-of-range hex entity untouched instead of throwing", () => {
    expect(decodeEntities("a&#x110000;b")).toBe("a&#x110000;b");
    expect(decodeEntities("&#XFFFFFFFFFF;")).toBe("&#XFFFFFFFFFF;");
  });

  it("keeps parsing the rest of a page that contains a bad entity", () => {
    const html = `<table><tr><td>&#1114112;</td><td>Aleks Garc&iacute;a</td></tr></table>`;
    expect(parseTables(html)[0].rows).toEqual([["&#1114112;", "Aleks García"]]);
  });
});

describe("stripTags / isAdminLoginPage", () => {
  it("drops scripts and decodes entities", () => {
    const text = stripTags('<script>var a = 1 < 2;</script><p>Aleks Garc&iacute;a &amp; co</p>');
    expect(text).toBe("Aleks García & co");
  });

  it("detects the login screen the panel serves with status 200", () => {
    expect(isAdminLoginPage('<input type="hidden" name="_form" value="login">')).toBe(true);
    expect(isAdminLoginPage(REDFLAGS_HTML)).toBe(false);
  });
});
