import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { TurnContext } from "../context/turn-context.js";
import { memorySnapshot } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import { notAttempted } from "../action/outcome.js";
import type { RunActionDeps } from "../action/context.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { runResearchSubagent } from "../roles/subagent.js";
import { formatActionsForLanguage } from "../action/present.js";
import { RESEARCH_AGENT_SYSTEM } from "../prompts/roles.js";

const researchActivateSchema = z.object({
  activate: z.boolean(),
  tool: z.string().optional(),
  intent: z.string().optional(),
});

const researchActivateJsonSchema = zodToJsonSchema(researchActivateSchema, {
  name: "ResearchActivation",
  $refStrategy: "none",
}) as Record<string, unknown>;

function buildResearchAgentUserContent(ctx: TurnContext): string {
  const snap = memorySnapshot(ctx);
  const parts: string[] = [
    `（状況: ${snap.state} / ${snap.currentDateTime}）`,
    "",
    "## 今ターンのトリガー",
    snap.partnerUtterance,
    "",
    "## 直近の会話",
    snap.workingMemory,
    "",
    "## このターンで起きたこと（記憶エージェント結果）",
    formatActionsForLanguage(ctx.actions),
  ];

  if (snap.innerState.trim()) {
    parts.push(
      "",
      "## いまの内心",
      snap.innerState,
    );
  }

  return parts.join("\n");
}

export async function runResearchAgent(
  llm: LlmClient,
  ctx: TurnContext,
  deps: RunActionDeps,
): Promise<ActionOutcome> {
  const format = researchActivateJsonSchema;
  const userContent = buildResearchAgentUserContent(ctx);

  let activate = false;
  let intent = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: RESEARCH_AGENT_SYSTEM },
        { role: "user", content: userContent },
      ],
      { format, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, researchActivateSchema);
    if (parsed.ok) {
      activate = parsed.value.activate;
      intent = parsed.value.intent ?? "";
      break;
    }
  }

  if (!activate || !intent) {
    return notAttempted();
  }

  const action = { kind: "research" as const, intent };
  const input = { ctx, action, ...deps };
  return runResearchSubagent(llm, input);
}
