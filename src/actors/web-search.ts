import type { ActorRunner } from "./types.js";
import { buildActorContext } from "../context/turn-context.js";
import { runResearchSubagent } from "../roles/subagent.js";

export const webSearchActor: ActorRunner = {
  name: "webSearch",
  // 起動判定は multi-label（1発）が criteria を見て決める。
  criteria:
    "会話に無い「外界の事実」（最新・固有・要検証＝今流行りの曲・明日の天気・店の営業時間 等）を新しく調べに行く必要があるとき。" +
    "問いが記憶・気持ち・好み・関係性・自分の内面についてなら起動しない。",
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    // 検索は web_search（Tavily＝綺麗）のみ。browse_url を選ばせない（検索ページのゴミ回避）
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps }, ["web_search"]);
  },
};

// 客観ゲート（DECISIONS.md「起動が客観条件で決まる actor は機械ゲート可」）:
// urlBrowse は行動に「実際の URL」という具体物が要る＝起動条件は判断でなく事実。
// 会話/計画に http(s):// が在るときだけ起動する（LLM 判定は不要・推測 URL を作らないので過剰発火しない）。
const URL_RE = /https?:\/\/[^\s)>\]"'）」]+/g;
const URL_BROWSE_CONTEXT_TURNS = 3;

export const urlBrowseActor: ActorRunner = {
  name: "urlBrowse",
  activate: async (_llm, ctx, channels) => {
    const text = buildActorContext(ctx, channels, { maxTurns: URL_BROWSE_CONTEXT_TURNS });
    const urls = text.match(URL_RE);
    if (!urls?.length) return null;
    const unique = [...new Set(urls)];
    return { intent: `会話に出た次の URL を開いて中身を読む: ${unique.join(" ")}` };
  },
  run: (llm, input) => {
    const action = { kind: "research" as const, intent: input.intent };
    // URL 閲覧は browse_url のみ（会話に実 URL があるとき起動）
    return runResearchSubagent(llm, { ctx: input.ctx, action, ...input.deps }, ["browse_url"]);
  },
};
