/**
 * Mutating MCP tools over PAUL's admin panel.
 *
 * Every write here is a form POST to a LIVE panel with no undo and no approval
 * queue, so each tool validates its required fields BEFORE touching the
 * network and says so in the error when it refuses.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaulAdminClient } from "../admin-client.js";
import { ADMIN_PAGES } from "../admin-client.js";
import { parseHeadings, parseAdminTasks, parseAdminPeople } from "../admin-parse.js";
import { textResult, errorResult, type ToolResult } from "./shared.js";
import { truncateText, unknownPageResult } from "./admin-read.js";

/** Refusal made before any request: says what is missing and that nothing changed. */
function missingFieldResult(message: string): ToolResult {
  return textResult({ error: true, message: `${message} Nothing was sent.` }, true);
}

const TASK_WRITE_DESCRIPTION =
  "Create, edit, delete or complete a task for ANY collaborator, as an " +
  "administrator. Four actions: 'create' needs userUid + title; 'update' " +
  "needs id + title; 'delete' and 'complete' need id. Things that are easy to " +
  "get wrong: (1) THE ASSIGNEE IS `userUid` — the person the task is FOR. " +
  "`requesterUid` is a different thing: whoever ASKED for the task. Putting " +
  "the requester in userUid assigns the work to the wrong person. (2) " +
  "'update' CANNOT change the assignee and CANNOT change the status — the " +
  "panel exposes no field for either, so a task can only be reassigned by " +
  "deleting and recreating it. (3) 'delete' is a HARD ADMIN DELETE: it " +
  "removes the task immediately, with no approval queue and no undo (unlike a " +
  "collaborator's own delete request, which PAUL queues for review). (4) " +
  "'complete' closes the task WITHOUT a checkpoint — no evidence, no time " +
  "settled, no AI verdict. For the user's own finished work prefer the normal " +
  "flow (paul_start_task → paul_get_checkpoint → paul_submit_checkpoint); use " +
  "'complete' only to clean up something that will never get a checkpoint. " +
  "priority is 1=alta, 2=media, 3=baja; weeks is 0 for this week and 1..4 for " +
  "that many weeks ahead.";

