import { randomUUID } from "node:crypto";
import type { DialogueFormatOptions } from "../context/dialogue.js";
import {
  createTurnContext,
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
import { updateAffectAndConcern } from "../roles/inner-state.js";
import { extractEpisodeTags, runIntrospection } from "../roles/introspection.js";
import { applyNextState } from "../state/log.js";
import {
  buildRecallQuery,
  shouldPersistIntrospection,
} from "./episode-persist.js";
import { runActivator } from "./activator.js";
import { getActor } from "../actors/registry.js";
import type { VerboseLogger, VerboseLoggerImpl } from "../util/verbose.js";
import { noopVerbose } from "../util/verbose.js";
import { formatActionMeta } from "../action/types.js";
import type { RunActionDeps } from "../action/context.js";
import type { AgentState, ConversationTurn } from "../types.js";
import type { McpToolProvider } from "../mcp/types.js";
import type { CatalogTool } from "../tools/catalog.js";
import type {
  ActorName,
  ContextChannel,
  RoleName,
  StateResolved,
} from "../config/settings.js";
import { DEFAULT_ACTOR_CHANNELS } from "../config/settings.js";

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
  /** 全実行 actors 用モデル。未設定は llm にフォールバック */
  actionLlm?: LlmClient;
  /** actor の起動判定（activate）用モデル。未設定は actionLlm にフォールバック。
   *  RUN 用の重いモデルと分離し、起動判定を常に軽く保つ */
  activatorLlm?: LlmClient;
  episodes: EpisodeStore;
  semantic: SemanticStore;
  workingMemory: WorkingMemory;
  episodeRecallTopK: number;
  semanticRecallTopK: number;
  semanticRecallMaxDistance: number;
  recencyExclusionTurns: number;
  recallDistanceThresholds: RecallDistanceThresholds;
  initialAffect?: string;
  initialConcern?: string;
  contextTokenBudget: number;
  languageNumPredict?: number;
  timeZone?: string;
  getPersona: () => Promise<string>;
  dialogue: DialogueFormatOptions;
  actionDeps?: {
    mcp?: McpToolProvider;
    toolCatalog?: readonly CatalogTool[];
    expressDryRun?: boolean;
    explicitRecallMaxDistance?: number;
  };
  memoIndex?: MemoIndexStore;
  memoIndexTopK?: number;
  /** State に応じた設定を毎ターン解決するリゾルバ */
  resolveForState: (state: string) => StateResolved;
  /** actor ごとの知覚チャンネル（設定解決済み）。未設定は DEFAULT_ACTOR_CHANNELS を使用 */
  actorChannels?: Partial<Record<ActorName, ContextChannel[]>>;
  /** actor ごとの LLM（設定解決済み）。未設定は actionLlm にフォールバック */
  actorLlm?: Partial<Record<ActorName, LlmClient>>;
  /** ロール別 LLM（language / introspection / affect）。未指定は llm にフォールバック */
  roleLlm?: Partial<Record<RoleName, LlmClient>>;
  onSessionPersist?: (session: {
    state: AgentState;
    workingMemory: readonly ConversationTurn[];
    affect: string;
    concern: string;
  }) => Promise<void>;
  verbose?: VerboseLogger;
};

/** 抑制バッファの有効ターン数 */
const INHIBITION_WINDOW_TURNS = 4;

export class TurnOrchestrator {
  private turnContext: TurnContext | null = null;
  private affect: string;
  private concern: string;
  private readonly recentEpisodeTurnIds: string[] = [];
  /** 直近ターンで想起済みのベクトル群。INHIBITION_WINDOW_TURNS ターン後に期限切れ */
  private readonly inhibitionBuffer: { vector: number[]; expiresAtTurn: number }[] = [];
  private turnCount = 0;

  constructor(
    private state: AgentState,
    private readonly deps: TurnDeps,
  ) {
    this.affect = deps.initialAffect ?? "";
    this.concern = deps.initialConcern ?? "";
  }

  getAffect(): string {
    return this.affect;
  }

