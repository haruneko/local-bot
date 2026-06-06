import { randomUUID } from "node:crypto";
import type { DialogueFormatOptions } from "../context/dialogue.js";
import {
  createTurnContext,
  renderIntrospectionPrompt,
  withAction,
  withJudge,
  withPersona,
  withSpeech,
  type TurnContext,
} from "../context/turn-context.js";
import type { RecallDistanceThresholds } from "../recall/distance.js";
import { presentRecallEpisodes } from "../recall/llm-present.js";
import { fitTurnContext } from "../context/preprocess.js";
import { buildContextClock } from "../sensor/datetime.js";
import type { EpisodeStore } from "../memory/episode.js";
import { WorkingMemory } from "../memory/working.js";
import type { LlmClient } from "../llm/types.js";
import { runJudge } from "../roles/judge.js";
import { runLanguage as runLanguageRole } from "../roles/language.js";
import { runIntrospection } from "../roles/introspection.js";
import { applyNextState } from "../state/log.js";
import {
  buildRecallQuery,
  shouldPersistIntrospection,
  shouldRunLanguage,
} from "./episode-persist.js";
import type { VerboseLogger, VerboseLoggerImpl } from "../util/verbose.js";
import { noopVerbose } from "../util/verbose.js";
import { ACTION_ERROR_CODES } from "../action/error.js";
import { actionFailed } from "../action/outcome.js";
import { formatActionMeta, isActionAttempted } from "../action/types.js";
import type { RunActionInput } from "../roles/action.js";
import type { AgentState, ConversationTurn, JudgeOutput } from "../types.js";

export type TurnTrigger =
  | { type: "user_message"; content: string; speakerId: string }
  | { type: "heartbeat" };

export type TurnResult = {
  turnId: string;
  judge: JudgeOutput;
  speech: string | null;
  introspection: string;
  episodeSaved: boolean;
  nextState: AgentState;
};

export type TurnDeps = {
  llm: LlmClient;
  episodes: EpisodeStore;
  workingMemory: WorkingMemory;
  episodeRecallTopK: number;
  recallDistanceThresholds: RecallDistanceThresholds;
  contextTokenBudget: number;
  timeZone?: string;
  getPersona: () => Promise<string>;
  dialogue: DialogueFormatOptions;
  runAction?: (input: RunActionInput) => Promise<import("../types.js").ActionOutcome>;
  actionDeps?: {
    mcp?: import("../mcp/types.js").McpToolProvider;
    toolCatalog?: readonly import("../tools/catalog.js").CatalogTool[];
    expressDryRun?: boolean;
  };
  onSessionPersist?: (session: {
    state: AgentState;
    workingMemory: readonly ConversationTurn[];
  }) => Promise<void>;
  verbose?: VerboseLogger;
};

export class TurnOrchestrator {
  private turnContext: TurnContext | null = null;

  constructor(
    private state: AgentState,
    private readonly deps: TurnDeps,
  ) {}

  getState(): AgentState {
    return this.state;
  }

  setState(state: AgentState): void {
    this.state = state;
    void this.persistSession();
  }

  private persistSession(): void {
    void this.deps.onSessionPersist?.({
      state: this.state,
      workingMemory: this.deps.workingMemory.getRecent(),
    });
  }

  /** ターン実行中のみ。終了後は null */
  getTurnContext(): TurnContext | null {
    return this.turnContext;
  }

