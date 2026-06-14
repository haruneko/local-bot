import type { EpisodeStore } from "../memory/episode.js";
import type { MemoIndexStore } from "../memory/memo-index.js";
import type { TurnContext } from "../context/turn-context.js";
import type { McpToolProvider } from "../mcp/types.js";
import type { CatalogTool } from "../tools/catalog.js";
import { EmptyMcpToolProvider } from "../mcp/client.js";
import type { AbstractAction } from "./types.js";

export type RunActionDeps = {
  episodes: EpisodeStore;
  episodeRecallTopK: number;
  /** 明示的 recall actor での距離上限。未設定は 0.45（＝背景 fullMax・厳しくしすぎない） */
  explicitRecallMaxDistance?: number;
  mcp?: McpToolProvider;
  toolCatalog?: readonly CatalogTool[];
  expressDryRun?: boolean;
  memoIndex?: MemoIndexStore;
};

export type RunActionInput = {
  ctx: TurnContext;
  /** このターンでの実行アクション（ツール役はここから intent と kind を読む） */
  action: AbstractAction;
} & RunActionDeps;

export function defaultRunActionDeps(
  episodes: EpisodeStore,
  episodeRecallTopK: number,
  overrides: Partial<RunActionDeps> = {},
): RunActionDeps {
  return {
    episodes,
    episodeRecallTopK,
    mcp: overrides.mcp ?? new EmptyMcpToolProvider(),
    toolCatalog: overrides.toolCatalog ?? [],
    expressDryRun: overrides.expressDryRun ?? true,
    ...overrides,
  };
}

export function lastUserMessageFromContext(ctx: TurnContext): string | undefined {
  if (ctx.trigger.type === "user_message") {
    return ctx.trigger.content;
  }
  return undefined;
}
