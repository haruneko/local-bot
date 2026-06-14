import type { TurnContext } from "../context/turn-context.js";
import type { LlmClient } from "../llm/types.js";
import type { ActorName, ContextChannel } from "../config/settings.js";
import type { ActorRunner } from "../actors/types.js";

/** activator が返す有効 actor 仕様 */
export type ActiveActorSpec = {
  name: ActorName;
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

/** 各 actor の activate() を並列実行して起動すべき actor リストを返す */
export async function runActivator(
  ctx: TurnContext,
  actorSpecs: ActorSpec[],
): Promise<ActiveActorSpec[]> {
  if (actorSpecs.length === 0) return [];

  const results = await Promise.all(
    actorSpecs.map(async ({ actor, llm, channels }): Promise<ActiveActorSpec | null> => {
      const result = await actor.activate(llm, ctx, channels);
      if (!result) return null;
      return {
        name: actor.name,
        intent: result.intent,
        timeRange: result.timeRange,
        op: result.op,
      };
    }),
  );

  return results.filter((r): r is ActiveActorSpec => r !== null);
}