  getConcern(): string {
    return this.concern;
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

  private addToInhibitionBuffer(hits: readonly { vector?: number[] }[]): void {
    const expires = this.turnCount + INHIBITION_WINDOW_TURNS;
    for (const hit of hits) {
      if (hit.vector) this.inhibitionBuffer.push({ vector: hit.vector, expiresAtTurn: expires });
    }
  }

  private getActiveInhibitionVectors(): number[][] {
    const now = this.turnCount;
    for (let i = this.inhibitionBuffer.length - 1; i >= 0; i--) {
      if (this.inhibitionBuffer[i]!.expiresAtTurn <= now) {
        this.inhibitionBuffer.splice(i, 1);
      }
    }
    return this.inhibitionBuffer.map((e) => e.vector);
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
      affect: this.affect,
      concern: this.concern,
    });
  }

  /** ターン実行中のみ。終了後は null */
  getTurnContext(): TurnContext | null {
    return this.turnContext;
  }

  /** debug ログ用ロガー（quiet/info-only のときは null）。verbose メソッド呼び出しは v?. で行う */
  private get vlog(): VerboseLoggerImpl | null {
    const log = this.deps.verbose ?? noopVerbose;
    return log.enabled ? (log as VerboseLoggerImpl) : null;
  }

  async run(trigger: TurnTrigger): Promise<TurnResult> {
    const turnId = randomUUID();
    const startState = this.state;
    const v = this.vlog;

    // Per-state config: State が変わるたびに再解決される
    const { enabledActors, episodeRecallTopK, workingMemoryTurns } =
      this.deps.resolveForState(startState);

    // LLM 解決
    const actionLlm = this.deps.actionLlm ?? this.deps.llm;
    const activatorLlm = this.deps.activatorLlm ?? actionLlm;
    const rl = this.deps.roleLlm;
    const languageLlm = rl?.language ?? this.deps.llm;
    const introspectionLlm = rl?.introspection ?? this.deps.llm;
    const affectLlm = rl?.affect ?? this.deps.llm;

    this.turnCount++;
    v?.turnBegin(turnId, trigger, startState);

    if (trigger.type === "user_message") {
      this.deps.workingMemory.append({
        role: "user",
        speakerId: trigger.speakerId,
        content: trigger.content,
      });
    }
    v?.workingMemory(this.deps.workingMemory.getRecent());

    const turnNow = new Date();
    const clock = buildContextClock(turnNow, this.deps.timeZone);
    const allRecentTurns = this.deps.workingMemory.getRecent();
    const recentTurns = workingMemoryTurns !== undefined
      ? allRecentTurns.slice(-workingMemoryTurns)
      : allRecentTurns;

    // --- プリプロセス: 想起 ---
    const { recalled, semanticFacts, memoHits } = await this.recallMemories(
      trigger,
      startState,
      episodeRecallTopK,
      clock.currentDateTime,
    );

    let ctx = createTurnContext({
      turnId,
      state: startState,
      trigger,
      dialogue: this.deps.dialogue,
      recentTurns,
      recalledEpisodes: recalled,
      semanticFacts,
      recalledNotes: memoHits,
      affect: this.affect,
      concern: this.concern,
      now: turnNow,
      timeZone: this.deps.timeZone,
    });
    this.turnContext = ctx;
    v?.contextPhase("draft", ctx, { tokenBudget: this.deps.contextTokenBudget });

    const preprocessStart = Date.now();
    const draft = ctx;
    ctx = await fitTurnContext(this.deps.llm, ctx, this.deps.contextTokenBudget);
    this.turnContext = ctx;
    v?.preprocess(draft, ctx, this.deps.contextTokenBudget, Date.now() - preprocessStart);

    const actionDeps: RunActionDeps = {
      episodes: this.deps.episodes,
      episodeRecallTopK: this.deps.episodeRecallTopK,
      explicitRecallMaxDistance: this.deps.actionDeps?.explicitRecallMaxDistance,
      mcp: this.deps.actionDeps?.mcp,
      toolCatalog: this.deps.actionDeps?.toolCatalog,
      expressDryRun: this.deps.actionDeps?.expressDryRun,
      memoIndex: this.deps.memoIndex,
    };

    // --- activate → actor pool ---
    ctx = await this.runActorPool(ctx, enabledActors, actionLlm, activatorLlm, actionDeps);

    // --- language-agent（常に起動） ---
    ctx = await this.generateSpeech(ctx, trigger, languageLlm, startState);

    // --- 内省・内心更新 ---
    const { introspection, episodePersisted } = await this.persistReflection(
      ctx,
      trigger,
      startState,
      turnId,
      introspectionLlm,
      affectLlm,
    );

    // --- State 遷移・永続化 ---
    const prevState = this.state;
    this.state = applyNextState(this.state, ctx.nextState ?? this.state);
    await this.deps.onSessionPersist?.({
      state: this.state,
      workingMemory: this.deps.workingMemory.getRecent(),
      affect: this.affect,
      concern: this.concern,
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

  /** プリプロセス: 想起クエリ決定 → エピソード/意味記憶/memoIndex 想起。null クエリは全スキップ */
  private async recallMemories(
    trigger: TurnTrigger,
    startState: AgentState,
    episodeRecallTopK: number,
    currentDateTime: string,
  ): Promise<{
    recalled: Awaited<ReturnType<typeof presentRecallEpisodes>>;
    semanticFacts: ReturnType<typeof presentSemanticFacts>;
    memoHits: Awaited<ReturnType<MemoIndexStore["recall"]>>;
  }> {
    const v = this.vlog;
    const recallQuery = buildRecallQuery(
      trigger,
      this.deps.workingMemory.lastUserContent(),
      this.deps.workingMemory.lastAssistantContent(),
      this.affect,
      this.concern,
    );
    if (recallQuery === null) {
      return { recalled: [], semanticFacts: [], memoHits: [] };
    }

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

    this.addToInhibitionBuffer(recallHits);

    const filterStart = Date.now();
    const triggerLabel =
      trigger.type === "user_message"
        ? trigger.content
        : `（ハートビート・${startState}）`;
    const recalled = await presentRecallEpisodes(
      this.deps.llm,
      recallHits,
      { state: startState, currentDateTime, triggerLabel, recallQuery },
      this.deps.recallDistanceThresholds,
      {
        inhibitionBuffer: this.getActiveInhibitionVectors(),
        currentSpeaker:
          trigger.type === "user_message" ? trigger.speakerId : undefined,
      },
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

    return { recalled, semanticFacts, memoHits };
  }

  /** activate（各 actor 並列）→ 起動した actor を並列実行し ctx.actions に積む */
  private async runActorPool(
    ctx: TurnContext,
    enabledActors: ActorName[],
    actionLlm: LlmClient,
    activatorLlm: LlmClient,
    actionDeps: RunActionDeps,
  ): Promise<TurnContext> {
    const v = this.vlog;
    const actorStart = Date.now();
    const actorSpecs = enabledActors.flatMap((name) => {
      const actor = getActor(name);
      if (!actor) return [];
      return [{
        actor,
        // 起動判定は専用の軽量モデルで（RUN 用の actorLlm とは分離）
        llm: activatorLlm,
        channels: this.deps.actorChannels?.[name] ?? DEFAULT_ACTOR_CHANNELS[name],
      }];
    });
    const activeSpecs = await runActivator(ctx, actorSpecs);
    v?.actorsActivated(activeSpecs, actorSpecs.length, Date.now() - actorStart);

    const outcomes = await Promise.all(
      activeSpecs.map(async (spec) => {
        const actor = getActor(spec.name);
        if (!actor) return null;
        const channels =
          this.deps.actorChannels?.[spec.name] ??
          DEFAULT_ACTOR_CHANNELS[spec.name];
        const actorLlm = this.deps.actorLlm?.[spec.name] ?? actionLlm;
        return actor.run(actorLlm, {
          ctx,
          intent: spec.intent,
          timeRange: spec.timeRange,
          channels,
          deps: actionDeps,
        });
      }),
    );

    for (const outcome of outcomes) {
      if (outcome?.attempted) {
        ctx = withAction(ctx, outcome);
        this.turnContext = ctx;
        v?.actionResult(outcome, Date.now() - actorStart);
      }
    }
    return ctx;
  }

  /** language-agent（常に起動）。発話と NEXT_STATE を ctx に載せ、発話を作業記憶へ追加 */
  private async generateSpeech(
    ctx: TurnContext,
    trigger: TurnTrigger,
    languageLlm: LlmClient,
    startState: AgentState,
  ): Promise<TurnContext> {
    const v = this.vlog;
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
      this.deps.workingMemory.append(
        trigger.type === "user_message"
          ? { role: "assistant", content: ctx.speech }
          : { role: "assistant", channel: "monologue", content: ctx.speech },
      );
    }
    return ctx;
  }

  /** 内省 → タグ抽出 → 内心更新 → エピソード追記。idle heartbeat はスキップ */
  private async persistReflection(
    ctx: TurnContext,
    trigger: TurnTrigger,
    startState: AgentState,
    turnId: string,
    introspectionLlm: LlmClient,
    affectLlm: LlmClient,
  ): Promise<{ introspection: string; episodePersisted: boolean }> {
    const v = this.vlog;
    if (!shouldPersistIntrospection(ctx)) {
      v?.introspectionSkipped("idle heartbeat — actions 空 & speech 空");
      v?.episodeSkipped("idle heartbeat");
      return { introspection: "", episodePersisted: false };
    }

    // 内省の実プロンプト（role 構造のマルチターン）は withVerboseLlm が
    // debug レベルで実メッセージごとダンプするので、ここで再レンダリングしない。
    let introspection = "";
    try {
      const introStart = Date.now();
      const introResult = await runIntrospection(introspectionLlm, ctx);
      introspection = introResult.text;
      v?.introspectionBody(introspection, Date.now() - introStart);

      const tags = await extractEpisodeTags(introspectionLlm, introspection);

      const prevAffect = this.affect;
      const innerStart = Date.now();
      const affectResult = await updateAffectAndConcern(affectLlm, {
        prevAffect,
        prevConcern: this.concern,
        introspection,
        speech: ctx.speech ?? null,
        actions: ctx.actions,
        currentDateTime: ctx.currentDateTime,
      });
      this.affect = affectResult.affect;
      this.concern = affectResult.concern;
      v?.affectUpdate(prevAffect, this.affect, Date.now() - innerStart);

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
        importance: introResult.importance,
      };
      await this.deps.episodes.append({ body: introspection, metadata });
      this.pushRecentEpisodeTurnId(turnId);
      v?.episodeSaved(metadata);
      return { introspection, episodePersisted: true };
    } catch (err) {
      v?.introspectionSkipped(`LLM 失敗: ${err instanceof Error ? err.message : err}`);
      v?.episodeSkipped("内省 LLM 失敗");
      return { introspection, episodePersisted: false };
    }
  }
}
