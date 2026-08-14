/**
 * Read-only MCP tools over PAUL's admin panel.
 *
 * Everything here goes through PaulAdminClient, which owns the session and the
 * HTML fetching; these tools only choose a page, parse it and shape the result.
 * They never enter a `view_as` impersonation — a session left inside one cannot
 * write anything and cannot even log in again, so any impersonation must go
 * through `PaulAdminClient.withViewAs`, never a bare viewAs/viewSelf pair.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaulAdminClient } from "../admin-client.js";
import { ADMIN_PAGES, TEAM_WIDE_PAGES } from "../admin-client.js";
import {
  parseHeadings,
  parseKpis,
  parseTables,
  parseAdminTasks,
  parseSelectOptions,
  stripTags,
} from "../admin-parse.js";
import { textResult, errorResult, type ToolResult } from "./shared.js";

/** Hard cap on the free-text projection of a page, in characters. */
export const MAX_TEXT_CHARS = 4000;

/** The `<select name="u">` on admin/tasks.php is the panel's roster of uids. */
const USER_SELECT_NAME = "u";

export interface TruncatedText {
  text: string;
  /** Present only when the original text did not fit in MAX_TEXT_CHARS. */
  note?: string;
}

/** stripTags output capped at MAX_TEXT_CHARS, with an explicit note when cut. */
export function truncateText(html: string): TruncatedText {
  const text = stripTags(html);
  if (text.length <= MAX_TEXT_CHARS) return { text };
  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    note:
      `TRUNCATED: the page's text is ${text.length} characters and only the first ` +
      `${MAX_TEXT_CHARS} are returned. Use the tables/headings fields, or a dedicated ` +
      "tool, for the structured content.",
  };
}

/** Rejects a page name that is not one of the panel's real pages. */
function unknownPageResult(page: string): ToolResult {
  return textResult(
    {
      error: true,
      message:
        `"${page}" is not an admin page of PAUL. No request was made. Valid pages: ` +
        `${ADMIN_PAGES.join(", ")}.`,
    },
    true,
  );
}

const STATUS_DESCRIPTION =
  "Read one of PAUL's TEAM-WIDE admin pages — the ones that show every " +
  "collaborator in a single request, with no per-person parameter. Returns " +
  "{ headings, kpis, tables }, tables being header + row text exactly as the " +
  "panel prints them. What each page gives: forecast = per person the open " +
  "task count, estimated hours vs projected hours, remaining capacity, the " +
  "balance, and the real factor (how much longer that person actually takes " +
  "than estimated); delays = current delays, historic late deliveries and " +
  "accumulated delay; redflags = red flags this week and historic; pulse = " +
  "tasks closed, messages and deletions per period (pass params {p:'week'}, " +
  "'day' or 'month'); commitments = the commitment scoreboard (params " +
  "{f:'all'} to drop the filter); kicked = starved tasks, the ones repeatedly " +
  "pushed down and never started; history = the weekly ranking (params " +
  "{ym:'2026-08'} for another month). TWO PARSING GOTCHAS you must handle: " +
  "(1) on redflags the weekly count is NOT a digit — it is rendered as " +
  "repeated 🔴 glyphs, so count the glyphs (a '—' means zero); the historic " +
  "column IS a number. (2) forecast balances use U+2212 MINUS SIGN (−), not " +
  "an ASCII hyphen, so a naive parseFloat or a '-' comparison silently fails " +
  "— normalize the character before treating a balance as negative.";

