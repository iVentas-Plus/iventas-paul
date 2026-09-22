/**
 * Mutating MCP tools over PAUL's admin panel.
 *
 * Every write here is a form POST to a LIVE panel with no undo and no approval
 * queue, so each tool validates its required fields BEFORE touching the
 * network and says so in the error when it refuses.
 */
import { z } from "zod";
import { ADMIN_PAGES, PaulAdminError } from "../admin-client.js";
import { parseHeadings, parseAdminTasks, parseAdminPeople, stripTags } from "../admin-parse.js";
import { textResult, errorResult, createFailureResult } from "./shared.js";
import { truncateText, unknownPageResult } from "./admin-read.js";
/** Refusal made before any request: says what is missing and that nothing changed. */
function missingFieldResult(message) {
    return textResult({ error: true, message: `${message} Nothing was sent.` }, true);
}
const TASK_WRITE_DESCRIPTION = "Create, edit, delete or complete a task for ANY collaborator, as an " +
    "administrator. Four actions: 'create' needs userUid + title; 'update' " +
    "needs id + userUid; 'delete' and 'complete' need id, and take userUid " +
    "optionally so the board that comes back is the right person's. Things that " +
    "are easy to " +
    "get wrong: (1) THE ASSIGNEE IS `userUid` — the person the task is FOR. " +
    "`requesterUid` is a different thing: whoever ASKED for the task. Putting " +
    "the requester in userUid assigns the work to the wrong person. (2) " +
    "'update' MERGES: it reads the stored task first and re-sends every field " +
    "that is omitted, so a title-only edit keeps the type, the estimate, the " +
    "priority and the context untouched — but an explicit empty string DOES " +
    "clear a field. It needs `userUid` (the assignee, from paul_admin_tasks) " +
    "because the edit form lives on that person's board; an id that is not on " +
    "that board is refused without writing anything. 'update' CANNOT change the " +
    "assignee and CANNOT change the status — the " +
    "panel exposes no field for either, so a task can only be reassigned by " +
    "deleting and recreating it. It also cannot write the client dossier " +
    "(client context and client KPIs): those are filled in by the collaborator " +
    "in PAUL's own UI and the panel posts no field for them. (3) 'delete' is a " +
    "HARD ADMIN DELETE: it " +
    "removes the task immediately, with no approval queue and no undo (unlike a " +
    "collaborator's own delete request, which PAUL queues for review). (4) " +
    "'complete' closes the task WITHOUT a checkpoint — no evidence, no time " +
    "settled, no AI verdict. For the user's own finished work prefer the normal " +
    "flow (paul_start_task → paul_get_checkpoint → paul_submit_checkpoint); use " +
    "'complete' only to clean up something that will never get a checkpoint. " +
    "priority is 1=alta, 2=media, 3=baja; weeks is 0 for this week and 1..4 for " +
    "that many weeks ahead. Errors: a missing required field is refused BEFORE " +
    "any request ('Nothing was sent' — fix the argument and call again); an " +
    "`id` that is not on that person's board is refused with nothing changed, " +
    "so re-read the owner from paul_admin_tasks; and a 'create' that fails with " +
    "`outcome: 'unknown'` MAY still have created the task — the panel does not " +
    "de-duplicate, so read paul_admin_tasks for that uid BEFORE retrying, or " +
    "you file it twice.";
