import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaulClient, Idea } from "../client.js";
import { textResult, errorResult } from "./shared.js";

/** Defensive read: an empty board may come back without the `ideas` key. */
function ideasOf(payload: { ideas?: unknown } | null | undefined): Idea[] {
  return Array.isArray(payload?.ideas) ? (payload.ideas as Idea[]) : [];
}

function summarize(idea: Idea) {
  return {
    id: idea.id,
    text: idea.text,
    who: idea.who ?? null,
    votes: idea.votes ?? 0,
    voted: idea.voted ?? false,
    status: idea.status ?? "abierta",
  };
}

export function registerIdeasTools(server: McpServer, client: PaulClient): void {
  server.registerTool(
    "paul_ideas",
    {
      title: "List PAUL improvement ideas",
      description:
        "List the team's idea board — product feedback about PAUL itself — " +
        "with a count summary by status. Each idea carries: id, text, `who` " +
        "proposed it, `votes` (how many people upvoted it), `status` (abierta | " +
        "planeada | lista | descartada) and `voted`, which tells whether the " +
        "CURRENT user already voted for it — check it before calling " +
        "paul_vote_idea. Ideas are not work items: they never appear in " +
        "paul_tasks and nobody is assigned to them. This is the HISTORICAL " +
        "board: new work is filed in the Peticiones queue (paul_requests), and " +
        "a row here can be moved there with paul_create_request migrateSrc " +
        "'idea' + migrateId.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.ideasList();
        const ideas = ideasOf(data);
        const counts: Record<string, number> = {};
        for (const idea of ideas) {
          const status = idea.status ?? "abierta";
          counts[status] = (counts[status] ?? 0) + 1;
        }
        return textResult({
          summary: { total: ideas.length, byStatus: counts },
          ideas: ideas.map(summarize),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "paul_create_idea",
    {
      title: "Propose an idea to improve PAUL (historical board)",
      description:
        "Post an idea to PAUL's improvement board. PREFER paul_create_request " +
        "with kind 'idea': PAUL moved team requests to the Peticiones queue, " +
        "where an idea is ordered by the money it brings, and now labels this " +
        "board 'histórico'. It is still live — use it only when the user asks " +
        "for the idea board or wants the upvote mechanic, which the new queue " +
        "does not have. IMPORTANT: ideas are " +
        "PRODUCT FEEDBACK ABOUT PAUL ITSELF (the coach app) — how it should " +
        "behave, what it should add, what annoys the team. They are NOT work " +
        "items: to file work for the user or a teammate use paul_register_task, " +
        "and to report something broken in PAUL use paul_report_bug. The API " +
        "answers with no useful body, so this tool re-reads the board and " +
        "reports `confirmed: true` when the idea is visible there (with its new " +
        "id) or `confirmed: false` when it is not — false means the post could " +
        "not be verified, NOT necessarily that it failed; read paul_ideas " +
        "before posting again to avoid a duplicate.",
      inputSchema: {
        text: z
          .string()
          .min(6)
          .max(400)
          .describe("The idea, 6 to 400 characters (the limits the PAUL UI enforces)"),
      },
    },
    async ({ text }) => {
      try {
        const created = await client.ideaCreate(text);
        let confirmed = false;
        let idea: ReturnType<typeof summarize> | null = null;
        try {
          const found = ideasOf(await client.ideasList()).find(
            (i) => (i.text ?? "").trim() === text.trim(),
          );
          if (found) {
            confirmed = true;
            idea = summarize(found);
          }
        } catch {
          // The re-read is only a confirmation: a failure there must not turn a
          // successful post into an error result.
          confirmed = false;
        }
        return textResult({ submitted: true, confirmed, idea, api: created ?? null });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "paul_vote_idea",
    {
      title: "Upvote an idea on PAUL's board",
      description:
        "Upvote an idea from paul_ideas by its id. Check the idea's `voted` " +
        "flag first: whether a SECOND vote on the same idea toggles the vote " +
        "off, is ignored, or adds another vote is UNKNOWN — the real UI fires " +
        "this exact call regardless of the current state and ignores the " +
        "response, so the behavior was never observed. Re-read paul_ideas after " +
        "voting if the resulting count matters.",
      inputSchema: {
        id: z.number().int().positive().describe("Idea id from paul_ideas"),
      },
    },
    async ({ id }) => {
      try {
        const res = await client.ideaVote(id);
        // A non-2xx response throws, so reaching here means PAUL accepted the
        // vote even though the body carries nothing useful.
        return textResult({ ok: res?.ok ?? true, api: res ?? null });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