  async run(trigger: TurnTrigger): Promise<TurnResult> {
    const turnId = randomUUID();
    const startState = this.state;
    const log = this.deps.verbose ?? noopVerbose;
    const v: VerboseLoggerImpl | null = log.enabled
      ? (log as VerboseLoggerImpl)
      : null;

    v?.turnBegin(turnId, trigger, startState);

    if (trigger.type === "user_message") {
      this.deps.workingMemory.append({
        role: "user",
        speakerId: trigger.speakerId,
        content: trigger.content,
      });
    }
    v?.workingMemory(this.deps.workingMemory.getRecent());

    const recallQuery = buildRecallQuery(
      trigger,
      startState,
      this.deps.workingMemory.lastUserContent(),
    );
    const recallStart = Date.now();
    const recallHits = await this.deps.episodes.recall(
      recallQuery,
      this.deps.episodeRecallTopK,
    );
    v?.recall(recallQuery, recallHits, Date.now() - recallStart);

    const recentTurns = this.deps.workingMemory.getRecent();
    const turnNow = new Date();
    const clock = buildContextClock(turnNow, this.deps.timeZone);
    const filterStart = Date.now();
    const triggerLabel =
      trigger.type === "user_message"
        ? trigger.content
        : `（ハートビート・${startState}）`;
    const recalled = await presentRecallEpisodes(
      this.deps.llm,
      recallHits,
      {
        state: startState,
        currentDateTime: clock.currentDateTime,
        triggerLabel,
        recallQuery,
      },
      this.deps.recallDistanceThresholds,
    );
    v?.recallFilter(recallHits, recalled, Date.now() - filterStart);

    let ctx = createTurnContext({
      turnId,
      state: startState,
      trigger,
      dialogue: this.deps.dialogue,
      recentTurns,
      recalledEpisodes: recalled,
      now: turnNow,
      timeZone: this.deps.timeZone,
    });
    this.turnContext = ctx;
    v?.contextPhase("draft", ctx, {
      tokenBudget: this.deps.contextTokenBudget,
    });

    const preprocessStart = Date.now();
    const draft = ctx;
    ctx = await fitTurnContext(
      this.deps.llm,
      ctx,
      this.deps.contextTokenBudget,
    );
    this.turnContext = ctx;
    v?.preprocess(draft, ctx, this.deps.contextTokenBudget, Date.now() - preprocessStart);

    const judgeStart = Date.now();
    ctx = withJudge(ctx, await runJudge(this.deps.llm, ctx));
    this.turnContext = ctx;
    v?.judge(ctx.judge!, Date.now() - judgeStart);

    if (isActionAttempted(ctx.judge!.ACTION)) {
      const actionStart = Date.now();
      const actionInput: RunActionInput = {
        ctx,
        episodes: this.deps.episodes,
        episodeRecallTopK: this.deps.episodeRecallTopK,
        mcp: this.deps.actionDeps?.mcp,
        toolCatalog: this.deps.actionDeps?.toolCatalog,
        expressDryRun: this.deps.actionDeps?.expressDryRun,
      };
      ctx = withAction(
        ctx,
        this.deps.runAction
          ? await this.deps.runAction(actionInput)
          : actionFailed(ctx.judge!.ACTION, "行動くんが未接続", {
              code: ACTION_ERROR_CODES.ACTION_DISCONNECTED,
              message: "TurnDeps.runAction が設定されていない",
            }),
      );
      this.turnContext = ctx;
      v?.actionResult(ctx.action, Date.now() - actionStart);
    } else {
      v?.actionSkipped();
    }

    if (shouldRunLanguage(ctx)) {
      const langStart = Date.now();
      ctx = withPersona(ctx, await this.deps.getPersona());
      ctx = withSpeech(ctx, await runLanguageRole(this.deps.llm, ctx));
      this.turnContext = ctx;
      v?.languageSpeech(ctx.speech!, Date.now() - langStart);
      if (trigger.type === "user_message") {
        this.deps.workingMemory.append({
          role: "assistant",
          content: ctx.speech!,
        });
      } else {
        this.deps.workingMemory.append({
          role: "assistant",
          channel: "monologue",
          content: ctx.speech!,
        });
      }
    } else {
      v?.languageSkipped(
        trigger.type === "heartbeat"
          ? "REPLY=false & ACTION なし/失敗"
          : "REPLY=false",
      );
    }

    const persistEpisode = shouldPersistIntrospection(ctx);

    let introspection = "";
    if (persistEpisode) {
      v?.introspectionPrompt(renderIntrospectionPrompt(ctx));
      const introStart = Date.now();
      introspection = await runIntrospection(this.deps.llm, ctx);
      v?.introspectionBody(introspection, Date.now() - introStart);
    } else {
      v?.introspectionSkipped("idle heartbeat — ACTION/REPLY なし");
    }

    const participants =
      trigger.type === "user_message" ? [trigger.speakerId] : [];

    if (persistEpisode) {
      const metadata = {
        timestamp: new Date().toISOString(),
        participants,
        tags: trigger.type === "heartbeat" ? (["heartbeat"] as string[]) : [],
        state: startState,
        action: formatActionMeta(ctx.judge!.ACTION),
        source: "introspection" as const,
        reply: ctx.reply ?? false,
        turnId,
      };
      await this.deps.episodes.append({
        body: introspection,
        metadata,
      });
      v?.episodeSaved(metadata);
    } else {
      v?.episodeSkipped("idle heartbeat");
    }

    const prevState = this.state;
    this.state = applyNextState(this.state, ctx.judge!.NEXT_STATE);
    await this.deps.onSessionPersist?.({
      state: this.state,
      workingMemory: this.deps.workingMemory.getRecent(),
    });
    v?.stateTransition(prevState, this.state);

    const result: TurnResult = {
      turnId,
      judge: ctx.judge!,
      speech: ctx.speech ?? null,
      introspection,
      episodeSaved: persistEpisode,
      nextState: this.state,
    };

    this.turnContext = null;
    v?.contextDestroyed();
    v?.turnEnd(this.state);

    return result;
  }
}
