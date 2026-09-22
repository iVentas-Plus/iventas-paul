/**
 * Minimal HTML extraction for PAUL's admin panel.
 *
 * The panel is server-rendered PHP with no JSON API and no contract: the only
 * way to read it is to parse what it prints. These helpers deliberately stay
 * generic — one table extractor that works on every page — instead of a
 * bespoke parser per page, because bespoke parsers are debt that breaks on the
 * next markup tweak with no test able to notice.
 *
 * No new dependency: the project ships only the MCP SDK and zod, and a DOM
 * parser is not worth pulling in for tag-stripping and row splitting.
 */
const ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ntilde: "ñ",
    aacute: "á",
    eacute: "é",
    iacute: "í",
    oacute: "ó",
    uacute: "ú",
    uuml: "ü",
    Ntilde: "Ñ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    middot: "·",
};
/** Highest legal Unicode code point; String.fromCodePoint throws above it. */
const MAX_CODE_POINT = 0x10ffff;
/**
 * Turns a numeric entity's value into its character, or gives the entity back
 * unchanged when the value is not a usable code point.
 *
 * `String.fromCodePoint` throws `RangeError` for anything above U+10FFFF, for
 * a negative value and for `NaN`. Left unguarded that exception escapes the
 * `replace` callback and aborts the parse of the ENTIRE page, so one malformed
 * entity costs every table on it. Today PAUL escapes its output with
 * `htmlspecialchars`, which never emits such an entity, but a guard is one
 * comparison and the failure mode it prevents is total.
 */
function codePointOrOriginal(value, original) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_CODE_POINT)
        return original;
    return String.fromCodePoint(value);
}
/** Decodes the HTML entities PAUL actually emits, including numeric ones. */
export function decodeEntities(input) {
    return input
        .replace(/&#(\d+);/g, (m, code) => codePointOrOriginal(Number(code), m))
        .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, hex) => codePointOrOriginal(parseInt(hex, 16), m))
        .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}
/** Drops <script>/<style> blocks and every tag, leaving collapsed text. */
export function stripTags(html) {
    const withoutBlocks = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    return decodeEntities(withoutBlocks.replace(/<[^>]+>/g, " "))
        .replace(/[ \t ]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
}
/** Text of a single cell: tags stripped, entities decoded, whitespace collapsed. */
function cellText(html) {
    return stripTags(html).replace(/\s+/g, " ").trim();
}
/**
 * The body of a `<div>` whose opening tag ends at `from`, delimited by the
 * `</div>` that actually closes it rather than by the first one encountered.
 *
 * A lazy `<div …>([\s\S]*?)</div>` stops at the first close, so any nested
 * `<div>` truncates the block: a KPI tile loses its value, and a task card
 * loses everything after its first inner element. The opposite mistake —
 * matching greedily — swallows the rest of the page. Counting is the only
 * reading of the markup that is right in both shapes.
 *
 * Unbalanced markup (an opening tag the document never closes) falls back to
 * the first `</div>`, i.e. the previous behaviour, so a malformed page still
 * yields a bounded fragment instead of the whole document.
 */
function divBody(html, from) {
    // Built per call on purpose: a shared /g regex carries `lastIndex` between
    // calls, and the callers here already drive their own /g scans. One regex
    // per tile is nothing next to a parser that could silently mis-slice a card.
    const tagRe = /<(\/?)div\b[^>]*>/gi;
    tagRe.lastIndex = from;
    let depth = 1;
    let tag;
    while ((tag = tagRe.exec(html)) !== null) {
        depth += tag[1] === "/" ? -1 : 1;
        if (depth === 0)
            return html.slice(from, tag.index);
    }
    const firstClose = html.slice(from).search(/<\/div\b/i);
    return firstClose === -1 ? html.slice(from) : html.slice(from, from + firstClose);
}
/**
 * Extracts every table on the page as headers + rows of plain text, tagged
 * with the heading that precedes it. Works uniformly across redflags, delays,
 * pulse, forecast, commitments, kicked, usage and settings.
 *
 * Caveats worth knowing when reading the output: the weekly red-flag count is
 * rendered as repeated 🔴 glyphs rather than a digit, and forecast balances
 * use U+2212 MINUS SIGN, not an ASCII hyphen.
 */
export function parseTables(html) {
    const tables = [];
    const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
    let match;
    while ((match = tableRe.exec(html)) !== null) {
        const body = match[1];
        const rows = [];
        let headers = [];
        const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRe.exec(body)) !== null) {
            const cells = [];
            let isHeader = false;
            const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
            let cellMatch;
            while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
                if (cellMatch[1].toLowerCase() === "th")
                    isHeader = true;
                cells.push(cellText(cellMatch[2]));
            }
            if (cells.length === 0)
                continue;
            if (isHeader && headers.length === 0)
                headers = cells;
            else
                rows.push(cells);
        }
        if (headers.length === 0 && rows.length === 0)
            continue;
        tables.push({ section: headingBefore(html, match.index), headers, rows });
    }
    return tables;
}
/** The text of the closest <h1>/<h2> appearing before `index` in the document. */
function headingBefore(html, index) {
    const before = html.slice(0, index);
    const headingRe = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi;
    let last = null;
    let m;
    while ((m = headingRe.exec(before)) !== null)
        last = cellText(m[1]);
    return last;
}
/** Every <h1>/<h2> on the page, in order — a cheap outline of what it contains. */
export function parseHeadings(html) {
    const out = [];
    const re = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const text = cellText(m[1]);
        if (text)
            out.push(text);
    }
    return out;
}
/**
 * The headline numbers of a page.
 *
 * The panel prints these in TWO different shapes and neither is a superset of
 * the other, so both are read: `index.php` uses `<div class="kpi">`, while
 * `pulse.php`, `redflags.php` and `kicked.php` use a
 * `<div class="px">value</div><div class="note">label</div>` pair. Reading
 * only the first shape silently returns nothing on the pages that answer the
 * "how is the team doing" question.
 */
