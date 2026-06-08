import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { TurnContext } from "../context/turn-context.js";
import { buildActorContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ActorName } from "../config/settings.js";
import { tryParseJsonWithSchema } from "../action/parse-json.js";

/** activator が 1 コールで返す有効 actor 仕様 */
export type ActiveActorSpec = {
  name: ActorName;
  intent: string;
  timeRange?: { sinceDaysAgo?: number; untilDaysAgo?: number };
};

const activeActorSchema = z.object({
  name: z.string(),
  intent: z.string(),
  time_range: z
    .object({
      since_days_ago: z.number().optional(),
      until_days_ago: z.number().optional(),
    })
    .optional(),
});

const activatorOutputSchema = z.object({
  active: z.array(activeActorSchema),
});

const activatorOutputJsonSchema = zodToJsonSchema(activatorOutputSchema, {
  name: "ActivatorOutput",
  $refStrategy: "none",
}) as Record<string, unknown>;

/** アクター名 → 1行説明 */
const ACTOR_DESCRIPTIONS: Partial<Record<ActorName, string>> = {
  recall:    "LanceDB から過去のエピソード記憶を検索・引き出す",
  remember:  "今ターンの出来事・情報を LanceDB に記録する",
  forget:    "指定した記憶を LanceDB からソフト削除する",
  memoWrite: "重要な情報をメモファイル（data/notes/）に書き込む",
  memoRead:  "メモファイルの内容を読み出す",
  webSearch: "Web 検索・URL 閲覧・外部 API で情報を取得する",
  urlBrowse: "URL を直接閲覧して内容を取得する",
  webcam:    "カメラ映像を取得して視覚情報を得る",
};

function buildActivatorSystem(actorNames: ActorName[]): string {
  const lines = [
    "あなたは行動の起動を判断するスクリーナーです。",
    "今の会話を読み、このターンで起動すべきアクターと意図（intent）を JSON で返してください。",
    "不要なアクターは含めないこと。迷ったら起動する方向で判断してください。",
    "",
    "【重要】内心（inner_state）について:",
    "内心は前ターンまでの感情の余韻です。内省プロセスが別途記録するため、",
    "remember・memoWrite で改めて記録する必要はありません。",
    "remember・memoWrite は「会話の中で新たに判明した事実・情報」がある場合のみ起動します。",
    "",
    "利用可能なアクター:",
    ...actorNames.map((name) => `- ${name}: ${ACTOR_DESCRIPTIONS[name] ?? name}`),
    "",
    '出力形式: { "active": [ { "name": "...", "intent": "..." }, ... ] }',
    "起動するアクターがない場合: { \"active\": [] }",
  ];
  return lines.join("\n");
}

/** activation screener。mini-context を見て起動すべき actor と intent を返す。
 *  パース失敗時は [] にフォールバック（false negative より false positive を許容）。 */
export async function runActivator(
  llm: LlmClient,
  ctx: TurnContext,
  actorNames: ActorName[],
): Promise<ActiveActorSpec[]> {
  if (actorNames.length === 0) return [];

  const userContent = buildActorContext(ctx, ["conversation", "inner_state"], {
    actorList: actorNames,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: buildActivatorSystem(actorNames) },
        { role: "user", content: userContent },
      ],
      { format: activatorOutputJsonSchema, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, activatorOutputSchema);
    if (!parsed.ok) continue;

    return parsed.value.active
      .filter((a) => actorNames.includes(a.name as ActorName) && a.intent.trim())
      .map((a) => ({
        name: a.name as ActorName,
        intent: a.intent.trim(),
        timeRange:
          a.time_range?.since_days_ago !== undefined ||
          a.time_range?.until_days_ago !== undefined
            ? {
                sinceDaysAgo: a.time_range.since_days_ago,
                untilDaysAgo: a.time_range.until_days_ago,
              }
            : undefined,
      }));
  }

  return [];
}
