import type { TurnResult } from "../orchestrator/turn.js";
import type { VerboseLogger } from "../util/verbose.js";

export function printTurnSummary(
  result: TurnResult,
  verbose: VerboseLogger,
): void {
  if (result.speech) console.log(result.speech);
  const parts = [`[state → ${result.nextState}]`];
  if (verbose.enabled) {
    parts.push(`turn=${result.turnId.slice(0, 8)}`);
    if (!result.speech && result.judge.REPLY === false) {
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
