import type { TurnTrigger } from "../orchestrator/turn.js";
import type { ChatMessage, ChatOptions } from "../llm/types.js";
import {
  redactTurnContextForLog,
  type TurnContext,
} from "../context/turn-context.js";
import type {
  ActionOutcome,
  AgentState,
} from "../types.js";
import type { EpisodeMetadata } from "../types.js";
import type { EpisodeRecallHit } from "../memory/episode.js";
import type { SemanticRecallHit } from "../memory/semantic.js";
import type { SemanticFactView } from "../recall/semantic-present.js";
import { estimateTokens } from "./tokens.js";

/** ログ詳細度。quiet=サマリ出力なし、info=1ターン十数行の構造化サマリ、debug=全文ダンプ */
export type LogLevel = "quiet" | "info" | "debug";

export interface VerboseLogger {
  readonly enabled: boolean;
}

export const noopVerbose: VerboseLogger = { enabled: false };

export function createVerboseLogger(level: "info" | "debug" = "debug"): VerboseLoggerImpl {
  return new VerboseLoggerImpl(level);
}

export class VerboseLoggerImpl implements VerboseLogger {
  readonly enabled = true;

  private turnId = "";
  private turnStartedAt = 0;

  constructor(readonly level: "info" | "debug" = "debug") {}

  private get isDebug(): boolean {
    return this.level === "debug";
  }

