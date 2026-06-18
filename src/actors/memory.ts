import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ActorRunner, ActorActivateResult } from "./types.js";
import { buildActorContext } from "../context/turn-context.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { runRecall } from "../roles/recall.js";
import { runForget } from "../roles/forget.js";

// B'（記憶/記録の分割統治・DECISIONS §記憶 faculty）:
// recall（想起）と forget（忘却）を「記憶」という1つの受動 faculty に束ねる。
// エピソード記憶に対してできるのは Read(想起) と Delete(忘却) だけ＝受動。
// 能動的な Create/Update（書き込み）は無い（符号化は内省の importance 採点）。
// ノートの読み書き（CRUD）は別 faculty = memo（記録）。
const MEMORY_ACTIVATE_PROMPT = [
  "会話を読み、記憶を思い出す(recall)・忘れる(forget)・どちらもしない、のどれかを判断してください。",
  "",
  '- 過去の出来事や約束を思い出したい → { "active": true, "op": "recall", "intent": "思い出したい内容" }',
  '- はっきり「忘れて／記憶から消して」と頼まれた → { "active": true, "op": "forget", "intent": "手放す対象" }',
  '- どちらも不要 → { "active": false }',
].join("\n");

const memoryActivateSchema = z.object({
  active: z.boolean(),
  intent: z.string().optional(),
  op: z.enum(["recall", "forget"]).optional(),
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
        op: parsed.value.op ?? "recall",
        timeRange:
          tr?.since_days_ago !== undefined || tr?.until_days_ago !== undefined
            ? { sinceDaysAgo: tr.since_days_ago, untilDaysAgo: tr.until_days_ago }
            : undefined,
      };
    }
    return null;
  },
  run: (llm, input) => {
    if (input.op === "forget") {
      const action = { kind: "memory" as const, intent: input.intent };
      return runForget(llm, { ctx: input.ctx, action, ...input.deps });
    }
    const action = {
      kind: "memory" as const,
      intent: input.intent,
      timeRange: input.timeRange,
    };
    return runRecall({ ctx: input.ctx, action, ...input.deps });
  },
};