export function parseKpis(html) {
    const out = [];
    // The tile is located by its OPENING tag; its end is found by counting, so a
    // tile that splits label and value into sibling divs keeps both. Scanning
    // resumes past the whole tile, so a nested `kpi` is never counted twice.
    const tileRe = /<div\b[^>]*class="[^"]*\bkpi\b[^"]*"[^>]*>/gi;
    let m;
    while ((m = tileRe.exec(html)) !== null) {
        const bodyStart = m.index + m[0].length;
        const body = divBody(html, bodyStart);
        tileRe.lastIndex = bodyStart + body.length;
        const text = cellText(body);
        if (text)
            out.push(text);
    }
    const pairRe = /<div\b[^>]*class="px"[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class="note"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = pairRe.exec(html)) !== null) {
        const value = cellText(m[1]);
        const label = cellText(m[2]);
        if (value || label)
            out.push(`${value} ${label}`.trim());
    }
    return out;
}
/**
 * True when the response is the admin login screen rather than a real page.
 * The panel answers 200 with this form instead of a 401, so status codes
 * cannot be used to detect an expired session.
 */
export function isAdminLoginPage(html) {
    return /name="_form"\s+value="login"/i.test(html);
}
/** Escapes a field name for literal use inside a RegExp (dept[7] has brackets). */
function escapeRe(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Options of a named <select>, in document order. */
export function parseSelectOptions(html, name) {
    const selectRe = new RegExp(`<select\\b[^>]*name="${escapeRe(name)}"[^>]*>([\\s\\S]*?)</select>`, "i");
    const block = selectRe.exec(html);
    if (!block)
        return [];
    const out = [];
    const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let m;
    while ((m = optRe.exec(block[1])) !== null) {
        const valueMatch = /value="([^"]*)"/i.exec(m[1]);
        // objectives.php renders options with no value attribute at all; the
        // browser then submits the option's text, so mirror that here.
        const label = cellText(m[2]);
        out.push({ value: valueMatch ? decodeEntities(valueMatch[1]) : label, label });
    }
    return out;
}
/**
 * Parses the mission cards of `admin/tasks.php`, which is scoped to a single
 * collaborator via `?u=<uid>`. Each card is a form-bearing
 * `<div class="... adm-task" data-id="N">`.
 */
