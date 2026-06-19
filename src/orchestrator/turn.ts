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
import type { EpisodeRecallHit, EpisodeStore } from "../memory/episode.js";
import type { SemanticStore } from "../memory/semantic.js";
import type { MemoIndexStore } from "../memory/memo-index.js";
import type { XmodalStore } from "../memory/xmodal-lancedb.js";
import type { XmodalEmbedder, XmodalInput } from "../embedding/xmodal.js";
import { reciprocalRankFusion } from "../recall/fuse.js";
import { presentSemanticFacts } from "../recall/semantic-present.js";
import { collectUserArtifacts, formatActionFactContent } from "../action/present.js";
import { WorkingMemory } from "../memory/working.js";
import type { LlmClient } from "../llm/types.js";
import { runLanguage } from "../roles/language.js";
import { updateAffectAndConcern } from "../roles/inner-state.js";
import { extractEpisodeTags, runIntrospection } from "../roles/introspection.js";
import {
  buildRecallQuery,
  shouldPersistIntrospection,
} from "./episode-persist.js";
import { runActivator, runMultiLabelActivator } from "./activator.js";
import { getActor } from "../actors/registry.js";
import { listPlans, loadPlan, savePlan } from "../plan/state.js";
import { renderPlanForLanguage } from "../plan/render.js";
import { planProgress, evaluateFocusGraduation } from "../plan/focus.js";
import { runPlanProcessor } from "../roles/plan-processor.js";
import { readNoteContent } from "../tools/notes.js";
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
  | {
      type: "user_message";
      content: string;
      speakerId: string;
      /** 相手が添えてきた画像（base64・文字起こししない）。あれば image_feed に乗る */
      images?: string[];
      /** 相手が添えてきた音声（base64・文字起こししない）。あれば audio_feed に乗る */
      audio?: string[];
    }
  | { type: "heartbeat" };

export type TurnResult = {
  turnId: string;
  speech: string | null;
  /** speech とは別経路でユーザーに全文提示する成果物（生成物・調査結果・読み上げ）。
   *  音声等、本文を読み上げない宛先では出力側が出さない選択をする */
  artifacts: string[];
  introspection: string;
  episodeSaved: boolean;
  nextState: AgentState;
};

/** 口の効果器（OutputChannel）。発話＋成果物をユーザーへ届ける作用器（受容器の双対・docs/CONCEPT §効果器）。
 *  言語野の発話生成直後に呼ばれ、内省/affect の前に出力する（async-reflect）。speech が null なら成果物のみ。 */
export type OutputChannel = {
  say(speech: string | null, artifacts: string[]): void | Promise<void>;
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
  /** 横断（ImageBind 1024）ベクトルの別テーブル。未設定 = 横断オフ。 */
  xmodal?: XmodalStore;
  /** 横断 embedder。enabled=false / null 返し = 横断オフ（degrade）。 */
  xmodalEmbedder?: XmodalEmbedder;
  workingMemory: WorkingMemory;
  episodeRecallTopK: number;
  semanticRecallTopK: number;
  semanticRecallMaxDistance: number;
  recencyExclusionTurns: number;
  recallDistanceThresholds: RecallDistanceThresholds;
  /** 横断（ImageBind）ヒットのグラデーション閾値。未設定 = 横断既定（distance.ts）。 */
  xmodalRecallDistanceThresholds?: RecallDistanceThresholds;
  initialAffect?: string;
  initialConcern?: string;
  initialFocusPlan?: string;
  initialFocusStreak?: number;
  initialFocusStall?: number;
  initialFocusBaseline?: number;
  contextTokenBudget: number;
  languageNumPredict?: number;
  timeZone?: string;
  /** 視覚センサー: いま視界に入っているフレーム（base64）を返す。未設定 = 視覚オフ */
  readFrames?: () => string[] | Promise<string[]>;
  /** 自発 distill: 静穏 idle ハートビートで蒸留を回す。新素材が足りなければ内部でスキップする。
   *  未設定 = 自発 distill オフ（`npm run dream` の手動運用のみ） */
  runDistill?: () => Promise<{ ran: boolean; factsUpserted: number; skippedReason?: string }>;
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
    focusPlan: string;
    focusStreak: number;
    focusStall: number;
    focusBaseline: number;
  }) => Promise<void>;
  verbose?: VerboseLogger;
  /** 口の効果器。未注入なら出力は TurnResult 経由（pull・移行中の互換）。 */
  outputChannel?: OutputChannel;
};

