import type { TurnResult } from "../orchestrator/turn.js";
import type { VerboseLogger } from "../util/verbose.js";

export function printTurnSummary(
  result: TurnResult,
  verbose: VerboseLogger,
): void {
  if (result.speech) console.log(result.speech);
  // 成果物（生成物・調査結果・読み上げ）は speech とは別経路で全文出す。
  // チャット（テキスト）チャンネルなので常に提示する。音声チャンネルでは出さない設計。
  for (const artifact of result.artifacts) {
    console.log(`\n${artifact}`);
  }
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