export function parseAdminTasks(html) {
    const out = [];
    // Each card is bounded by the `</div>` that closes its own opening tag.
    // Splitting on the opening tag instead (as this used to) ended every card at
    // the NEXT card, which left the last one running to the end of the document:
    // `client`, `requester`, `week` and the status pill then read the page
    // footer as if it were part of the mission.
    const cardRe = /<div\b[^>]*\bdata-id="(\d+)"[^>]*>/gi;
    let match;
    while ((match = cardRe.exec(html)) !== null) {
        const id = Number(match[1]);
        const bodyStart = match.index + match[0].length;
        const card = divBody(html, bodyStart);
        cardRe.lastIndex = bodyStart + card.length;
        const plain = stripTags(card);
        out.push({
            id,
            title: inputValue(card, "title") ?? "",
            type: inputValue(card, "type") ?? "",
            estMin: numberOrNull(inputValue(card, "est_min")),
            priority: numberOrNull(selectedValue(card, "priority")),
            status: pillStatus(card),
            rank: numberOrNull(firstCapture(card, /<span\b[^>]*class="rank"[^>]*>(\d+)<\/span>/i)),
            context: textareaValue(card, "context") ?? "",
            client: firstCapture(plain, /cliente:\s*([^\n·]+)/i),
            requester: firstCapture(plain, /Solicitada por\s+([^\n·]+)/i),
            week: firstCapture(plain, /sem\.\s*del\s*([0-9-]+)/i),
        });
    }
    return out;
}
function firstCapture(source, re) {
    const m = re.exec(source);
    return m ? decodeEntities(m[1]).trim() : null;
}
function numberOrNull(value) {
    if (value === null || value.trim() === "")
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
/** The `value` of a named <input> inside a fragment. */
export function inputValue(html, name) {
    const re = new RegExp(`<input\\b[^>]*name="${escapeRe(name)}"[^>]*>`, "i");
    const tag = re.exec(html);
    if (!tag)
        return null;
    const value = /value="([^"]*)"/i.exec(tag[0]);
    return value ? decodeEntities(value[1]) : "";
}
/** The text content of a named <textarea> inside a fragment. */
export function textareaValue(html, name) {
    const re = new RegExp(`<textarea\\b[^>]*name="${escapeRe(name)}"[^>]*>([\\s\\S]*?)</textarea>`, "i");
    const m = re.exec(html);
    return m ? decodeEntities(m[1]).trim() : null;
}
/** The `value` of the selected <option> of a named <select>. */
export function selectedValue(html, name) {
    const selectRe = new RegExp(`<select\\b[^>]*name="${escapeRe(name)}"[^>]*>([\\s\\S]*?)</select>`, "i");
    const block = selectRe.exec(html);
    if (!block)
        return null;
    // Find the selected <option> FIRST, then read its value. Requiring
    // `value="…"` to appear before `selected` made a valid
    // `<option selected value="2">` parse as "nothing selected", and
    // parseAdminTasks reported `priority: null` for a card that has one. HTML
    // puts no order on attributes, so neither may this.
    const optRe = /<option\b([^>]*)>/gi;
    let opt;
    while ((opt = optRe.exec(block[1])) !== null) {
        if (!/\bselected\b/i.test(opt[1]))
            continue;
        const value = /value="([^"]*)"/i.exec(opt[1]);
        // An <option> with no value attribute submits its own text; that shape is
        // handled by parseSelectOptions, and here it simply has no value to give.
        return value ? decodeEntities(value[1]) : null;
    }
    return null;
}
/** The status pill PAUL prints on a task card (`done`, `pendiente`, `en curso`). */
function pillStatus(card) {
    const m = /<span\b[^>]*class="[^"]*\bpill\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(card);
    if (!m)
        return null;
    const text = cellText(m[1]);
    return text === "" ? null : text;
}
/**
 * Parses the collaborator cards of `admin/people.php`. Every person has an
 * `update_user` form carrying their uid; administrators are exactly the people
 * for whom no `delete_user` form is rendered.
 */
export function parseAdminPeople(html) {
    const forms = splitForms(html);
    const deletable = new Set();
    for (const form of forms) {
        if (inputValue(form, "_form") === "delete_user") {
            const uid = inputValue(form, "uid");
            if (uid)
                deletable.add(uid);
        }
    }
    const out = [];
    const seen = new Set();
    for (const form of forms) {
        if (inputValue(form, "_form") !== "update_user")
            continue;
        const uid = inputValue(form, "uid");
        if (!uid || seen.has(uid))
            continue;
        seen.add(uid);
        out.push({
            uid,
            name: inputValue(form, "name") ?? "",
            email: inputValue(form, "email"),
            role: inputValue(form, "role"),
            isAdmin: /<input\b[^>]*name="is_admin"[^>]*\bchecked\b/i.test(form),
            protected: !deletable.has(uid),
        });
    }
    return out;
}
/**
 * Splits a document into its individual `<form>` bodies.
 *
 * Done by segmenting on `</form>` and keeping what follows the LAST `<form`
 * in each segment, rather than with one regex per form. A lazy
 * `<form>([\s\S]*?)</form>` pattern that also has to match something inside
 * the body happily skips across a closing tag to find it, which silently
 * pairs one person's uid with the next person's name — a defect this
 * parser shipped with until real data exposed it.
 */
function splitForms(html) {
    const out = [];
    for (const segment of html.split(/<\/form>/i).slice(0, -1)) {
        const start = segment.toLowerCase().lastIndexOf("<form");
        if (start === -1)
            continue;
        out.push(segment.slice(start));
    }
    return out;
}