/** 抑制バッファの有効ターン数 */
const INHIBITION_WINDOW_TURNS = 4;

/** 集中力の上限（強制ギプス・アドホック）。集中が連続でこのターン数続いたら「集中力が切れる」。
 *  ハートビートで未達 goal を永遠にループ＝「ずっと同じことを考え続ける」のを防ぐ＝人間の疲労の代替。 */
const MAX_FOCUS_STREAK = 10;

/** 進捗が無いまま集中したターンがこの数続いたら、その goal を見限る（卒業＝retired）。
 *  疲労（MAX_FOCUS_STREAK＝休む）より小さくして、進捗の出ない goal は休む前に見限られるようにする。 */
const MAX_FOCUS_STALL = 6;

export class TurnOrchestrator {
  private turnContext: TurnContext | null = null;
  private affect: string;
  private concern: string;
  private focusPlan: string;
  private focusStreak: number;
  private focusStall: number;
  private focusBaseline: number;
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
    this.focusPlan = deps.initialFocusPlan ?? "";
    this.focusStreak = deps.initialFocusStreak ?? 0;
    this.focusStall = deps.initialFocusStall ?? 0;
    this.focusBaseline = deps.initialFocusBaseline ?? 0;
  }

  getAffect(): string {
    return this.affect;
  }

  getConcern(): string {
    return this.concern;
  }

  /**
   * 進捗ベース卒業（達成不能 goal の見限り）。集中して focusPlan に取り組んでいるターンで、
   * 進捗（planProgress）が伸びないまま MAX_FOCUS_STALL 続いたら、その計画を retired にして手放す。
   * 疲労（focusStreak＝休む・goal は残す）と違い、こちらは「見限り」＝自動復帰しない。
   */
  private async applyFocusGraduation(): Promise<void> {
    if (this.state !== "集中" || !this.focusPlan) return;
    const plan = await loadPlan(this.focusPlan);
    if (!plan) return;
    const result = evaluateFocusGraduation({
      progress: planProgress(plan),
      stall: this.focusStall,
      baseline: this.focusBaseline,
      maxStall: MAX_FOCUS_STALL,
    });
    this.focusStall = result.stall;
    this.focusBaseline = result.baseline;
    if (result.graduated) {
      const now = new Date().toISOString();
      await savePlan({
        ...plan,
        retired: true,
        updatedAt: now,
        log: [
          ...plan.log,
          {
            date: now.slice(0, 10),
            text: `進捗が出ないので目標「${plan.title}」から一旦離れた`,
          },
        ],
      });
      this.focusPlan = "";
    }
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
      focusPlan: this.focusPlan,
      focusStreak: this.focusStreak,
      focusStall: this.focusStall,
      focusBaseline: this.focusBaseline,
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

  /** 計画チャンネル: 集中 State かつ取り組み中の計画があれば、その plan を render して返す */
  private async loadPlanChannel(state: AgentState): Promise<string> {
    if (state !== "集中" || !this.focusPlan) return "";
    const plan = await loadPlan(this.focusPlan);
    return plan ? renderPlanForLanguage(plan) : "";
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

    // 視覚チャンネル(image_feed): いま視界に入っているフレーム。
    // 相手が添えてきた画像（トリガー）を優先し、無ければファイルセンサー（環境の視界）にフォールバック。
    // 想起より先に確定させる＝横断で「いまの景色」を画像クエリにして引く（画像→画像 recognition）ため。
    const triggerImages =
      trigger.type === "user_message" ? trigger.images : undefined;
    const imageFeed = triggerImages?.length
      ? triggerImages
      : this.deps.readFrames
        ? await this.deps.readFrames()
        : [];
    // 聴覚チャンネル(audio_feed): 相手が添えてきた音声。現状は符号化の横断ベクトル付与のみが消費。
    const audioFeed =
      trigger.type === "user_message" ? (trigger.audio ?? []) : [];

    // --- プリプロセス: 想起 ---
    const { recalled, semanticFacts, memoHits } = await this.recallMemories(
      trigger,
      startState,
      episodeRecallTopK,
      clock.currentDateTime,
      imageFeed,
    );

    // plan processor（前判定・集中の背骨）: 集中中、作った成果物(works)と計画を突き合わせ、
    // 実際に満たされたマイルストーンを機械が✓して current を前へ進める（stuck ポインタの矯正を毎ターン頭で）。
    // これで計画チャンネルが実態を指し、書く人(synthesize)が常に正しい所を書ける。全✓なら締める。
    // 進行は「plan actor が発火するか」の博打でなく、集中中まわるこの機械フェーズが担う。
    let planCompletedThisTurn = false;
    // 集中の doer に渡す「いま取り組む単一タスク」（current マイルストーン本文）。計画全体は渡さない。
    let currentTask = "";
    if (startState === "集中" && this.focusPlan) {
      const focusPlanState = await loadPlan(this.focusPlan);
      if (focusPlanState && focusPlanState.milestones.length > 0 && !focusPlanState.retired) {
        const worksBody = (await readNoteContent(`works/${this.focusPlan}.md`)) ?? "";
        const processed = await runPlanProcessor(this.deps.llm, {
          plan: focusPlanState,
          worksBody,
        });
        if (processed.completedIds.length > 0) {
          await savePlan(processed.plan);
          v?.planProcessor(processed.completedIds, processed.allDone);
        }
        planCompletedThisTurn = processed.allDone;
        if (!processed.allDone) {
          const cur = processed.plan.milestones.find((m) => m.id === processed.plan.current);
          currentTask = cur?.text ?? "";
        }
      }
    }

    // 計画チャンネル: 集中 State のときだけ取り組み中のゴールノート全文を常駐させる
    // （processor で✓・current を更新済みの計画を読む）
    const plan = await this.loadPlanChannel(startState);

    let ctx = createTurnContext({
      turnId,
      state: startState,
      trigger,
      dialogue: this.deps.dialogue,
      recentTurns,
      recalledEpisodes: recalled,
      semanticFacts,
      recalledNotes: memoHits,
      imageFeed,
      audioFeed,
      affect: this.affect,
      concern: this.concern,
      plan,
      planId: this.focusPlan,
      currentTask,
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
      xmodal: this.deps.xmodal,
    };

    // --- activate → actor pool ---
    ctx = await this.runActorPool(ctx, enabledActors, actionLlm, activatorLlm, actionDeps);

    // plan actor の結果を収集する。focusPlan の付け替えは plan facts.action（手の意図）で決める：
    // activate=その計画を開始/再開（集中へ）／shelve・retire=いまの集中を手放す／create・update=変えない。
    // ＝「計画を作った/触った＝集中」でなく「明示 activate で開始」。うっかり集中を防ぐ。
    let planAchieved = false;
    let activatePlanId = "";
    let setAsidePlanId = "";
    for (const a of ctx.actions) {
      if (a.attempted && a.status === "succeeded" && a.facts?.kind === "plan") {
        if (a.facts.achieved) planAchieved = true;
        if (a.facts.action === "activate") activatePlanId = a.facts.planId;
        else if (a.facts.action === "shelve" || a.facts.action === "retire") {
          setAsidePlanId = a.facts.planId;
        }
      }
    }
    // ゴール達成 → 集中対象から外す。達成は plan actor（planAchieved）／plan processor の
    // 前判定（planCompletedThisTurn）どちらでも成立する。
    const prevFocusPlan = this.focusPlan;
    if (planAchieved || planCompletedThisTurn) this.focusPlan = "";

    // --- language-agent（常に起動） ---
    ctx = await this.generateSpeech(ctx, trigger, languageLlm);

    // 口の効果器: 発話＋成果物を即出力（push）。内省/affect はこの後＝async-reflect。
    // 行動(effect)は発話の上流＝ここで artifacts も確定済み。
    const artifacts = collectUserArtifacts(ctx.actions);
    if (this.deps.outputChannel && (ctx.speech || artifacts.length > 0)) {
      await this.deps.outputChannel.say(ctx.speech ?? null, artifacts);
    }

    // 入口/出口: 手（plan actor）の明示的な意図で focusPlan を動かす。
    // activate → その計画を開始/再開（集中へ）。shelve/retire → いまの集中を手放す。
    if (!planAchieved && !planCompletedThisTurn) {
      if (activatePlanId) {
        this.focusPlan = activatePlanId;
      } else if (setAsidePlanId && this.focusPlan === setAsidePlanId) {
        this.focusPlan = "";
      }
    }

    // 集中力の上限（強制ギプス）: 集中が MAX_FOCUS_STREAK ターン続いたら集中力が切れる。
    // focusPlan を一旦手放す（goal ノートは data/plans に残るので、後で表に出れば再開できる）。
    // これでハートビートの「ずっと同じことを考え続ける」無限ループを断つ。
    if (this.focusStreak >= MAX_FOCUS_STREAK) {
      this.focusPlan = "";
      this.focusStreak = 0;
    }

    // focusPlan が乗り換わった／手放された → 進捗ベース卒業の停滞カウントは新規にする
    // （別の目標の停滞を引き継がない・空になったらリセット）。
    if (this.focusPlan !== prevFocusPlan) {
      this.focusStall = 0;
      this.focusBaseline = 0;
    }

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
    // state は制御プレーン＝観測事実から導出する（言語野は宣言しない）。
    // 相手が喋った→対話（集中は中断されここへ戻る）／独りで取り組み中の計画がある→集中／
    // それ以外→静穏（集中でなければ静穏という residual）。
    this.state =
      trigger.type === "user_message"
        ? "対話"
        : this.focusPlan
          ? "集中"
          : "静穏";
    // 集中力カウンタ: 集中が続けば加算、抜けたら 0。MAX を超えると次ターンの強制ギプスで切れる。
    this.focusStreak = this.state === "集中" ? this.focusStreak + 1 : 0;
    // 進捗ベース卒業: 集中して取り組んでいるのに進捗が出ないターンが続いたら、その goal を見限る（retired）。
    await this.applyFocusGraduation();
    await this.deps.onSessionPersist?.({
      state: this.state,
      workingMemory: this.deps.workingMemory.getRecent(),
      affect: this.affect,
      concern: this.concern,
      focusPlan: this.focusPlan,
      focusStreak: this.focusStreak,
      focusStall: this.focusStall,
      focusBaseline: this.focusBaseline,
    });
    v?.stateTransition(prevState, this.state);

    // 自発 distill: 静穏 idle ハートビート（手が空いた時）に蒸留を回す。睡眠中の記憶整理のイメージ。
    // runDistill は dream-state で「新素材が足りなければ即スキップ」するので毎回呼んで安全。
    if (
      this.deps.runDistill &&
      trigger.type === "heartbeat" &&
      this.state === "静穏" &&
      !episodePersisted
    ) {
      try {
        const d = await this.deps.runDistill();
        if (v) {
          console.error(
            d.ran
              ? `[distill] ${d.factsUpserted} 件の意味記憶を蒸留`
              : `[distill] skip (${d.skippedReason ?? "新素材なし"})`,
          );
        }
      } catch (err) {
        v?.error("distill", err);
      }
    }

    const result: TurnResult = {
      turnId,
      speech: ctx.speech ?? null,
      artifacts,
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
    imageFeed: readonly string[],
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
    // 横断で「いまの景色」を画像クエリにして引けるなら、テキストクエリが無くても想起する（recognition）。
    const canXmodalImage =
      !!this.deps.xmodalEmbedder?.enabled &&
      !!this.deps.xmodal &&
      imageFeed.length > 0;
    if (recallQuery === null && !canXmodalImage) {
      return { recalled: [], semanticFacts: [], memoHits: [] };
    }
    const queryLabel = recallQuery ?? "（画像のみ・recognition）";

    const recallStart = Date.now();
    const excludeTurnIds = this.excludeTurnIds();
    // テキストチャンネルはテキストクエリがある時だけ。無ければ横断（画像）チャンネルのみで想起する。
    const textHits =
      recallQuery !== null
        ? await this.deps.episodes.recall(
            recallQuery,
            episodeRecallTopK,
            excludeTurnIds,
            startState,
          )
        : [];
    // 横断（ImageBind）が有効なら横断チャンネル（テキストクエリ／画像クエリ）を RRF で融合。
    // OFF（既定）/degrade は textHits のまま。
    const recallHits = await this.fuseXmodalRecall(
      recallQuery,
      textHits,
      episodeRecallTopK,
      excludeTurnIds,
      imageFeed,
    );
    v?.recall(queryLabel, recallHits, Date.now() - recallStart, {
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
      { state: startState, currentDateTime, triggerLabel, recallQuery: queryLabel },
      this.deps.recallDistanceThresholds,
      {
        inhibitionBuffer: this.getActiveInhibitionVectors(),
        currentSpeaker:
          trigger.type === "user_message" ? trigger.speakerId : undefined,
      },
      this.deps.xmodalRecallDistanceThresholds,
    );
    v?.recallFilter(recallHits, recalled, Date.now() - filterStart);

    // 意味記憶・memoIndex はテキスト想起のみ（テキストクエリが無ければスキップ）。
    const semanticStart = Date.now();
    const semanticHits =
      recallQuery !== null
        ? await this.deps.semantic.recall(recallQuery, this.deps.semanticRecallTopK)
        : [];
    const semanticFacts = presentSemanticFacts(
      semanticHits,
      this.deps.semanticRecallMaxDistance,
    );
    v?.semanticRecall(queryLabel, semanticHits, semanticFacts, Date.now() - semanticStart);

    const memoHits =
      this.deps.memoIndex && recallQuery !== null
        ? await this.deps.memoIndex.recall(recallQuery, this.deps.memoIndexTopK ?? 3)
        : [];

    return { recalled, semanticFacts, memoHits };
  }

  /**
   * テキスト想起に横断（ImageBind）チャンネルを RRF で融合する。横断クエリは2系統:
   * (a) テキストクエリ→知覚（text→image/audio）、(b) いまの画像→過去の画像（画像→画像 recognition）。
   * 横断 OFF / どのクエリも embed できない（サービス落ち）/ 横断ヒット 0 なら textHits をそのまま返す。
   * 横断のみで出た turnId は本文をハイドレートし距離は横断空間の値を載せる（別閾値・docs/ARCH-NEXT.md §4）。
   */
  private async fuseXmodalRecall(
    recallQuery: string | null,
    textHits: EpisodeRecallHit[],
    topK: number,
    excludeTurnIds: ReadonlySet<string>,
    imageFeed: readonly string[],
  ): Promise<EpisodeRecallHit[]> {
    const embedder = this.deps.xmodalEmbedder;
    const store = this.deps.xmodal;
    const getByTurnIds = this.deps.episodes.getByTurnIds?.bind(this.deps.episodes);
    if (!embedder?.enabled || !store || !getByTurnIds) return textHits;

    const queries: XmodalInput[] = [];
    if (recallQuery) queries.push({ kind: "text", text: recallQuery });
    if (imageFeed.length > 0) {
      queries.push({ kind: "image", imageBase64: imageFeed[0] });
    }
    if (queries.length === 0) return textHits;

    // 各横断クエリを別チャンネルとして RRF へ。距離は複数クエリに出たら近い方（min）を採る。
    const xmodalChannels: string[][] = [];
    const xDistById = new Map<string, number>();
    for (const q of queries) {
      const qv = await embedder.embed(q);
      if (!qv) continue; // このクエリだけ degrade
      const hits = (await store.recall(qv, topK)).filter(
        (h) => !excludeTurnIds.has(h.turnId),
      );
      if (hits.length === 0) continue;
      xmodalChannels.push(hits.map((h) => h.turnId));
      for (const h of hits) {
        const prev = xDistById.get(h.turnId);
        if (prev === undefined || h.distance < prev) xDistById.set(h.turnId, h.distance);
      }
    }
    if (xmodalChannels.length === 0) return textHits;

    const textById = new Map(textHits.map((h) => [h.turnId, h]));
    const fused = reciprocalRankFusion([
      textHits.map((h) => h.turnId),
      ...xmodalChannels,
    ]).slice(0, topK);

    const needHydrate = fused
      .map((f) => f.turnId)
      .filter((id) => !textById.has(id));
    const hydrated = needHydrate.length ? await getByTurnIds(needHydrate) : [];
    const hydratedById = new Map(
      hydrated.map((h) => [
        h.turnId,
        {
          ...h,
          distance: xDistById.get(h.turnId) ?? h.distance,
          space: "xmodal" as const,
        },
      ]),
    );

    const out: EpisodeRecallHit[] = [];
    for (const f of fused) {
      const hit = textById.get(f.turnId) ?? hydratedById.get(f.turnId);
      if (hit) out.push(hit);
    }
    return out.length ? out : textHits;
  }

  /**
   * 符号化時に知覚エピソード（画像 or 音声）へ横断ベクトルを付ける。画像を優先（omni の主入力）。
   * OFF/degrade/知覚なしなら何もしない。best-effort: 失敗しても本体エピソード（nomic）は残る＝turn を壊さない。
   */
  private async persistXmodalVector(
    turnId: string,
    imageFeed: readonly string[],
    audioFeed: readonly string[],
  ): Promise<void> {
    const embedder = this.deps.xmodalEmbedder;
    const store = this.deps.xmodal;
    if (!embedder?.enabled || !store) return;
    const input =
      imageFeed.length > 0
        ? ({ kind: "image", imageBase64: imageFeed[0] } as const)
        : audioFeed.length > 0
          ? ({ kind: "audio", audioBase64: audioFeed[0] } as const)
          : null;
    if (!input) return;
    try {
      const vec = await embedder.embed(input);
      if (vec) await store.append(turnId, vec);
    } catch {
      // 横断付与は best-effort
    }
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
    const runners = enabledActors.flatMap((name) => getActor(name) ?? []);
    // 判断系（criteria）は multi-label が1発でまとめて判定。客観/機械ゲート（activate）は別途。
    const criteriaActors = runners.filter((a) => a.criteria);
    const gateActors = runners.filter((a) => a.activate && !a.criteria);
    // multi-label の文脈は criteria 系チャンネルの和（plan を含む superset）。
    const multiChannels = [
      ...new Set(
        criteriaActors.flatMap(
          (a) => this.deps.actorChannels?.[a.name] ?? DEFAULT_ACTOR_CHANNELS[a.name],
        ),
      ),
    ];
    const gateSpecs = gateActors.map((actor) => ({
      actor,
      llm: activatorLlm,
      channels: this.deps.actorChannels?.[actor.name] ?? DEFAULT_ACTOR_CHANNELS[actor.name],
    }));
    const [multiActive, gateActive] = await Promise.all([
      runMultiLabelActivator(activatorLlm, ctx, multiChannels, criteriaActors),
      runActivator(ctx, gateSpecs),
    ]);
    const activeSpecs = [...multiActive, ...gateActive];
    v?.actorsActivated(activeSpecs, runners.length, Date.now() - actorStart);

    const runOne = (spec: (typeof activeSpecs)[number]) => {
      const actor = getActor(spec.name);
      if (!actor) return Promise.resolve(null);
      const channels =
        this.deps.actorChannels?.[spec.name] ?? DEFAULT_ACTOR_CHANNELS[spec.name];
      const actorLlm = this.deps.actorLlm?.[spec.name] ?? actionLlm;
      return actor.run(actorLlm, {
        ctx,
        intent: spec.intent,
        timeRange: spec.timeRange,
        op: spec.op,
        channels,
        deps: actionDeps,
      });
    };
    const append = (outcome: Awaited<ReturnType<typeof runOne>>) => {
      if (outcome?.attempted) {
        ctx = withAction(ctx, outcome);
        this.turnContext = ctx;
        v?.actionResult(outcome, Date.now() - actorStart);
      }
    };

    // plan は「実際に何が起きたか」を見て事後に記録する（意図でなく結果でグラウンディング）ため、
    // 他の actor を先に並列実行して ctx.actions に積んでから最後に走らせる。
    const others = activeSpecs.filter((s) => s.name !== "plan");
    const planSpec = activeSpecs.find((s) => s.name === "plan");

    for (const o of await Promise.all(others.map(runOne))) append(o);
    if (planSpec) {
      append(await runOne(planSpec));
    } else if (enabledActors.includes("plan") && ctx.state === "静穏" && !ctx.planId) {
      // idle backlog surface（静穏 idle の機械ゲート＝distill と同類の客観条件）:
      // 手が空いて取り組み中の計画が無いとき、未完の backlog があれば plan actor に
      // 「思い出して掴むか」を判断させる（activate するかは LLM・無ければ noop）。
      // ＝Tier 2 の自発の点火。常時 recall に plan を混ぜる過剰引力を避け、idle に限定する。
      const backlog = (await listPlans()).filter((p) => !p.done && !p.retired);
      if (backlog.length > 0) {
        append(
          await runOne({
            name: "plan",
            intent:
              "手が空いた。やりかけの計画があれば思い出して、いま再開する価値があるものだけ activate する。無理に始めなくてよい（無ければ noop）。",
          }),
        );
      }
    }

    return ctx;
  }

  /** language-agent（常に起動）。発話と NEXT_STATE を ctx に載せ、発話を作業記憶へ追加 */
  private async generateSpeech(
    ctx: TurnContext,
    trigger: TurnTrigger,
    languageLlm: LlmClient,
  ): Promise<TurnContext> {
    const v = this.vlog;
    const langStart = Date.now();
    ctx = withPersona(ctx, await this.deps.getPersona());
    try {
      const { speech } = await runLanguage(
        languageLlm,
        ctx,
        this.deps.languageNumPredict ?? 400,
      );
      ctx = withSpeech(ctx, speech.trim() || null);
      this.turnContext = ctx;
      v?.languageSpeech(ctx.speech ?? "", Date.now() - langStart);
    } catch (err) {
      ctx = withSpeech(ctx, null);
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

      // 裏打ちのある事実記録: 相手の発話＋行動結果（外界 grounded）。自分の発話は作話を含みうるので入れない。
      // 埋め込まない（メタなので想起検索に混ざらない）。夢が turnId 経由で引いて、本文でなくこれから蒸留する。
      const groundedParts: string[] = [];
      if (trigger.type === "user_message") {
        const name = ctx.dialogue.resolveUserDisplayName(trigger.speakerId);
        groundedParts.push(`${name}: ${trigger.content}`);
      }
      for (const a of ctx.actions) {
        if (a.attempted && a.status === "succeeded" && a.facts) {
          groundedParts.push(formatActionFactContent(a, "introspection"));
        }
      }
      const groundedFacts = groundedParts.join("\n\n");

      const metadata = {
        timestamp: new Date().toISOString(),
        participants,
        tags: trigger.type === "heartbeat" ? ["heartbeat", ...tags] : tags,
        state: startState,
        action: actionMeta,
        source: "introspection" as const,
        reply: !!ctx.speech?.trim(),
        turnId,
        importance: affectResult.importance,
        groundedFacts: groundedFacts || undefined,
      };
      await this.deps.episodes.append({ body: introspection, metadata });
      await this.persistXmodalVector(turnId, ctx.imageFeed, ctx.audioFeed);
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
