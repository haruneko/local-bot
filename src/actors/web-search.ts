import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runResearchSubagent } from "../roles/subagent.js";

// DECISIONS.md §webSearch 自発起動（内心ドリブン）／集中モードの計画ドリブン
const WEB_SEARCH_ACTIVATE_PROMPT = [
  "いまの会話を読み、**外の世界の事実を新しく調べに行く必要があるか**だけを判断してください。",
  "",
  "軸はこの一点：**この問い／いま取り組んでいることを前に進めるのに、会話の中には無い「外界の事実」（最新・固有・要検証の事柄）が要るか？**",
  "- 要る（今流行りの曲は？、明日の天気、ニュース、店の営業時間 等）→ { \"active\": true, \"intent\": \"調べる内容\" }",
  "- 問いが**記憶・気持ち・好み・関係性・自分の内面**についてなら、外を調べる必要はない → { \"active\": false }",
  "",
  "トリガーはユーザーの依頼・取り組み中の計画（## 取り組み中の計画 の「← いまここ」を進めるため）・自分の好奇心（## いまの内心 や直近の独り言）のどれでもよいが、軸は上の一点だけ。",
  "「〜は？」の形でも、外界の事実が要らないなら調べに行かない。",
].join("\n");

export const webSearchActor: ActorRunner = {
  name: "webSearch",
  activate: createActivate("webSearch", "", { systemPrompt: WEB_SEARCH_ACTIVATE_PROMPT }),
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};

export const urlBrowseActor: ActorRunner = {
  name: "urlBrowse",
  activate: createActivate(
    "urlBrowse",
    "会話に実際の URL（http/https）や明示された外部参照先があるとき、" +
      "または取り組み中の計画（## 取り組み中の計画）の現在のマイルストーンを進めるために特定ページを開く必要があるときに起動する。" +
      "対象 URL/参照先が無いとき、内省・感情・記憶・雑談だけのときは起動しない（推測で URL を作らない）",
  ),
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
