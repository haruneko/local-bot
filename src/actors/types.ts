import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import type { RunActionDeps } from "../action/context.js";
import type { ActorName, ContextChannel } from "../config/settings.js";

export type ActorRunInput = {
  ctx: TurnContext;
  intent: string;
  timeRange?: { sinceDaysAgo?: number; untilDaysAgo?: number };
  /** 複数 op を持つ actor が activate で選んだ操作（例: memory の想起/忘却） */
  op?: string;
  /** 宣言チャンネル（actor が自身の LLM コールで使うコンテキスト範囲） */
  channels: ContextChannel[];
  deps: RunActionDeps;
};

export type ActorActivateResult = {
  intent: string;
  timeRange?: { sinceDaysAgo?: number; untilDaysAgo?: number };
  /** 複数 op を持つ actor が activate 時に選んだ操作 */
  op?: string;
};

export type ActorRunner = {
  readonly name: ActorName;
  /**
   * 起動判定。判断系 actor は `criteria`（multi-label が1発で判定）、
   * 客観/機械ゲート actor（urlBrowse など）は `activate` を実装する（どちらか一方）。
   */
  /** multi-label 起動判定の「起動条件」テキスト（判断系 actor）。 */
  criteria?: string;
  /** 自前の起動判定（客観/機械ゲート）。不要なら null を返す */
  activate?(
    llm: LlmClient,
    ctx: TurnContext,
    channels: ContextChannel[],
  ): Promise<ActorActivateResult | null>;
  run(llm: LlmClient, input: ActorRunInput): Promise<ActionOutcome>;
};
