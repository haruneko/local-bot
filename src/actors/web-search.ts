import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runResearchSubagent } from "../roles/subagent.js";

// DECISIONS.md §webSearch 自発起動（内心ドリブン）／集中モードの計画ドリブン
const WEB_SEARCH_ACTIVATE_PROMPT = [
  "あなたは webSearch の起動判定係です。",
  "以下の順で判断し、JSON を1つだけ返してください。",
  "",
  "【ステップ1: ユーザー指示チェック（優先）】",
  "直近の会話にユーザーからの明示的な検索・調査依頼（「調べて」「検索して」「〜は？」「〜を調べておいて」等）があるか？",
  "→ ある: { \"active\": true, \"intent\": \"ユーザーが求めた検索の具体的な内容\" }",
  "",
  "【ステップ2: 計画チェック（## 取り組み中の計画 があれば）】",
  "取り組み中の計画の「← いまここ」のマイルストーンを進めるために、**外界の事実**を調べる必要があるか？",
  "（例: 現在地が「〇〇のコード進行を調べる」なら、その曲のコード進行を検索する）",
  "→ ある: { \"active\": true, \"intent\": \"現在のマイルストーンを進める具体的な検索内容\" }",
  "",
  "【ステップ3: 内心チェック（上記が該当しない場合のみ）】",
  "いまの内心（## いまの内心）または直近の独り言に、外界の事実を能動的に調べたい意欲が示されているか？",
  "→ ある: { \"active\": true, \"intent\": \"内心・独り言から読み取った具体的な検索意図\" }",
  "→ ない: { \"active\": false }",
  "",
  "起動しない例（webSearch では扱わない）:",
  "- 自分の気持ち・好み・関係性・やりたいこと等、内面や相手との間にしかない話題",
  "- 記憶にあるか/覚えているかを問うもの（それは記憶側の仕事）",
  "- 雑談・挨拶・感情のやり取りだけ",
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
