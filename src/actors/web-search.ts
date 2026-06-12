import type { ActorRunner } from "./types.js";
import { createActivate } from "./activate.js";
import { runResearchSubagent } from "../roles/subagent.js";

// DECISIONS.md §webSearch 自発起動（内心ドリブン）
const WEB_SEARCH_ACTIVATE_PROMPT = [
  "あなたは webSearch の起動判定係です。",
  "以下の2段階で判断し、JSON を1つだけ返してください。",
  "",
  "【ステップ1: ユーザー指示チェック（優先）】",
  "直近の会話にユーザーからの明示的な検索・調査依頼（「調べて」「検索して」「〜は？」「〜を調べておいて」等）があるか？",
  "→ ある: { \"active\": true, \"intent\": \"ユーザーが求めた検索の具体的な内容\" }",
  "",
  "【ステップ2: 内心チェック（ステップ1が該当しない場合のみ）】",
  "いまの内心（## いまの内心）または直近の独り言に、**外界の事実**（ニュース・作品・用語・場所・データ等、自分の外にある情報）を能動的に調べたい意欲が示されているか？",
  "（例: 「〇〇という作品を調べよう」「最新の××を確認したい」）",
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
    "会話に実際の URL（http/https）や明示された外部参照先があり、その中身を取得する必要があるときだけ起動する。" +
      "URL が無いとき、内省・感情・記憶・雑談だけのときは起動しない（推測で URL を作らない）",
  ),
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
