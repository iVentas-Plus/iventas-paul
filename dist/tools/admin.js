import { registerAdminStatusTool, registerAdminTasksTool, registerAdminPageTool, registerAdminAskTool, } from "./admin-read.js";
import { registerAdminTaskWriteTool, registerAdminPeopleTool, registerAdminActionTool, } from "./admin-write.js";
export { registerAdminStatusTool, registerAdminTasksTool, registerAdminPageTool, registerAdminAskTool, MAX_TEXT_CHARS, MAX_SWEEP_PEOPLE, SWEEP_CONCURRENCY, truncateText, } from "./admin-read.js";
export { ACTION_DESCRIPTION, registerAdminTaskWriteTool, registerAdminPeopleTool, registerAdminActionTool, } from "./admin-write.js";
/** Registers every admin-panel tool on the MCP server. */
export function registerAdminTools(server, admin) {
    registerAdminStatusTool(server, admin);
    registerAdminTasksTool(server, admin);
    registerAdminTaskWriteTool(server, admin);
    registerAdminPeopleTool(server, admin);
    registerAdminPageTool(server, admin);
    registerAdminActionTool(server, admin);
    registerAdminAskTool(server, admin);
}
