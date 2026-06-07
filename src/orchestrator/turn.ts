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
import type { SemanticStore } from "../memory/semantic.js";
import { presentSemanticFacts } from "../recall/semantic-present.js";
import { WorkingMemory } from "../memory/working.js";
import type { LlmClient } from "../llm/types.js";
import { runJudge } from "../roles/judge.js";
import { runLanguage as runLanguageRole } from "../roles/language.js";
import { updateInnerState } from "../roles/inner-state.js";
import { extractEpisodeTags, runIntrospection } from "../roles/introspection.js";
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
  semantic: SemanticStore;
  workingMemory: WorkingMemory;
  episodeRecallTopK: number;
  semanticRecallTopK: number;
  semanticRecallMaxDistance: number;
  recencyExclusionTurns: number;
  recallDistanceThresholds: RecallDistanceThresholds;
  initialInnerState?: string;
  contextTokenBudget: number;
  /** 言語野の通常応答トークン上限。-1 = 無制限（未設定時は 400） */
  languageNumPredict?: number;
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
    innerState: string;
  }) => Promise<void>;
  verbose?: VerboseLogger;
};

export class TurnOrchestrator {
  private turnContext: TurnContext | null = null;
  private innerState: string;
  private readonly recentEpisodeTurnIds: string[] = [];

  constructor(
    private state: AgentState,
    private readonly deps: TurnDeps,
  ) {
    this.innerState = deps.initialInnerState ?? "";
  }

  getInnerState(): string {
    return this.innerState;
  }

  private excludeTurnIds(): ReadonlySet<string> {
    return new Set(this.recentEpisodeTurnIds);
  }

  private pushRecentEpisodeTurnId(turnId: string): void {
    this.recentEpisodeTurnIds.push(turnId);
    const max = this.deps.recencyExclusionTurns;
    while (this.recentEpisodeTurnIds.length > max) {
      this.recentEpisodeTurnIds.shift();
    }
  }

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
      innerState: this.innerState,
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
    const excludeTurnIds = this.excludeTurnIds();
    const recallHits = await this.deps.episodes.recall(
      recallQuery,
      this.deps.episodeRecallTopK,
      excludeTurnIds,
      startState,
    );
    v?.recall(recallQuery, recallHits, Date.now() - recallStart, {
      excludedTurnIds: [...excludeTurnIds],
    });

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

    const semanticStart = Date.now();
    const semanticHits = await this.deps.semantic.recall(
      recallQuery,
      this.deps.semanticRecallTopK,
    );
    const semanticFacts = presentSemanticFacts(
      semanticHits,
      this.deps.semanticRecallMaxDistance,
    );
    v?.semanticRecall(recallQuery, semanticHits, semanticFacts, Date.now() - semanticStart);

    let ctx = createTurnContext({
      turnId,
      state: startState,
      trigger,
      dialogue: this.deps.dialogue,
      recentTurns,
      recalledEpisodes: recalled,
      semanticFacts,
      innerState: this.innerState,
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
      ctx = withSpeech(
        ctx,
        await runLanguageRole(this.deps.llm, ctx, this.deps.languageNumPredict ?? 400),
      );
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
    let tags: string[] = [];
    if (persistEpisode) {
      v?.introspectionPrompt(renderIntrospectionPrompt(ctx));
      const introStart = Date.now();
      introspection = await runIntrospection(this.deps.llm, ctx);
      v?.introspectionBody(introspection, Date.now() - introStart);

      tags = await extractEpisodeTags(this.deps.llm, introspection);

      const prevInner = this.innerState;
      const innerStart = Date.now();
      this.innerState = await updateInnerState(this.deps.llm, {
        prevInnerState: prevInner,
        introspection,
        speech: ctx.speech ?? null,
        action: ctx.action,
        currentDateTime: ctx.currentDateTime,
      });
      v?.innerStateUpdate(prevInner, this.innerState, Date.now() - innerStart);
    } else {
      v?.introspectionSkipped("idle heartbeat — ACTION/REPLY なし");
    }

    const participants =
      trigger.type === "user_message" ? [trigger.speakerId] : [];

    if (persistEpisode) {
      const metadata = {
        timestamp: new Date().toISOString(),
        participants,
        tags: trigger.type === "heartbeat" ? ["heartbeat", ...tags] : tags,
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
      this.pushRecentEpisodeTurnId(turnId);
      v?.episodeSaved(metadata);
    } else {
      v?.episodeSkipped("idle heartbeat");
    }

    const prevState = this.state;
    this.state = applyNextState(this.state, ctx.judge!.NEXT_STATE);
    await this.deps.onSessionPersist?.({
      state: this.state,
      workingMemory: this.deps.workingMemory.getRecent(),
      innerState: this.innerState,
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
