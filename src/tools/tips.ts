import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaulClient } from "../client.js";
import { textResult, errorResult } from "./shared.js";

export function registerTipsTools(server: McpServer, client: PaulClient): void {
  server.registerTool(
    "paul_tips",
    {
      title: "Read PAUL's coaching tips",
      description:
        "Read the tips PAUL emits. IMPORTANT: tips are written BY PAUL for the " +
        "user — this tool only READS them. It is not a way to file, author or " +
        "publish advice, and nothing the caller writes reaches PAUL through " +
        "here. Two modes: without `taskId` it returns PAUL's daily coaching " +
        "tips about the user's work habits; with `taskId` it returns " +
        "perspective hints for that single task, together with the task's own " +
        "title. Call it sparingly and never in a loop: the daily tips are " +
        "GENERATED FRESH on every call and each call spends part of PAUL's AI " +
        "budget (the same budget that powers the checkpoint questions).",
      inputSchema: {
        taskId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Task id from paul_tasks; omit to get the daily coaching tips instead"),
      },
    },
    async ({ taskId }) => {
      try {
        const res =
          taskId === undefined ? await client.paulTips() : await client.taskTips(taskId);
        const tips = Array.isArray(res?.tips) ? res.tips : [];
        return textResult({
          scope: taskId === undefined ? "daily" : "task",
          taskId: taskId ?? null,
          title: res?.title ?? null,
          count: tips.length,
          tips,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