export function registerAdminTaskWriteTool(
  server: McpServer,
  admin: Pick<PaulAdminClient, "addTask" | "updateTask" | "deleteTask" | "completeTask">,
): void {
  server.registerTool(
    "paul_admin_task_write",
    {
      title: "Create, edit, delete or complete any PAUL task",
      description: TASK_WRITE_DESCRIPTION,
      inputSchema: {
        action: z.enum(["create", "update", "delete", "complete"]).describe("What to do"),
        id: z.number().int().positive().optional().describe("Task id (update/delete/complete)"),
        userUid: z
          .string()
          .optional()
          .describe("create: uid of the ASSIGNEE — the person who will do the task"),
        title: z.string().optional().describe("Task title (create/update)"),
        type: z.string().optional().describe("Free-text task type, e.g. 'asignada'"),
        estMin: z.number().int().positive().optional().describe("Estimated minutes"),
        priority: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe("1=alta, 2=media, 3=baja"),
        weeks: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("create only: 0=this week, 1..4 weeks ahead"),
        context: z.string().optional().describe("Context PAUL's AI reads about the task"),
        requesterUid: z
          .string()
          .optional()
          .describe("create only: uid of whoever ASKED for the task (not the assignee)"),
        clientName: z.string().optional().describe("create only: client the task belongs to"),
        clientContext: z.string().optional().describe("update only: client context field"),
        clientKpis: z.string().optional().describe("update only: client KPIs, one per line"),
      },
    },
    async (args) => {
      try {
        return await runTaskWrite(admin, args as TaskWriteArgs);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export interface TaskWriteArgs {
  action: "create" | "update" | "delete" | "complete";
  id?: number;
  userUid?: string;
  title?: string;
  type?: string;
  estMin?: number;
  priority?: 1 | 2 | 3;
  weeks?: 0 | 1 | 2 | 3 | 4;
  context?: string;
  requesterUid?: string;
  clientName?: string;
  clientContext?: string;
  clientKpis?: string;
}

async function runTaskWrite(
  admin: Pick<PaulAdminClient, "addTask" | "updateTask" | "deleteTask" | "completeTask">,
  args: TaskWriteArgs,
): Promise<ToolResult> {
  const { action } = args;
  if (action === "create") {
    if (!args.userUid) {
      return missingFieldResult(
        "create needs `userUid`: the uid of the ASSIGNEE, the person the task is for.",
      );
    }
    if (!args.title) return missingFieldResult("create needs `title`.");
    const html = await admin.addTask({
      userUid: args.userUid,
      title: args.title,
      type: args.type,
      estMin: args.estMin,
      priority: args.priority,
      weeks: args.weeks,
      context: args.context,
      requesterUid: args.requesterUid,
      clientName: args.clientName,
    });
    return taskWriteResult(action, html, { assignee: args.userUid });
  }
  if (action === "update") {
    if (typeof args.id !== "number") return missingFieldResult("update needs `id`.");
    if (!args.title) {
      return missingFieldResult(
        "update needs `title`: the panel's edit form posts every field at once, so " +
          "omitting the title would blank it.",
      );
    }
    const html = await admin.updateTask({
      id: args.id,
      title: args.title,
      type: args.type,
      estMin: args.estMin,
      priority: args.priority,
      context: args.context,
      clientContext: args.clientContext,
      clientKpis: args.clientKpis,
    });
    return taskWriteResult(action, html, { id: args.id });
  }
  if (typeof args.id !== "number") return missingFieldResult(`${action} needs \`id\`.`);
  const html =
    action === "delete" ? await admin.deleteTask(args.id) : await admin.completeTask(args.id);
  return taskWriteResult(action, html, { id: args.id });
}

function taskWriteResult(
  action: string,
  html: string,
  extra: Record<string, unknown>,
): ToolResult {
  return textResult({
    ok: true,
    action,
    ...extra,
    headings: parseHeadings(html),
    board: parseAdminTasks(html),
  });
}

const PEOPLE_DESCRIPTION =
  "List, create, delete or reset the password of PAUL's collaborators. " +
  "'list' returns every person with uid, name, email, role, isAdmin and " +
  "`protected`. Two things the panel does not spell out: (1) there is NO " +
  "DEACTIVATE — the only removal is a hard delete, which is irreversible, so " +
  "for someone who has left there is no 'archive' option to prefer. (2) " +
  "ADMINISTRATORS CANNOT BE DELETED: the panel renders no delete form for " +
  "them, and that missing form is exactly how `protected: true` is detected, " +
  "so a person with protected:true will not be removed no matter what is " +
  "sent. 'create' needs uid + name; the uid is the identifier every other " +
  "admin tool takes, so choose it deliberately (short, lowercase, stable). " +
  "'reset_password' issues a fresh password — read it from the returned page " +
  "text, it is not shown again.";

export function registerAdminPeopleTool(
  server: McpServer,
  admin: Pick<
    PaulAdminClient,
    "peoplePage" | "createUser" | "deleteUser" | "resetPassword"
  >,
): void {
  server.registerTool(
    "paul_admin_people",
    {
      title: "Manage PAUL collaborators",
      description: PEOPLE_DESCRIPTION,
      inputSchema: {
        action: z.enum(["list", "create", "delete", "reset_password"]).describe("What to do"),
        uid: z.string().optional().describe("Collaborator uid (create/delete/reset_password)"),
        name: z.string().optional().describe("create: full name"),
        email: z.string().optional().describe("create: login email"),
        role: z.string().optional().describe("create: role label, e.g. 'Desarrollo'"),
        departmentId: z.string().optional().describe("create: department id"),
        workContext: z
          .string()
          .optional()
          .describe("create: what this person does — PAUL uses it to assign work"),
        aliases: z.string().optional().describe("create: comma-separated nicknames"),
        isAdmin: z
          .boolean()
          .optional()
          .describe("create: grant admin panel access (makes the person undeletable)"),
        showClientBar: z.boolean().optional().describe("create: show the client bar in their UI"),
      },
    },
    async (args) => {
      try {
        return await runPeopleAction(admin, args as PeopleArgs);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export interface PeopleArgs {
  action: "list" | "create" | "delete" | "reset_password";
  uid?: string;
  name?: string;
  email?: string;
  role?: string;
  departmentId?: string;
  workContext?: string;
  aliases?: string;
  isAdmin?: boolean;
  showClientBar?: boolean;
}

async function runPeopleAction(
  admin: Pick<PaulAdminClient, "peoplePage" | "createUser" | "deleteUser" | "resetPassword">,
  args: PeopleArgs,
): Promise<ToolResult> {
  const { action } = args;
  if (action === "list") {
    const people = parseAdminPeople(await admin.peoplePage());
    return textResult({
      total: people.length,
      admins: people.filter((p) => p.isAdmin).length,
      people,
    });
  }
  if (!args.uid) return missingFieldResult(`${action} needs \`uid\`.`);
  if (action === "create") {
    if (!args.name) return missingFieldResult("create needs `name`.");
    const html = await admin.createUser({
      uid: args.uid,
      name: args.name,
      email: args.email,
      role: args.role,
      departmentId: args.departmentId,
      workContext: args.workContext,
      aliases: args.aliases,
      isAdmin: args.isAdmin,
      showClientBar: args.showClientBar,
    });
    return peopleWriteResult(action, args.uid, html);
  }
  const html =
    action === "delete" ? await admin.deleteUser(args.uid) : await admin.resetPassword(args.uid);
  return peopleWriteResult(action, args.uid, html);
}

function peopleWriteResult(action: string, uid: string, html: string): ToolResult {
  return textResult({
    ok: true,
    action,
    uid,
    people: parseAdminPeople(html),
    ...truncateText(html),
  });
}

const ACTION_DESCRIPTION =
  "Generic escape hatch for MUTATIONS: POST a raw form to any admin page. " +
  "DANGER — this writes to a LIVE admin panel: there is no undo, no dry run " +
  "and no confirmation step, and a wrong field name can blank a stored value " +
  "instead of erroring, because the panel saves whatever the form posts. Use " +
  "a dedicated tool (paul_admin_task_write, paul_admin_people) whenever one " +
  "exists; use this only for pages that have none, and only when you already " +
  "KNOW THE EXACT FIELD NAMES the page expects — read the page's own form " +
  "markup first. The form discriminator is usually `_form` (e.g. " +
  "{_form:'add', text:'...'} on knowledge), BUT findings.php, objectives.php " +
  "and hoy.php key off a BARE FIELD NAME instead of `_form`, so sending " +
  "`_form` to those does nothing at all. Valid pages: " +
  ADMIN_PAGES.join(", ") +
  ".";

export function registerAdminActionTool(
  server: McpServer,
  admin: Pick<PaulAdminClient, "submit">,
): void {
  server.registerTool(
    "paul_admin_action",
    {
      title: "POST a raw form to a PAUL admin page",
      description: ACTION_DESCRIPTION,
      inputSchema: {
        page: z.string().describe(`Admin page to post to, one of: ${ADMIN_PAGES.join(", ")}`),
        fields: z
          .record(z.string())
          .describe("Exact form fields, including the page's discriminator (usually `_form`)"),
      },
    },
    async ({ page, fields }) => {
      if (!(ADMIN_PAGES as readonly string[]).includes(page)) return unknownPageResult(page);
      try {
        const html = await admin.submit(page, fields);
        return textResult({
          ok: true,
          page,
          fields,
          headings: parseHeadings(html),
          ...truncateText(html),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
