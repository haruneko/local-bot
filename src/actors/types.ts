import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ActionOutcome } from "../types.js";
import type { RunActionDeps } from "../action/context.js";
import type { ActorName, ContextChannel } from "../config/settings.js";

export type ActorRunInput = {
  ctx: TurnContext;
  intent: string;
  timeRange?: { sinceDaysAgo?: number; untilDaysAgo?: number };
  /** 宣言チャンネル（actor が自身の LLM コールで使うコンテキスト範囲） */
  channels: ContextChannel[];
  deps: RunActionDeps;
};

export type ActorRunner = {
  readonly name: ActorName;
  run(llm: LlmClient, input: ActorRunInput): Promise<ActionOutcome>;
};