export function registerAdminStatusTool(
  server: McpServer,
  admin: Pick<PaulAdminClient, "page">,
): void {
  server.registerTool(
    "paul_admin_status",
    {
      title: "Read a team-wide PAUL admin page",
      description: STATUS_DESCRIPTION,
      inputSchema: {
        page: z.enum(TEAM_WIDE_PAGES).describe("Team-wide admin page to read"),
        params: z
          .record(z.string())
          .optional()
          .describe(
            "Query string parameters, e.g. {p:'week'} for pulse, {ym:'2026-08'} " +
              "for history, {f:'all'} for commitments",
          ),
      },
    },
    async ({ page, params }) => {
      try {
        const html = await admin.page(page, params);
        return textResult({
          page,
          params: params ?? {},
          headings: parseHeadings(html),
          kpis: parseKpis(html),
          tables: parseTables(html),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

const TASKS_DESCRIPTION =
  "Read a collaborator's mission board from the admin panel. This is the ONLY " +
  "way to see everyone's tasks: the panel has no all-users view — admin/" +
  "tasks.php is scoped to one person via ?u=<uid> — and the JSON API only ever " +
  "returns the authenticated user's own tasks. With `uid`, returns that " +
  "person's board. WITHOUT `uid`, it sweeps every uid in the panel's own user " +
  "list and returns every board plus a per-person count summary; that sweep " +
  "costs ONE HTTP REQUEST PER PERSON, so pass a uid whenever you already know " +
  "it. Each task carries id, title, type, estMin, priority (1=alta), status " +
  "pill, rank (the queue position the collaborator sees), context, client, " +
  "requester and week.";

export function registerAdminTasksTool(
  server: McpServer,
  admin: Pick<PaulAdminClient, "page" | "tasksPage">,
): void {
  server.registerTool(
    "paul_admin_tasks",
    {
      title: "Read PAUL task boards (any collaborator)",
      description: TASKS_DESCRIPTION,
      inputSchema: {
        uid: z
          .string()
          .optional()
          .describe("Collaborator uid (e.g. 'arturo'). Omit to sweep everyone."),
      },
    },
    async ({ uid }) => {
      try {
        if (uid) {
          const tasks = parseAdminTasks(await admin.tasksPage(uid));
          return textResult({ uid, total: tasks.length, tasks });
        }
        return textResult(await sweepAllBoards(admin));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export interface BoardSweep {
  swept: number;
  summary: Array<{ uid: string; name: string; total: number }>;
  boards: Array<{ uid: string; name: string; tasks: ReturnType<typeof parseAdminTasks> }>;
}

/** One request to learn the roster, then one per collaborator. */
async function sweepAllBoards(
  admin: Pick<PaulAdminClient, "page" | "tasksPage">,
): Promise<BoardSweep | { error: true; message: string }> {
  const roster = parseSelectOptions(await admin.page("tasks"), USER_SELECT_NAME).filter(
    (o) => o.value !== "",
  );
  if (roster.length === 0) {
    return {
      error: true,
      message:
        "admin/tasks.php did not expose its user list, so there is no roster to " +
        "sweep. Pass an explicit uid.",
    };
  }
  const boards: BoardSweep["boards"] = [];
  for (const person of roster) {
    const tasks = parseAdminTasks(await admin.tasksPage(person.value));
    boards.push({ uid: person.value, name: person.label, tasks });
  }
  return {
    swept: boards.length,
    summary: boards.map((b) => ({ uid: b.uid, name: b.name, total: b.tasks.length })),
    boards,
  };
}

const PAGE_DESCRIPTION =
  "Generic escape hatch: read ANY page of PAUL's admin panel and get " +
  "{ headings, kpis, tables, text }. Use it for the pages with no dedicated " +
  "tool — checkpoints, queue, summary, persona, clients, findings, rescate, " +
  "objectives, context, knowledge, radar, usage, settings, index, hoy — or " +
  "when you need the free text a table extractor drops. `text` is the whole " +
  `page stripped of markup and TRUNCATED to ${MAX_TEXT_CHARS} characters; when it is cut, ` +
  "a `note` field says so, and the structured fields still cover the tables. " +
  "Valid page names: " +
  ADMIN_PAGES.join(", ") +
  ". Anything else is rejected without making a request.";

export function registerAdminPageTool(
  server: McpServer,
  admin: Pick<PaulAdminClient, "page">,
): void {
  server.registerTool(
    "paul_admin_page",
    {
      title: "Read any PAUL admin page",
      description: PAGE_DESCRIPTION,
      inputSchema: {
        page: z.string().describe(`Admin page name, one of: ${ADMIN_PAGES.join(", ")}`),
        params: z.record(z.string()).optional().describe("Query string parameters"),
      },
    },
    async ({ page, params }) => {
      if (!(ADMIN_PAGES as readonly string[]).includes(page)) return unknownPageResult(page);
      try {
        const html = await admin.page(page, params);
        return textResult({
          page,
          params: params ?? {},
          headings: parseHeadings(html),
          kpis: parseKpis(html),
          tables: parseTables(html),
          ...truncateText(html),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

const ASK_DESCRIPTION =
  "Ask PAUL's own copilot a natural-language question over the WHOLE admin " +
  "dataset. It is the only endpoint in the panel that answers free-form " +
  "questions across every table at once, so use it for cross-cutting " +
  "questions no single page answers ('who is most overloaded and why', 'which " +
  "clients concentrate the delays'). It SPENDS AI BUDGET on every call, and " +
  "budget exhaustion degrades PAUL for the whole team — prefer a page tool " +
  "when a page already answers the question. Ask in Spanish; PAUL answers in " +
  "Spanish. The answer is generated prose, not a query result: verify any " +
  "number it states against paul_admin_status or paul_admin_page before " +
  "acting on it.";

export function registerAdminAskTool(
  server: McpServer,
  admin: Pick<PaulAdminClient, "ask">,
): void {
  server.registerTool(
    "paul_admin_ask",
    {
      title: "Ask PAUL's admin copilot",
      description: ASK_DESCRIPTION,
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe("Question about the team, in Spanish (e.g. '¿quién va más retrasado?')"),
      },
    },
    async ({ question }) => {
      try {
        return textResult({ question, answer: await admin.ask(question) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export { unknownPageResult };
