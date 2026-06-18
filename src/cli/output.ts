import type { TurnResult } from "../orchestrator/turn.js";
import type { VerboseLogger } from "../util/verbose.js";

export function printTurnSummary(
  result: TurnResult,
  verbose: VerboseLogger,
): void {
  // 発話・成果物のユーザー出力は口の効果器（OutputChannel）経由（§効果器）。ここは要約/ログのみ。
  // `result.speech` は出力でなく無言判定の参照に使う（log 専用）。
  const parts = [`[state → ${result.nextState}]`];
  if (verbose.enabled) {
    parts.push(`turn=${result.turnId.slice(0, 8)}`);
    if (!result.speech) {
      parts.push("(無言ターン)");
    }
    if (!result.episodeSaved) {
      parts.push("(内省未保存)");
    }
  }
  console.log(parts.join(" "));
  if (verbose.enabled && result.episodeSaved) {
    console.error(
      `[verbose] 内省を書き込み済み (${result.introspection.length} chars)`,
    );
  }
}
