import { randomUUID } from "node:crypto";
import type { DialogueFormatOptions } from "../context/dialogue.js";
import {
  createTurnContext,
  renderIntrospectionPrompt,
  withAction,
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
import type { MemoIndexStore } from "../memory/memo-index.js";
import { presentSemanticFacts } from "../recall/semantic-present.js";
import { WorkingMemory } from "../memory/working.js";
import type { LlmClient } from "../llm/types.js";
import { runLanguage } from "../roles/language.js";
import { updateInnerState } from "../roles/inner-state.js";
import { extractEpisodeTags, runIntrospection } from "../roles/introspection.js";
import { applyNextState } from "../state/log.js";
import {
  buildRecallQuery,
  shouldPersistIntrospection,
} from "./episode-persist.js";
import { runMemoryAgent } from "../agents/memory.js";
import { runResearchAgent } from "../agents/research.js";
import type { VerboseLogger, VerboseLoggerImpl } from "../util/verbose.js";
import { noopVerbose } from "../util/verbose.js";
import { formatActionMeta } from "../action/types.js";
import type { RunActionDeps } from "../action/context.js";
import type { AgentState, ConversationTurn } from "../types.js";
import type { McpToolProvider } from "../mcp/types.js";
import type { CatalogTool } from "../tools/catalog.js";
import type { StateConfigEntry, RoleName } from "../config/settings.js";

export type TurnTrigger =
  | { type: "user_message"; content: string; speakerId: string }
  | { type: "heartbeat" };

export type TurnResult = {
  turnId: string;
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
  languageNumPredict?: number;
  timeZone?: string;
  getPersona: () => Promise<string>;
  dialogue: DialogueFormatOptions;
  actionDeps?: {
    mcp?: McpToolProvider;
    toolCatalog?: readonly CatalogTool[];
    expressDryRun?: boolean;
  };
  memoIndex?: MemoIndexStore;
  memoIndexTopK?: number;
  /** State 別コンテキスト設定。TurnContext に載せる量のみ絞る（元データ不変） */
  stateConfig?: Record<string, StateConfigEntry>;
  /** ロール別 LLM。未指定ロールは llm にフォールバック */
  roleLlm?: Partial<Record<RoleName, LlmClient>>;
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

    // Per-state config overrides (TurnContext への入力量を絞るのみ・元データ不変)
    const stateEntry = this.deps.stateConfig?.[startState] ?? {};
    const episodeRecallTopK = stateEntry.episodeRecallTopK ?? this.deps.episodeRecallTopK;
    const workingMemoryTurns = stateEntry.workingMemoryTurns;

    // ロール別 LLM（未指定はデフォルト llm にフォールバック）
    const rl = this.deps.roleLlm;
    const memoryLlm = rl?.memory ?? this.deps.llm;
    const researchLlm = rl?.research ?? this.deps.llm;
    const languageLlm = rl?.language ?? this.deps.llm;
    const introspectionLlm = rl?.introspection ?? this.deps.llm;
    const innerStateLlm = rl?.innerState ?? this.deps.llm;

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
      episodeRecallTopK,
      excludeTurnIds,
      startState,
    );
    v?.recall(recallQuery, recallHits, Date.now() - recallStart, {
      excludedTurnIds: [...excludeTurnIds],
    });

    const allRecentTurns = this.deps.workingMemory.getRecent();
    const recentTurns = workingMemoryTurns !== undefined
      ? allRecentTurns.slice(-workingMemoryTurns)
      : allRecentTurns;
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

    const memoHits = this.deps.memoIndex
      ? await this.deps.memoIndex.recall(recallQuery, this.deps.memoIndexTopK ?? 3)
      : [];

    let ctx = createTurnContext({
      turnId,
      state: startState,
      trigger,
      dialogue: this.deps.dialogue,
      recentTurns,
      recalledEpisodes: recalled,
      semanticFacts,
      recalledNotes: memoHits,
      innerState: this.innerState,
      now: turnNow,
      timeZone: this.deps.timeZone,
    });
    this.turnContext = ctx;
    v?.contextPhase("draft", ctx, { tokenBudget: this.deps.contextTokenBudget });

    const preprocessStart = Date.now();
    const draft = ctx;
    ctx = await fitTurnContext(
      this.deps.llm,
      ctx,
      this.deps.contextTokenBudget,
    );
    this.turnContext = ctx;
    v?.preprocess(draft, ctx, this.deps.contextTokenBudget, Date.now() - preprocessStart);

    // --- 共通 action deps ---
    const actionDeps: RunActionDeps = {
      episodes: this.deps.episodes,
      episodeRecallTopK: this.deps.episodeRecallTopK,
      mcp: this.deps.actionDeps?.mcp,
      toolCatalog: this.deps.actionDeps?.toolCatalog,
      expressDryRun: this.deps.actionDeps?.expressDryRun,
      memoIndex: this.deps.memoIndex,
    };

    // --- memory-agent ---
    const memStart = Date.now();
    const memOutcome = await runMemoryAgent(memoryLlm, ctx, actionDeps);
    if (memOutcome.attempted) {
      ctx = withAction(ctx, memOutcome);
      this.turnContext = ctx;
      v?.actionResult(memOutcome, Date.now() - memStart);
    }

    // --- research-agent ---
    const resStart = Date.now();
    const resOutcome = await runResearchAgent(researchLlm, ctx, actionDeps);
    if (resOutcome.attempted) {
      ctx = withAction(ctx, resOutcome);
      this.turnContext = ctx;
      v?.actionResult(resOutcome, Date.now() - resStart);
    }

    // --- language-agent（常に起動） ---
    const langStart = Date.now();
    ctx = withPersona(ctx, await this.deps.getPersona());
    try {
      const { speech, nextState } = await runLanguage(
        languageLlm,
        ctx,
        this.deps.languageNumPredict ?? 400,
      );
      ctx = withSpeech(ctx, speech.trim() || null);
      ctx = { ...ctx, nextState: nextState || startState };
      this.turnContext = ctx;
      v?.languageSpeech(ctx.speech ?? "", Date.now() - langStart);
    } catch (err) {
      ctx = withSpeech(ctx, null);
      ctx = { ...ctx, nextState: startState };
      this.turnContext = ctx;
      v?.languageSkipped(`LLM 失敗: ${err instanceof Error ? err.message : err}`);
    }

    if (ctx.speech) {
      if (trigger.type === "user_message") {
        this.deps.workingMemory.append({
          role: "assistant",
          content: ctx.speech,
        });
      } else {
        this.deps.workingMemory.append({
          role: "assistant",
          channel: "monologue",
          content: ctx.speech,
        });
      }
    }

    // --- 内省・内心更新 ---
    const persistEpisode = shouldPersistIntrospection(ctx);

    let introspection = "";
    let tags: string[] = [];
    let episodePersisted = false;

    if (persistEpisode) {
      try {
        v?.introspectionPrompt(renderIntrospectionPrompt(ctx));
        const introStart = Date.now();
        introspection = await runIntrospection(introspectionLlm, ctx);
        v?.introspectionBody(introspection, Date.now() - introStart);

        tags = await extractEpisodeTags(introspectionLlm, introspection);

        const prevInner = this.innerState;
        const innerStart = Date.now();
        this.innerState = await updateInnerState(innerStateLlm, {
          prevInnerState: prevInner,
          introspection,
          speech: ctx.speech ?? null,
          actions: ctx.actions,
          currentDateTime: ctx.currentDateTime,
        });
        v?.innerStateUpdate(prevInner, this.innerState, Date.now() - innerStart);

        const participants =
          trigger.type === "user_message" ? [trigger.speakerId] : [];
        const actionMeta = ctx.actions
          .filter((a): a is Extract<typeof a, { attempted: true }> => a.attempted)
          .map((a) => formatActionMeta(a))
          .filter(Boolean)
          .join("; ");

        const metadata = {
          timestamp: new Date().toISOString(),
          participants,
          tags: trigger.type === "heartbeat" ? ["heartbeat", ...tags] : tags,
          state: startState,
          action: actionMeta,
          source: "introspection" as const,
          reply: !!ctx.speech?.trim(),
          turnId,
        };
        await this.deps.episodes.append({ body: introspection, metadata });
        this.pushRecentEpisodeTurnId(turnId);
        v?.episodeSaved(metadata);
        episodePersisted = true;
      } catch (err) {
        v?.introspectionSkipped(`LLM 失敗: ${err instanceof Error ? err.message : err}`);
        v?.episodeSkipped("内省 LLM 失敗");
      }
    } else {
      v?.introspectionSkipped("idle heartbeat — actions 空 & speech 空");
      v?.episodeSkipped("idle heartbeat");
    }

    const prevState = this.state;
    this.state = applyNextState(this.state, ctx.nextState ?? this.state);
    await this.deps.onSessionPersist?.({
      state: this.state,
      workingMemory: this.deps.workingMemory.getRecent(),
      innerState: this.innerState,
    });
    v?.stateTransition(prevState, this.state);

    const result: TurnResult = {
      turnId,
      speech: ctx.speech ?? null,
      introspection,
      episodeSaved: episodePersisted,
      nextState: this.state,
    };

    this.turnContext = null;
    v?.contextDestroyed();
    v?.turnEnd(this.state);

    return result;
  }
}
