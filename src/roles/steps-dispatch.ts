import { tryParseJsonWithSchema } from "../action/parse-json.js";
import { stepsDispatchJsonSchema, stepsDispatchSchema } from "../prompts/schemas.js";
import type { LlmClient } from "../llm/types.js";

/** 集中の dispatcher が選べる「手」と説明。集中で有効な doer のみ。 */
const HAND_DESCRIPTIONS: Record<string, string> = {
  // 「文章・段落・歌詞・まとめを書く/作る」は generation＝synthesize。memo ではない。
  synthesize: "文章・段落・歌詞・まとめを自分で書いて作る（生成。成果物に残す）",
  webSearch: "会話に無い外界の事実（最新・固有）を調べる",
  urlBrowse: "URL の中身を読む",
  // 既存の確かな事実を控える/読み返すだけ。文章を生み出すのは synthesize。
  memo: "既にある確かな事実を notes に控える・読み返す（生成はしない）",
};

export type StepsDispatch = { hand: string; intent: string };

/**
 * 集中の dispatcher（A・実行モード）。段取り中の current タスクを、使える手のどれで進めるか1つ選ぶ。
 * ＝「調べる」なら webSearch、「書く」なら synthesize…と手を取り違えない（生成器に研究を作話させない）。
 * 反応的＝今のマイルストーン（前ターンの受け入れ判定が置いたもの）を見て"どう実行するか"を選ぶだけ。
 */
export async function runStepsDispatcher(
  llm: LlmClient,
  input: {
    goal: string;
    currentTask: string;
    worksExcerpt: string;
    recentActions: string;
    hands: string[];
  },
): Promise<StepsDispatch | null> {
  const hands = input.hands.filter((h) => HAND_DESCRIPTIONS[h]);
  if (hands.length === 0) return null;

  const system = [
    "今のマイルストーンを、どの手で進めるか決めます。手を一つ選び、JSON を一つだけ返してください。",
    "",
    `{"hand":"${hands.join("|")}|none","intent":"具体的な一手"}`,
    "",
    "使える手：",
    ...hands.map((h) => `- ${h}: ${HAND_DESCRIPTIONS[h]}`),
    "",
    "- **外界の事実（部品の仕様・値段・最新情報・実在のやり方など）を根拠に要する**のに**まだ調べていない**なら、書く前に必ず webSearch で実データを取る。**記憶や推測で外界の事実を書かない（作話になる）**。「選定」「まとめ」でも根拠が未取得なら先に調べる。",
    "- **直近でその情報をもう調べてある**（直近でやったことに結果がある）なら、また調べず synthesize で結論・選定・まとめを書く（works に残す）。同じことを繰り返し調べない。",
    "- このマイルストーンが**自分の手で実行できないこと**（楽器の練習・実際の配線や工作・掃除・買い物など物理/現実の行動）なら、代わりの『ガイド』『メモ』を書いてごまかさず、hand に \"none\" を返す。",
  ].join("\n");
  const user = [
    input.goal ? `目標：${input.goal}` : "",
    `現在のマイルストーン：${input.currentTask}`,
    input.recentActions.trim()
      ? `\n直近でやったこと：\n${input.recentActions}`
      : "",
    input.worksExcerpt.trim()
      ? `\nこれまでの成果物（抜粋）：\n${input.worksExcerpt}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const format = stepsDispatchJsonSchema as Record<string, unknown>;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { format, temperature: 0 },
    );
    const parsed = tryParseJsonWithSchema(raw, stepsDispatchSchema);
    if (!parsed.ok) continue;
    const hand = parsed.value.hand.trim();
    if (hand === "none") return { hand: "none", intent: "" }; // どの手でもできない＝呼び出し側が shelve
    const intent = parsed.value.intent.trim();
    if (hands.includes(hand) && intent) return { hand, intent };
  }
  return null;
}
