import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ActorRunner, ActorActivateResult } from "./types.js";
import { buildActorContext } from "../context/turn-context.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { runRecall } from "../roles/recall.js";

// 受動の記憶 faculty（DECISIONS §記憶 faculty）: エピソード記憶を自分から「思い出しにいく」係。
// できるのは Read(想起) のみ。能動 Create/Update は無い（符号化は内省の importance 採点）。
// 忘却は意志の op ではなく減衰（recencyDecay × importance）に委ねる＝「意識して忘れる」は人間にない。
// 本気の削除（プライバシー）は out-of-band（runForget は温存・per-turn の faculty ではない）。
// ノートの読み書き（CRUD）は別 faculty = memo（記録）。
const MEMORY_ACTIVATE_PROMPT = [
  "会話を読み、過去の記憶を自分から思い出しにいく必要があるかを判断してください。",
  "",
  '- 過去の出来事・約束・相手のことを具体的に思い出したい → { "active": true, "intent": "思い出したい内容" }',
  '- いまの会話で足りる・わざわざ掘り返す必要はない → { "active": false }',
].join("\n");

const memoryActivateSchema = z.object({
  active: z.boolean(),
  intent: z.string().optional(),
  time_range: z
    .object({
      since_days_ago: z.number().optional(),
      until_days_ago: z.number().optional(),
    })
    .optional(),
});

const memoryActivateJsonSchema = zodToJsonSchema(memoryActivateSchema, {
  name: "MemoryActivate",
  $refStrategy: "none",
}) as Record<string, unknown>;

const ACTOR_CONTEXT_TURNS = 3;

export const memoryActor: ActorRunner = {
  name: "memory",
  activate: async (llm, ctx, channels): Promise<ActorActivateResult | null> => {
    const context = buildActorContext(ctx, channels, { maxTurns: ACTOR_CONTEXT_TURNS });
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await llm.chat(
        [
          { role: "system", content: MEMORY_ACTIVATE_PROMPT },
          { role: "user", content: context },
        ],
        { format: memoryActivateJsonSchema, temperature: 0 },
      );
      const parsed = tryParseJsonWithSchema(raw, memoryActivateSchema);
      if (!parsed.ok) continue;
      if (!parsed.value.active) return null;
      const intent = parsed.value.intent?.trim();
      if (!intent) return null;
      const tr = parsed.value.time_range;
      return {
        intent,
        timeRange:
          tr?.since_days_ago !== undefined || tr?.until_days_ago !== undefined
            ? { sinceDaysAgo: tr.since_days_ago, untilDaysAgo: tr.until_days_ago }
            : undefined,
      };
    }
    return null;
  },
  run: (_llm, input) => {
    const action = {
      kind: "memory" as const,
      intent: input.intent,
      timeRange: input.timeRange,
    };
    return runRecall({ ctx: input.ctx, action, ...input.deps });
  },
};
