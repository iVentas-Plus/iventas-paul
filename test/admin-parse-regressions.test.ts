import { describe, expect, it } from "vitest";
import {
  parseAdminPeople,
  parseAdminTasks,
  parseKpis,
  selectedValue,
} from "../src/admin-parse.js";

/**
 * Both defects below shipped past a green suite and were caught only by
 * running the parsers against the live panel. The fixtures here reproduce the
 * exact markup shapes that exposed them.
 */

/** Two collaborators as people.php really renders them: several sibling forms per card. */
const PEOPLE_HTML = `
<div class="frame card">
  <form method="post">
    <input type="hidden" name="_form" value="create_user">
    <input name="uid" value="">
    <input name="name" value="">
  </form>
</div>
<div class="frame card">
  <form method="post">
    <input type="hidden" name="_form" value="update_user">
    <input type="hidden" name="uid" value="aleks">
    <input name="name" value="Aleks García">
    <input name="role" value="CEO / Founder">
    <input name="email" value="aleks@iventas.com">
    <input type="checkbox" name="is_admin" value="1" checked>
  </form>
  <form method="post" style="display:inline">
    <input type="hidden" name="_form" value="reset_pin">
    <input type="hidden" name="uid" value="aleks">
    <button>Generar nueva contraseña</button>
  </form>
</div>
<div class="frame card">
  <form method="post">
    <input type="hidden" name="_form" value="update_user">
    <input type="hidden" name="uid" value="antonio">
    <input name="name" value="Antonio">
    <input name="role" value="Desarrollo">
    <input name="email" value="antonio@iventas.com">
    <input type="checkbox" name="is_admin" value="1">
  </form>
  <form method="post" style="display:inline">
    <input type="hidden" name="_form" value="delete_user">
    <input type="hidden" name="uid" value="antonio">
    <button>Eliminar</button>
  </form>
</div>`;

describe("parseAdminPeople — sibling forms must not bleed into each other", () => {
  const people = parseAdminPeople(PEOPLE_HTML);

  it("pairs each uid with its OWN name", () => {
    // The original lazy `<form>…update_user…</form>` pattern skipped across a
    // closing tag to find its anchor, which paired one person's uid with the
    // next person's name. Against production that produced
    // "alice | Arturo García".
    expect(people.map((p) => [p.uid, p.name])).toEqual([
      ["aleks", "Aleks García"],
      ["antonio", "Antonio"],
    ]);
  });

  it("ignores the blank create_user form at the top of the page", () => {
    expect(people).toHaveLength(2);
    expect(people.map((p) => p.uid)).not.toContain("");
  });

  it("reads is_admin from the person's own checkbox", () => {
    expect(people[0].isAdmin).toBe(true);
    expect(people[1].isAdmin).toBe(false);
  });

  it("marks as protected exactly the people with no delete form", () => {
    // This is the only signal the panel gives: it renders no delete form for
    // administrators.
    expect(people[0].protected).toBe(true);
    expect(people[1].protected).toBe(false);
  });

  it("keeps role and email attached to the right person", () => {
    expect(people[0].email).toBe("aleks@iventas.com");
    expect(people[1].role).toBe("Desarrollo");
  });
});

