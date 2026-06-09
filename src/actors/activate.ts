import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { buildActorContext } from "../context/turn-context.js";
import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ContextChannel } from "../config/settings.js";
import type { ActorActivateResult } from "./types.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";

const activateOutputSchema = z.object({
  active: z.boolean(),
  intent: z.string().optional(),
  time_range: z
    .object({
      since_days_ago: z.number().optional(),
      until_days_ago: z.number().optional(),
    })
    .optional(),
});

const activateOutputJsonSchema = zodToJsonSchema(activateOutputSchema, {
  name: "ActivateOutput",
  $refStrategy: "none",
}) as Record<string, unknown>;

function buildActivateSystem(name: string, description: string): string {
  return [
    `あなたは ${name} の起動判定係です。`,
    `役割: ${description}`,
    "",
    "会話を読み、このターンで起動すべきか判断してください。",
    "起動すべき場合: { \"active\": true, \"intent\": \"具体的な意図\" }",
    "不要な場合: { \"active\": false }",
  ].join("\n");
}

/** DECISIONS.md §知覚チャンネル: activator は直近 2〜3 ターンの mini-context で判断する */
const ACTOR_CONTEXT_TURNS = 3;

/** 標準の起動判定関数を生成するファクトリ。各 actor がこれを使って activate を実装する */
export function createActivate(
  name: string,
  description: string,
): (
  llm: LlmClient,
  ctx: TurnContext,
  channels: ContextChannel[],
) => Promise<ActorActivateResult | null> {
  const system = buildActivateSystem(name, description);
  return async (llm, ctx, channels) => {
    const context = buildActorContext(ctx, channels, { maxTurns: ACTOR_CONTEXT_TURNS });
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await llm.chat(
        [
          { role: "system", content: system },
          { role: "user", content: context },
        ],
        { format: activateOutputJsonSchema, temperature: 0 },
      );
      const parsed = tryParseJsonWithSchema(raw, activateOutputSchema);
      if (!parsed.ok) continue;
      if (!parsed.value.active) return null;
      const intent = parsed.value.intent?.trim();
      if (!intent) return null;
      return {
        intent,
        timeRange:
          parsed.value.time_range?.since_days_ago !== undefined ||
          parsed.value.time_range?.until_days_ago !== undefined
            ? {
                sinceDaysAgo: parsed.value.time_range.since_days_ago,
                untilDaysAgo: parsed.value.time_range.until_days_ago,
              }
            : undefined,
      };
    }
    return null;
  };
}
