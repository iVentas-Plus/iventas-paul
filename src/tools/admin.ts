/**
 * MCP tools over PAUL's admin panel (`<base>/admin/*.php`).
 *
 * The panel is a separate authentication plane from the JSON API and a
 * separate world from the collaborator's own task list: it is the only place
 * where every person's tasks, the team-wide forecast, the red flags and the
 * roster can be read or changed. `registerAdminTools` is the single entry
 * point; the tools themselves live in two files only because a single one
 * would be unwieldy, not because they are two subsystems.
 *
 * Impersonation is deliberately NOT exposed. If a tool ever needs it, it must
 * go through `PaulAdminClient.withViewAs`: a session left inside a `view_as`
 * cannot write anything and cannot even log in again, so the bare
 * viewAs/viewSelf pair can brick the session for the rest of the process.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaulAdminClient } from "../admin-client.js";
import {
  registerAdminStatusTool,
  registerAdminTasksTool,
  registerAdminPageTool,
  registerAdminAskTool,
} from "./admin-read.js";
import {
  registerAdminTaskWriteTool,
  registerAdminPeopleTool,
  registerAdminActionTool,
} from "./admin-write.js";

export {
  registerAdminStatusTool,
  registerAdminTasksTool,
  registerAdminPageTool,
  registerAdminAskTool,
  MAX_TEXT_CHARS,
  truncateText,
} from "./admin-read.js";
export type { TruncatedText, BoardSweep } from "./admin-read.js";
export {
  registerAdminTaskWriteTool,
  registerAdminPeopleTool,
  registerAdminActionTool,
} from "./admin-write.js";
export type { TaskWriteArgs, PeopleArgs } from "./admin-write.js";

/** Registers every admin-panel tool on the MCP server. */
export function registerAdminTools(server: McpServer, admin: PaulAdminClient): void {
  registerAdminStatusTool(server, admin);
  registerAdminTasksTool(server, admin);
  registerAdminTaskWriteTool(server, admin);
  registerAdminPeopleTool(server, admin);
  registerAdminPageTool(server, admin);
  registerAdminActionTool(server, admin);
  registerAdminAskTool(server, admin);
}
