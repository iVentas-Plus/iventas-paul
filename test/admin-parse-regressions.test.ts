import { describe, expect, it } from "vitest";
import { parseAdminPeople, parseKpis } from "../src/admin-parse.js";

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
});
