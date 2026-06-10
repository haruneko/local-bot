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
  "いまの内心（## いまの内心）または直近の独り言に、具体的な調査・探索の意欲が示されているか？",
  "（例: 「〜について調べよう」「〜を確認したい」「〜が気になる」など能動的な意図）",
  "→ ある: { \"active\": true, \"intent\": \"内心・独り言から読み取った具体的な検索意図\" }",
  "→ ない: { \"active\": false }",
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
  activate: createActivate("urlBrowse", "URL を直接閲覧して内容を取得する（会話に URL または明示的な参照先がある場合）"),
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps });
  },
};