describe("parseKpis — the panel prints headline numbers in two shapes", () => {
  it("reads the <div class='kpi'> tiles used by index.php", () => {
    const html = `<div class="kpi"><b>243</b> Tareas completadas</div>
                  <div class="kpi"><b>84</b> Focos rojos</div>`;

    expect(parseKpis(html)).toEqual(["243 Tareas completadas", "84 Focos rojos"]);
  });

  it("reads the px/note pairs used by redflags.php, pulse.php and kicked.php", () => {
    // Reading only the `kpi` shape returned an empty array for every page that
    // answers "how is the team doing" — silently, as if there were no numbers.
    const html = `<div style="display:flex; gap:26px">
      <div><div class="px" style="font-size:20px">18</div><div class="note">esta semana</div></div>
      <div><div class="px" style="font-size:20px">11</div><div class="note">colaboradores con focos</div></div>
    </div>`;

    expect(parseKpis(html)).toEqual(["18 esta semana", "11 colaboradores con focos"]);
  });

  it("returns an empty array for a page with no headline numbers at all", () => {
    expect(parseKpis("<h1>Retrasos</h1><table><tr><td>x</td></tr></table>")).toEqual([]);
  });

  it("keeps the value when the tile splits label and value into sibling divs", () => {
    // A lazy `<div class="kpi">([\s\S]*?)</div>` stops at the FIRST `</div>`,
    // which is the label's. The number — the only thing the tile exists for —
    // was dropped, and the caller could not tell an empty tile from a parsed
    // one.
    const html = `<div class="kpi">
      <div class="k-lbl">Tareas completadas</div>
      <div class="k-val">243</div>
    </div>`;

    expect(parseKpis(html)).toEqual(["Tareas completadas 243"]);
  });

  it("does not swallow the rest of the page when a tile is never closed", () => {
    // Malformed markup must degrade to the old behaviour (stop at the first
    // close) instead of returning the whole document as one giant tile.
    const html = `<div class="kpi"><b>7</b> abiertas<footer>pie de página</footer>`;

    expect(parseKpis(html)).toEqual(["7 abiertas pie de página"]);
  });
});

/**
 * `admin/tasks.php` renders one `<div class="... adm-task" data-id="N">` card
 * per mission. Splitting on the card's opening tag left the LAST card running
 * to the end of the document, so everything printed after it — footer, other
 * sections, the page's own chrome — was read as if it belonged to that card.
 */
const TRAILING_FOOTER_HTML = `
<div id="admTasks">
  <div class="frame adm-task" data-id="698">
    <form method="post">
      <input name="title" value="Primera">
      <div class="note">🤝 Solicitada por <b>Arturo García</b> · cliente: <b>Prisma</b></div>
      <span class="pill">done</span>
    </form>
  </div>
  <div class="frame adm-task" data-id="712">
    <form method="post">
      <input name="title" value="Segunda">
      <span class="pill">pendiente</span>
    </form>
  </div>
</div>
<div class="foot">
  🤝 Solicitada por <b>Nadie</b> · cliente: <b>Ajeno</b> · sem. del 01-01
</div>`;

describe("parseAdminTasks — a card must end where the card ends", () => {
  const tasks = parseAdminTasks(TRAILING_FOOTER_HTML);

  it("still finds both cards", () => {
    expect(tasks.map((t) => [t.id, t.title])).toEqual([
      [698, "Primera"],
      [712, "Segunda"],
    ]);
  });

  it("does not attribute the page footer to the last card", () => {
    expect(tasks[1].requester).toBeNull();
    expect(tasks[1].client).toBeNull();
    expect(tasks[1].week).toBeNull();
  });

  it("keeps reading the fields the card really carries", () => {
    expect(tasks[0].requester).toBe("Arturo García");
    expect(tasks[0].client).toBe("Prisma");
    expect(tasks[0].status).toBe("done");
    expect(tasks[1].status).toBe("pendiente");
  });
});

describe("selectedValue — attribute order is not a contract", () => {
  it("reads the value when `selected` comes BEFORE `value`", () => {
    // HTML puts no order on attributes. Requiring `value="…"` first made the
    // function return null for a perfectly valid option, and parseAdminTasks
    // then reported `priority: null` for a card that has a priority.
    const html = `<select name="priority">
      <option value="1">Alta</option>
      <option selected value="2">Media</option>
    </select>`;

    expect(selectedValue(html, "priority")).toBe("2");
  });

  it("still reads the value when `value` comes first", () => {
    const html = `<select name="priority">
      <option value="1" selected>Alta</option>
      <option value="2">Media</option>
    </select>`;

    expect(selectedValue(html, "priority")).toBe("1");
  });

  it("returns null when no option is selected", () => {
    expect(selectedValue(`<select name="priority"><option value="1">Alta</option></select>`, "priority")).toBeNull();
  });

  it("does not let a later select's selection leak into an earlier one", () => {
    const html = `<select name="priority"><option value="1">Alta</option></select>
      <select name="type"><option selected value="propia">Propia</option></select>`;

    expect(selectedValue(html, "priority")).toBeNull();
    expect(selectedValue(html, "type")).toBe("propia");
  });
});
