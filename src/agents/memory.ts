import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { TurnContext } from "../context/turn-context.js";
import { memorySnapshot } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import { notAttempted } from "../action/outcome.js";
import type { RunActionDeps } from "../action/context.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { runMemorySubagent } from "../roles/agents/memory.js";
import { MEMORY_AGENT_SYSTEM } from "../prompts/roles.js";

const timeRangeSchema = z.object({
  since_days_ago: z.number().optional(),
  until_days_ago: z.number().optional(),
});

const memoryActivateSchema = z.object({
  activate: z.boolean(),
  tool: z.string().optional(),
  intent: z.string().optional(),
  time_range: timeRangeSchema.optional(),
});

const memoryActivateJsonSchema = zodToJsonSchema(memoryActivateSchema, {
  name: "MemoryActivation",
  $refStrategy: "none",
}) as Record<string, unknown>;

function buildMemoryAgentUserContent(ctx: TurnContext): string {
  const snap = memorySnapshot(ctx);
  const parts: string[] = [
    `（状況: ${snap.state} / ${snap.currentDateTime}）`,
    "",
    "## 今ターンのトリガー",
    snap.partnerUtterance,
    "",
    "## 直近の会話",
    snap.workingMemory,
  ];

  if (snap.recalledEpisodes.length > 0) {
    parts.push(
      "",
      "## 既に想起されている記憶（参考）",
      ...snap.recalledEpisodes,
    );
  }

  if (snap.recalledNotes.length > 0) {
    parts.push(
      "",
      "## 関連メモ（参考）",
      ...snap.recalledNotes,
    );
  }

  if (snap.innerState.trim()) {
    parts.push(
      "",
      "## いまの内心",
      snap.innerState,
    );
  }

  return parts.join("\n");
}

export async function runMemoryAgent(
  llm: LlmClient,
  ctx: TurnContext,
  deps: RunActionDeps,
): Promise<ActionOutcome> {
  const format = memoryActivateJsonSchema;
  const userContent = buildMemoryAgentUserContent(ctx);

  let activate = false;
  let tool = "";
  let intent = "";
  let timeRange: { sinceDaysAgo?: number; untilDaysAgo?: number } | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: MEMORY_AGENT_SYSTEM },
        { role: "user", content: userContent },
      ],
      { format, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, memoryActivateSchema);
    if (parsed.ok) {
      activate = parsed.value.activate;
      tool = parsed.value.tool ?? "";
      intent = parsed.value.intent ?? "";
      const tr = parsed.value.time_range;
      if (tr?.since_days_ago !== undefined || tr?.until_days_ago !== undefined) {
        timeRange = { sinceDaysAgo: tr.since_days_ago, untilDaysAgo: tr.until_days_ago };
      }
      break;
    }
  }

  if (!activate || !tool || !intent) {
    return notAttempted();
  }

  const action = { kind: "memory" as const, intent, timeRange };
  const input = { ctx, action, ...deps };
  return runMemorySubagent(llm, input, tool);
}
