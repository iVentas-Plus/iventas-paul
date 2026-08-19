#!/usr/bin/env node
/**
 * iventas-paul — MCP server (stdio) exposing PAUL (iVentas COACH) to AI
 * coding agents.
 *
 * Two planes are wired here over ONE HTTP session, because PAUL is one PHP app
 * with one IVCOACH cookie and two independent logins:
 *   - PaulClient      — the collaborator JSON API (api.php).
 *   - PaulAdminClient — the admin panel (admin/*.php), form-encoded HTML.
 * The admin tools are always registered; they report plainly when the account
 * has no administrator role, which is the only way to find that out (the JSON
 * API does not expose the flag).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaulClient, configFromEnv } from "./client.js";
import { PaulAdminClient } from "./admin-client.js";
import { registerTasksTool } from "./tools/tasks.js";
import { registerStartTaskTool } from "./tools/start-task.js";
import { registerGetCheckpointTool } from "./tools/get-checkpoint.js";
import { registerSubmitCheckpointTool } from "./tools/submit-checkpoint.js";
import { registerRegisterTaskTool, registerAssignTaskTool } from "./tools/assign.js";
import { registerPeopleTool } from "./tools/people.js";
import { registerTaskActionTool, registerUndoAssignmentTool, } from "./tools/task-actions.js";
import { registerReorderTaskTool } from "./tools/reorder-task.js";
import { registerRedGateTool } from "./tools/red-gate.js";
import { registerConfirmNotifiedTool } from "./tools/notify.js";
import { registerChatTool } from "./tools/chat.js";
import { registerBugsTools } from "./tools/bugs.js";
import { registerIdeasTools } from "./tools/ideas.js";
import { registerTipsTools } from "./tools/tips.js";
import { registerAdminTools } from "./tools/admin.js";
import { applyCallToolArgumentCompat } from "./mcp-compat.js";
async function main() {
    // Fail fast on missing configuration, before accepting any MCP traffic.
    const config = configFromEnv();
    const client = new PaulClient(config);
    // The admin plane shares the collaborator's session: same cookie, separate
    // authentication.
    const admin = new PaulAdminClient(config, client.session);
    const server = new McpServer({ name: "paul-mcp", version: "1.1.0" });
    // Tasks
    registerTasksTool(server, client);
    registerStartTaskTool(server, client);
    registerTaskActionTool(server, client);
    registerReorderTaskTool(server, client);
    // Assignment
    registerPeopleTool(server, client);
    registerRegisterTaskTool(server, client);
    registerAssignTaskTool(server, client);
    registerUndoAssignmentTool(server, client);
    // Closing a task
    registerGetCheckpointTool(server, client);
    registerSubmitCheckpointTool(server, client);
    registerRedGateTool(server, client);
    registerConfirmNotifiedTool(server, client);
    // Bugs, ideas and PAUL's own tips
    registerBugsTools(server, client);
    registerIdeasTools(server, client);
    registerTipsTools(server, client);
    // Coach
    registerChatTool(server, client);
    // Administration
    registerAdminTools(server, admin);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Must come after connect(): that call is what assigns transport.onmessage.
    applyCallToolArgumentCompat(transport);
}
main().catch((err) => {
    console.error(`paul-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
