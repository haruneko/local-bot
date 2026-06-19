import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { TurnContext } from "../context/turn-context.js";
import { buildActorContext } from "../context/turn-context.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";
import type { LlmClient } from "../llm/types.js";
import type { ContextChannel } from "../config/settings.js";
import type { ActorRunner } from "../actors/types.js";

/** activator が返す有効 actor 仕様 */
export type ActiveActorSpec = {
  name: import("../config/settings.js").ActorName;
  intent: string;
  timeRange?: { sinceDaysAgo?: number; untilDaysAgo?: number };
  /** 複数 op を持つ actor が activate で選んだ操作 */
  op?: string;
};

type ActorSpec = {
  actor: ActorRunner;
  llm: LlmClient;
  channels: ContextChannel[];
};

const ACTOR_CONTEXT_TURNS = 3;

/**
 * 自前 activate を持つ actor（客観/機械ゲート＝urlBrowse 等）を並列実行して起動リストを返す。
 * 判断系（criteria を持つ）actor は runMultiLabelActivator が1発でまとめて判定する。
 */
export async function runActivator(
  ctx: TurnContext,
  actorSpecs: ActorSpec[],
): Promise<ActiveActorSpec[]> {
  if (actorSpecs.length === 0) return [];

  const results = await Promise.all(
    actorSpecs.map(async ({ actor, llm, channels }): Promise<ActiveActorSpec | null> => {
      if (!actor.activate) return null;
      const result = await actor.activate(llm, ctx, channels);
      if (!result) return null;
      return { name: actor.name, intent: result.intent, timeRange: result.timeRange, op: result.op };
    }),
  );

  return results.filter((r): r is ActiveActorSpec => r !== null);
}

/**
 * 判断系 actor（criteria を持つ）の起動を **1発の LLM 呼び出し**でまとめて判定する（multi-label）。
 * 4つの criteria を同時に見るので、memo/steps/synthesize の三つ巴の過剰発火を joint 判断で抑えられる
 * （別々に判定すると各 gate が他を知らず各自 active と言いがち）。実測で別々より正確かつ速い。
 */
export async function runMultiLabelActivator(
  llm: LlmClient,
  ctx: TurnContext,
  channels: ContextChannel[],
  actors: ActorRunner[],
): Promise<ActiveActorSpec[]> {
  const judges = actors.filter((a) => a.criteria);
  if (judges.length === 0) return [];

  const shape: z.ZodRawShape = {};
  for (const a of judges) shape[a.name] = z.object({ active: z.boolean(), intent: z.string().optional() });
  const schema = z.object(shape);
  // name を付けない＝$ref ラッパを作らず inline スキーマにする（Ollama が入れ子を grammar で強制できる）
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;

  const keys = judges.map((a) => a.name);
  const system = [
    "会話を読み、次の各機能をこのターンで起動すべきかを一度に判断してください。",
    `次のキーをすべて含む JSON オブジェクトを1つだけ出力してください: ${keys.join(", ")}`,
    '各キーの値は {"active":bool,"intent":"具体的な意図"}。起動不要なキーは {"active":false}。',
    `例: {${keys.map((k) => `"${k}":{"active":false}`).join(",")}}`,
    "",
    ...judges.map((a) => `- ${a.name}: ${a.criteria}`),
  ].join("\n");
  const user = buildActorContext(ctx, channels, { maxTurns: ACTOR_CONTEXT_TURNS });

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { format: jsonSchema, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, schema);
    if (!parsed.ok) continue;
    const value = parsed.value as Record<string, { active: boolean; intent?: string }>;
    const specs: ActiveActorSpec[] = [];
    for (const a of judges) {
      const d = value[a.name];
      const intent = d?.intent?.trim();
      if (d?.active && intent) specs.push({ name: a.name, intent });
    }
    return specs;
  }
  return [];
}
