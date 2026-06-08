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

export interface VerboseLogger {
  readonly enabled: boolean;
}

export const noopVerbose: VerboseLogger = { enabled: false };

export function createVerboseLogger(): VerboseLoggerImpl {
  return new VerboseLoggerImpl();
}

export class VerboseLoggerImpl implements VerboseLogger {
  readonly enabled = true;

  private turnId = "";
  private turnStartedAt = 0;

  private write(title: string, body?: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`\n[verbose ${ts}] ${title}`);
    if (body) console.error(body);
  }

  private json(label: string, value: unknown): void {
    this.write(label, JSON.stringify(value, null, 2));
  }

  startup(info: Record<string, unknown>): void {
    this.write("══════ local-bot verbose ══════");
    this.json("boot", info);
  }

  turnBegin(turnId: string, trigger: TurnTrigger, state: AgentState): void {
    this.turnId = turnId;
    this.turnStartedAt = Date.now();
    this.write("────── TURN BEGIN ──────");
    this.json("turn", { turnId, trigger, stateAtStart: state });
  }

  workingMemory(turns: unknown): void {
    this.json("working_memory", turns);
  }

  recall(
    query: string,
    hits: EpisodeRecallHit[],
    ms: number,
    extra?: { excludedTurnIds?: string[] },
  ): void {
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
  }

  innerStateUpdate(prev: string, next: string, ms: number): void {
    this.json("inner_state", {
      ms,
      prev: prev.trim() || "(empty)",
      next: next.trim() || "(empty)",
    });
  }

  semanticRecall(
    query: string,
    hits: SemanticRecallHit[],
    presented: SemanticFactView[],
    ms: number,
  ): void {
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
  }

  recallFilter(
    raw: EpisodeRecallHit[],
    filtered: { presented: string; relevance: number; presentation: string }[],
    ms: number,
  ): void {
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
  }

  contextPhase(
    label: string,
    ctx: TurnContext,
    extra?: Record<string, unknown>,
  ): void {
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
    this.json("preprocess", {
      tokenBudget: budget,
      tokensBefore: b,
      tokensAfter: a,
      summarized:
        b !== a ||
        JSON.stringify(before) !== JSON.stringify(after),
      ms,
    });
    if (b !== a) {
      this.contextPhase("after_preprocess", after);
    }
  }

  actionSkipped(): void {
    this.write("action", "(skipped — ACTION.kind is none)");
  }

  actionResult(outcome: ActionOutcome, ms: number): void {
    this.json("action", { ms, ...outcome });
  }

  languageSkipped(reason: string): void {
    this.write("language", `(skipped — ${reason})`);
  }

  languageSpeech(speech: string, ms: number): void {
    this.json("language", {
      ms,
      chars: speech.length,
      speech,
    });
  }

  introspectionPrompt(prompt: string): void {
    this.write("introspection.input", prompt);
  }

  introspectionBody(body: string, ms: number): void {
    this.json("introspection.output", { ms, body });
  }

  introspectionSkipped(reason: string): void {
    this.write("introspection", `(skipped — ${reason})`);
  }

  episodeSaved(meta: EpisodeMetadata): void {
    this.json("episode.append", meta);
  }

  episodeSkipped(reason: string): void {
    this.write("episode.append", `(skipped — ${reason})`);
  }

  stateTransition(from: AgentState, to: AgentState): void {
    this.json("state", { from, to });
  }

  contextDestroyed(): void {
    this.write("context", "turn context destroyed");
  }

  turnEnd(nextState: AgentState): void {
    const ms = Date.now() - this.turnStartedAt;
    this.json("turn.complete", { turnId: this.turnId, nextState, totalMs: ms });
    this.write("────── TURN END ──────");
  }

  llm(
    role: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    response: string,
    ms: number,
  ): void {
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
    this.write(`ERROR @ ${phase}`, msg);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(${text.length - max} more chars)`;
}

export function detectLlmRole(messages: ChatMessage[]): string {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  if (sys.includes("行動くん")) return "action";
  if (sys.includes("キャラクタールールに従い")) return "language";
  if (sys.includes("エピソード記憶の断片")) return "recall.present";
  if (sys.includes("記憶（LanceDB）の検索結果")) return "recall.action";
  if (sys.includes("前の内心")) return "inner_state";
  if (sys.includes("内省")) return "introspection";
  if (sys.includes("要約機")) return "preprocess.summarize";
  return "unknown";
}