export function registerAdminTaskWriteTool(server, admin) {
    server.registerTool("paul_admin_task_write", {
        title: "Create, edit, delete or complete any PAUL task",
        description: TASK_WRITE_DESCRIPTION,
        inputSchema: {
            action: z.enum(["create", "update", "delete", "complete"]).describe("What to do"),
            id: z.number().int().positive().optional().describe("Task id (update/delete/complete)"),
            userUid: z
                .string()
                .optional()
                .describe("uid of the ASSIGNEE — the person who will do the task. Required for " +
                "create and update; optional for delete/complete, where it only " +
                "decides whose board is returned"),
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
        },
    }, async (args) => {
        const typed = args;
        try {
            return await runTaskWrite(admin, typed);
        }
        catch (err) {
            // Only `create` can duplicate: update, delete and complete name an id
            // that already exists, so repeating one converges instead of adding a
            // row. See createFailureResult for why the distinction matters.
            if (typed.action !== "create")
                return errorResult(err);
            return createFailureResult(err, (e) => e instanceof PaulAdminError, "paul_admin_tasks with the assignee's `uid`");
        }
    });
}
async function runTaskWrite(admin, args) {
    const { action } = args;
    if (action === "create") {
        if (!args.userUid) {
            return missingFieldResult("create needs `userUid`: the uid of the ASSIGNEE, the person the task is for.");
        }
        if (!args.title)
            return missingFieldResult("create needs `title`.");
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
        if (typeof args.id !== "number")
            return missingFieldResult("update needs `id`.");
        if (!args.userUid) {
            return missingFieldResult("update needs `userUid`: the uid of the task's ASSIGNEE. The panel's edit " +
                "form only exists on that person's board, so without it the edit would " +
                "be applied to whoever the panel defaults to. Read the uid from " +
                "paul_admin_tasks, which reports the owner of every task id.");
        }
        const html = await admin.updateTask({
            id: args.id,
            userUid: args.userUid,
            title: args.title,
            type: args.type,
            estMin: args.estMin,
            priority: args.priority,
            context: args.context,
        });
        return taskWriteResult(action, html, { id: args.id });
    }
    if (typeof args.id !== "number")
        return missingFieldResult(`${action} needs \`id\`.`);
    const html = action === "delete"
        ? await admin.deleteTask(args.id, args.userUid)
        : await admin.completeTask(args.id, args.userUid);
    return taskWriteResult(action, html, { id: args.id });
}
function taskWriteResult(action, html, extra) {
    return textResult({
        ok: true,
        action,
        ...extra,
        headings: parseHeadings(html),
        board: parseAdminTasks(html),
    });
}
const PEOPLE_DESCRIPTION = "List, create, delete or reset the password of PAUL's collaborators. " +
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
export function registerAdminPeopleTool(server, admin) {
    server.registerTool("paul_admin_people", {
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
    }, async (args) => {
        try {
            return await runPeopleAction(admin, args);
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
async function runPeopleAction(admin, args) {
    const { action } = args;
    if (action === "list") {
        const people = parseAdminPeople(await admin.peoplePage());
        return textResult({
            total: people.length,
            admins: people.filter((p) => p.isAdmin).length,
            people,
        });
    }
    if (!args.uid)
        return missingFieldResult(`${action} needs \`uid\`.`);
    if (action === "create") {
        if (!args.name)
            return missingFieldResult("create needs `name`.");
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
    const html = action === "delete" ? await admin.deleteUser(args.uid) : await admin.resetPassword(args.uid);
    return peopleWriteResult(action, args.uid, html);
}
/**
 * The panel prints the freshly issued password in one sentence of an otherwise
 * ordinary people page. Anchored on the keyword and capped, so the result
 * carries the secret and not the whole roster page around it.
 */
const PASSWORD_PHRASE = /(?:nueva\s+)?(?:contrase[nñ]a|password|pin)\b[^\n]{0,80}/gi;
/**
 * Anything shaped like an email address. Bounded on both sides so a hostile
 * page cannot make it backtrack: every quantifier is over a character class
 * that excludes the delimiter that follows it.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
/** Email addresses replaced by a marker, so the text says what was removed. */
const EMAIL_REDACTION = "[correo omitido]";
/**
 * Removes email addresses from text that is about to leave the panel.
 *
 * A tool result is written to the MCP client's history, so whatever this
 * returns outlives the call. The people page carries the whole roster's
 * addresses, and the password sentence itself often names the collaborator by
 * email. None of that is needed to hand over a password, and every address
 * that IS needed can be read from `people` in the same result or from
 * paul_admin_people — which is the roster, not a transcript.
 */
function redactEmails(text) {
    return text.replace(EMAIL_RE, EMAIL_REDACTION);
}
/** The sentence carrying the new password, or the whole page when it eludes us. */
function passwordLine(html) {
    const matches = stripTags(html).match(PASSWORD_PHRASE) ?? [];
    // A page can mention the word in a button label; the one that carries a
    // value after a separator is the announcement, so prefer the last of those.
    const withValue = matches.filter((m) => /[:=]\s*\S/.test(m));
    const hit = (withValue.length > 0 ? withValue : matches).at(-1);
    if (hit)
        return { text: redactEmails(hit.trim()) };
    // Isolating the line is a best-effort match on wording we could not verify
    // against the live panel, and the password is shown ONCE. So a miss falls
    // back to the page text rather than dropping it: handing the page to the
    // admin who just triggered the reset is a far smaller problem than
    // destroying a secret that cannot be recovered. The addresses go, though —
    // they are recoverable, the password is not.
    const fallback = truncateText(html);
    return {
        ...fallback,
        text: redactEmails(fallback.text),
        note: "The password line could not be isolated, so the whole page is returned " +
            "in `text`, with every email address replaced by " +
            `"${EMAIL_REDACTION}" — the password is shown only once and must not be ` +
            "dropped, but the roster's addresses must not leave the panel. Read the " +
            "password from there, hand it to the user, and do not repeat the rest.",
    };
}
function peopleWriteResult(action, uid, html) {
    return textResult({
        ok: true,
        action,
        uid,
        people: parseAdminPeople(html),
        // Only reset_password has anything to read in the page body; for create and
        // delete the parsed roster IS the answer, and dumping the page is noise.
        ...(action === "reset_password" ? passwordLine(html) : {}),
    });
}
/**
 * Pages whose forms are scoped to one collaborator by `?u=<uid>`.
 *
 * `admin/tasks.php` is the verified one: its forms carry no `action`
 * attribute, so a browser posts them to the current url INCLUDING its query
 * string. A POST without `?u=` therefore applies to whatever board the panel
 * defaults to — measured in production as a create that landed on the wrong
 * person's list while returning a board that did not contain it. The
 * dedicated task tools already pass it; this list stops the generic escape
 * hatch from being the door the same bug walks back in through.
 */
const BOARD_SCOPED_PAGES = ["tasks"];
/** Refusal for a board-scoped POST with no uid — made before any request. */
function missingBoardUidResult(page) {
    return textResult({
        error: true,
        page,
        message: `admin/${page}.php is scoped to ONE collaborator by \`?u=<uid>\`, and ` +
            "its forms carry no `action`, so a POST without it is applied to " +
            "whichever board the panel defaults to — not the person you meant. " +
            "NOTHING WAS POSTED. Pass `userUid` (the uid whose board the row is " +
            "on, as `paul_admin_tasks` reports it), or use paul_admin_task_write, " +
            "which handles the scoping and the read-modify-write for you.",
    }, true);
}
export const ACTION_DESCRIPTION = "Generic escape hatch for MUTATIONS: POST a raw form to any admin page. " +
    "DANGER — this writes to a LIVE admin panel: there is no undo, no dry run " +
    "and no confirmation step, and a wrong field name can blank a stored value " +
    "instead of erroring, because the panel saves whatever the form posts. Use " +
    "a dedicated tool (paul_admin_task_write, paul_admin_people) whenever one " +
    "exists; use this only for pages that have none, and only when you already " +
    "KNOW THE EXACT FIELD NAMES the page expects — read the page's own form " +
    "markup first. The form discriminator is usually `_form` (e.g. " +
    "{_form:'add', text:'...'} on knowledge), BUT findings.php, objectives.php " +
    "and hoy.php key off a BARE FIELD NAME instead of `_form`, so sending " +
    "`_form` to those does nothing at all. `userUid` becomes the `?u=<uid>` the " +
    "panel's own forms carry: the forms have NO `action` attribute, so a " +
    "browser posts them to the current url INCLUDING its query string, and a " +
    "post without it lands on whichever board the panel defaults to. It is " +
    "REQUIRED for " +
    BOARD_SCOPED_PAGES.join(", ") +
    " — those are rejected without it, with nothing posted. On every OTHER " +
    "page it is optional but NOT ignored: whatever you pass is still appended " +
    "as `?u=<uid>`, so the panel scopes the write to that person's view. Omit " +
    "it unless you mean that. Errors: an unknown page or a missing `userUid` is refused " +
    "BEFORE any request (nothing changed, fix the argument and call again); a " +
    "PaulAdminError means the POST was attempted, so re-read the page with " +
    "paul_admin_page to see what landed before retrying. Valid pages: " +
    ADMIN_PAGES.join(", ") +
    ".";
export function registerAdminActionTool(server, admin) {
    server.registerTool("paul_admin_action", {
        title: "POST a raw form to a PAUL admin page",
        description: ACTION_DESCRIPTION,
        inputSchema: {
            page: z.string().describe(`Admin page to post to, one of: ${ADMIN_PAGES.join(", ")}`),
            userUid: z
                .string()
                .optional()
                .describe("Collaborator uid for the `?u=` the page is scoped by. Required " +
                `for: ${BOARD_SCOPED_PAGES.join(", ")}.`),
            fields: z
                .record(z.string())
                .describe("Exact form fields, including the page's discriminator (usually `_form`)"),
        },
    }, async ({ page, userUid, fields }) => {
        if (!ADMIN_PAGES.includes(page))
            return unknownPageResult(page);
        if (!userUid && BOARD_SCOPED_PAGES.includes(page)) {
            return missingBoardUidResult(page);
        }
        try {
            const html = await admin.submit(page, fields, userUid ? { u: userUid } : undefined);
            return textResult({
                ok: true,
                page,
                userUid: userUid ?? null,
                fields,
                headings: parseHeadings(html),
                ...truncateText(html),
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