  /** debug 用: タイトル＋本文の全文ダンプ */
  private write(title: string, body?: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`\n[verbose ${ts}] ${title}`);
    if (body) console.error(body);
  }

  private json(label: string, value: unknown): void {
    this.write(label, JSON.stringify(value, null, 2));
  }

  /** info 用: 1行コンパクトログ（タイムスタンプ＋ターン短縮ID付き） */
  private line(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    const tid = this.turnId ? this.turnId.slice(0, 8) : "--------";
    console.error(`[${ts} ${tid}] ${msg}`);
  }

  startup(info: Record<string, unknown>): void {
    if (this.isDebug) {
      this.write("══════ local-bot verbose ══════");
      this.json("boot", info);
      return;
    }
    this.line(
      `local-bot up — chat=${info.chatModel} memory=${info.memory} state=${info.initialState}`,
    );
  }

  turnBegin(turnId: string, trigger: TurnTrigger, state: AgentState): void {
    this.turnId = turnId;
    this.turnStartedAt = Date.now();
    if (this.isDebug) {
      this.write("────── TURN BEGIN ──────");
      this.json("turn", { turnId, trigger, stateAtStart: state });
      return;
    }
    const desc =
      trigger.type === "user_message"
        ? `user(${trigger.speakerId}): "${oneLine(trigger.content, 40)}"`
        : "heartbeat";
    this.line(`▶ ${desc} [state=${state}]`);
  }

  workingMemory(turns: unknown): void {
    if (this.isDebug) this.json("working_memory", turns);
  }

  recall(
    query: string,
    hits: EpisodeRecallHit[],
    ms: number,
    extra?: { excludedTurnIds?: string[] },
  ): void {
    if (this.isDebug) {
      this.json("episode_recall", {
        query: query || "(empty)",
        count: hits.length,
        excludedTurnIds: extra?.excludedTurnIds ?? [],
        ms,
        hits: hits.map((h) => ({
          distance: h.distance,
          bodyPreview: h.body.slice(0, 120),
        })),
      });
      return;
    }
    this.line(`recall ep hits=${hits.length} q="${oneLine(query, 30)}" (${ms}ms)`);
  }

  affectUpdate(prev: string, next: string, ms: number): void {
    if (this.isDebug) {
      this.json("inner_state", {
        ms,
        prev: prev.trim() || "(empty)",
        next: next.trim() || "(empty)",
      });
    }
  }

  semanticRecall(
    query: string,
    hits: SemanticRecallHit[],
    presented: SemanticFactView[],
    ms: number,
  ): void {
    if (this.isDebug) {
      this.json("semantic_recall", {
        query: query || "(empty)",
        hitCount: hits.length,
        keptCount: presented.length,
        ms,
        hits: hits.map((h) => ({
          distance: h.distance,
          confidence: h.confidence,
          bodyPreview: h.body.slice(0, 120),
        })),
        presented: presented.map((f) => f.body),
      });
      return;
    }
    this.line(`recall sem kept=${presented.length}/${hits.length} (${ms}ms)`);
  }

  recallFilter(
    raw: EpisodeRecallHit[],
    filtered: { presented: string; relevance: number; presentation: string }[],
    ms: number,
  ): void {
    if (this.isDebug) {
      this.json("recall_distance.filter", {
        rawCount: raw.length,
        keptCount: filtered.length,
        ms,
        raw: raw.map((h) => ({
          distance: h.distance,
          bodyPreview: h.body.slice(0, 120),
        })),
        kept: filtered.map((e) => ({
          relevance: e.relevance,
          presentation: e.presentation,
          presentedPreview: e.presented.slice(0, 120),
        })),
      });
      return;
    }
    this.line(`  ep kept=${filtered.length}/${raw.length} (${ms}ms)`);
  }

  /** activator: 起動した actor とその件数 */
  actorsActivated(
    active: { name: string; intent: string }[],
    total: number,
    ms: number,
  ): void {
    if (this.isDebug) {
      this.json("activator", {
        total,
        activeCount: active.length,
        ms,
        active: active.map((a) => ({ name: a.name, intent: a.intent })),
      });
      return;
    }
    const names =
      active.length === 0
        ? "(なし)"
        : active.map((a) => `${a.name}「${oneLine(a.intent, 24)}」`).join(", ");
    this.line(`actors ${active.length}/${total}: ${names} (${ms}ms)`);
  }

  contextPhase(
    label: string,
    ctx: TurnContext,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.isDebug) return;
    const redacted = redactTurnContextForLog(ctx);
    const serialized = JSON.stringify(ctx);
    this.json(`context.${label}`, {
      estimatedTokens: estimateTokens(serialized),
      ...extra,
      ...redacted,
    });
  }

  preprocess(
    before: TurnContext,
    after: TurnContext,
    budget: number,
    ms: number,
  ): void {
    const b = estimateTokens(JSON.stringify(before));
    const a = estimateTokens(JSON.stringify(after));
    const summarized =
      b !== a || JSON.stringify(before) !== JSON.stringify(after);
    if (this.isDebug) {
      this.json("preprocess", {
        tokenBudget: budget,
        tokensBefore: b,
        tokensAfter: a,
        summarized,
        ms,
      });
      if (b !== a) {
        this.contextPhase("after_preprocess", after);
      }
      return;
    }
    if (summarized) {
      this.line(`preprocess summarized ${b}→${a}tok / budget=${budget} (${ms}ms)`);
    }
  }

  actionSkipped(): void {
    if (this.isDebug) this.write("action", "(skipped — ACTION.kind is none)");
  }

  actionResult(outcome: ActionOutcome, ms: number): void {
    if (this.isDebug) {
      this.json("action", { ms, ...outcome });
      return;
    }
    if (!outcome.attempted) return;
    const tag = outcome.status === "succeeded" ? "ok" : "FAIL";
    this.line(`action ${outcome.kind} ${tag} — ${oneLine(outcome.summary, 60)}`);
  }

  languageSkipped(reason: string): void {
    if (this.isDebug) this.write("language", `(skipped — ${reason})`);
    else this.line(`language skipped — ${oneLine(reason, 80)}`);
  }

  languageSpeech(speech: string, ms: number): void {
    if (this.isDebug) {
      this.json("language", { ms, chars: speech.length, speech });
      return;
    }
    this.line(
      speech
        ? `language spoke ${speech.length}字 (${ms}ms)`
        : `language silent (${ms}ms)`,
    );
  }

  introspectionBody(body: string, ms: number): void {
    if (this.isDebug) this.json("introspection.output", { ms, body });
    else this.line(`introspection ${body.length}字 (${ms}ms)`);
  }

  introspectionSkipped(reason: string): void {
    if (this.isDebug) this.write("introspection", `(skipped — ${reason})`);
    else this.line(`introspection skipped — ${oneLine(reason, 60)}`);
  }

  episodeSaved(meta: EpisodeMetadata): void {
    if (this.isDebug) {
      this.json("episode.append", meta);
      return;
    }
    this.line(`episode saved imp=${meta.importance ?? "-"} tags=[${meta.tags.join(",")}]`);
  }

  episodeSkipped(reason: string): void {
    if (this.isDebug) this.write("episode.append", `(skipped — ${reason})`);
  }

  stateTransition(from: AgentState, to: AgentState): void {
    if (this.isDebug) this.json("state", { from, to });
    else if (from !== to) this.line(`state ${from}→${to}`);
  }

  planProcessor(completedIds: string[], allDone: boolean): void {
    if (this.isDebug) this.json("plan.processor", { completedIds, allDone });
    else this.line(`plan ✓ ${completedIds.join(",")}${allDone ? " (達成)" : ""}`);
  }

  contextDestroyed(): void {
    if (this.isDebug) this.write("context", "turn context destroyed");
  }

  turnEnd(nextState: AgentState): void {
    const ms = Date.now() - this.turnStartedAt;
    if (this.isDebug) {
      this.json("turn.complete", { turnId: this.turnId, nextState, totalMs: ms });
      this.write("────── TURN END ──────");
      return;
    }
    this.line(`■ done ${ms}ms`);
  }

  llm(
    role: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    response: string,
    ms: number,
  ): void {
    // info ではフェーズ単位の ms（recall / actors / language / introspection）で
    // レイテンシを追えるため、呼び出しごとの llm 行は出さない（debug のみ全文）。
    if (!this.isDebug) return;
    this.write(`llm.${role} (${ms}ms)`);
    console.error(
      "--- request ---\n" +
        messages
          .map((m) => `[${m.role}]\n${truncate(m.content, 4000)}`)
          .join("\n\n"),
    );
    if (options?.format) {
      console.error(
        "--- format ---\n" +
          (typeof options.format === "string"
            ? options.format
            : JSON.stringify(options.format).slice(0, 500)),
      );
    }
    console.error(`--- response (${response.length} chars) ---\n${response}`);
  }

  error(phase: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.isDebug) this.write(`ERROR @ ${phase}`, msg);
    else this.line(`ERROR @ ${phase}: ${oneLine(msg, 120)}`);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(${text.length - max} more chars)`;
}

/** 改行を潰して1行に収め、max 超過は … で切る（info ログ用） */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * system プロンプトの特徴文字列から LLM コールのロールを推定する（debug ログ用）。
 * 判定順は重要: 「内省」を含むプロンプトが複数あるため（tags・内心・夢）、
 * それらを内省の前に判定する。
 */
export function detectLlmRole(messages: ChatMessage[]): string {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";

  // 言語野（対話・heartbeat）— 出力スキーマの "speech" が固有の目印
  if (sys.includes('"speech"')) return "language";

  // actor の起動判定（activate）— actor 名まで出す
  const act = sys.match(/あなたは\s*(\S+?)\s*の起動判定係/);
  if (act) return `activate.${act[1]}`;

  // サブエージェントのツール選択
  if (sys.includes("カテゴリ内のツールを1つ選び")) return "subagent.pick";

  // memory 系 actor 本体
  if (sys.includes("認識して選ぶ")) return "memo.recall_pick";
  if (sys.includes("木構造に整理")) return "memo.descend";
  if (sys.includes("メモへの操作（op）")) return "memo.op";
  if (sys.includes("記憶候補から")) return "forget.pick";

  // 内省テキストからのタグ抽出（「内省」を含むので introspection より先）
  if (sys.includes("名詞タグ")) return "tags";

  // 想起の提示・行動要約
  if (sys.includes("エピソード記憶の断片")) return "recall.present";
  if (sys.includes("記憶（LanceDB）の検索結果")) return "recall.action";

  // 夢の蒸留（「内省断片」を含むので introspection より先）
  if (sys.includes("蒸留")) return "dream.distill";

  // 内心更新 → 内省（内心が先。両方「内省」を含む）
  if (sys.includes("前の内心")) return "inner_state";
  if (sys.includes("内省")) return "introspection";

  // preprocess のチャンネル要約
  if (sys.includes("要約機")) return "preprocess.summarize";

  return "unknown";
}
