import type { EpisodeStore } from "../memory/episode.js";
import type { TurnContext } from "../context/turn-context.js";

export type RunActionDeps = {
  episodes: EpisodeStore;
  episodeRecallTopK: number;
};

export type RunActionInput = {
  ctx: TurnContext;
} & RunActionDeps;

export function lastUserMessageFromContext(ctx: TurnContext): string | undefined {
  if (ctx.trigger.type === "user_message") {
    return ctx.trigger.content;
  }
  return undefined;
}
