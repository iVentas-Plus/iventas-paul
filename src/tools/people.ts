import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaulClient } from "../client.js";
import { textResult, errorResult } from "./shared.js";

/**
 * Registers the roster tool. Without it an agent has no way to obtain a valid
 * `person_uid`, which every assignment call requires: PAUL identifies people
 * by uid only — never by name, never by email.
 */
export function registerPeopleTool(server: McpServer, client: PaulClient): void {
  server.registerTool(
    "paul_people",
    {
      title: "List the people you can assign work to",
      description:
        "List PAUL's roster: for each person their uid, full name, first name " +
        "and department. The `uid` is the ONLY identifier PAUL accepts when " +
        "assigning work (paul_assign_task, paul_assign_bug, and the 'reassign' " +
        "action of paul_task_action) — names and emails are rejected. Call " +
        "this FIRST whenever the user names a person in words ('assign it to " +
        "David') so you can map that name to a uid instead of guessing it. " +
        "Note that PAUL itself appears in the roster as the uid 'paul': it is " +
        "the coach bot, not a teammate, so never assign human work to it, and " +
        "it is returned apart as `bot`. The `total` counts the `people` array " +
        "only, so it never includes the bot.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.peerContacts();
        const contacts = (res.contacts ?? []).map((c) => ({
          uid: c.uid,
          name: c.name,
          first: c.first,
          dept: c.dept ?? null,
        }));
        // `total` describes `people`, not the raw roster: PAUL's own bot is
        // returned separately, so counting it here would make a caller print
        // "12 people" above a list of 11.
        const people = contacts.filter((c) => c.uid !== "paul");
        return textResult({
          total: people.length,
          people,
          bot: contacts.find((c) => c.uid === "paul") ?? null,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
