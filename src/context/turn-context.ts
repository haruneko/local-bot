import {
  formatActionForIntrospection,
  formatActionsForLanguage,
  silenceLine,
} from "../action/present.js";
import { actionLabelJa } from "../action/types.js";
import type { TurnTrigger } from "../orchestrator/turn.js";
import type {
  ActionOutcome,
  AgentState,
  ConversationTurn,
} from "../types.js";
import { buildContextClock, formatRelativeTime } from "../sensor/datetime.js";
import {
  formatDialogueTurn,
  formatWorkingMemoryDialogue,
  type DialogueFormatOptions,
} from "./dialogue.js";
import type { RecalledEpisode } from "../recall/types.js";
import type { SemanticFactView } from "../recall/semantic-present.js";
import type { MemoIndexHit } from "../memory/memo-index.js";
import type { ChatMessage } from "../llm/types.js";

export type { RecalledEpisode } from "../recall/types.js";
export type { SemanticFactView } from "../recall/semantic-present.js";
export type { MemoIndexHit } from "../memory/memo-index.js";

/** 想起チャンネル全体の渡し方（ターン内で明示） */
export type RecallDelivery = "omit" | "full" | "summarize";

export type TurnContext = {
  turnId: string;
  state: AgentState;
  executedAt: string;
  currentDateTime: string;
  /** ターン開始時刻（相対時刻計算用） */
  now: Date;
  trigger: TurnTrigger;
  dialogue: DialogueFormatOptions;

  /** このターンの相手発話（全ロール共通） */
  partnerUtteranceLine: string;
  /** 相手発話より前の会話ターン */
  priorTurns: ConversationTurn[];
  /** preprocess で要約された会話チャンネル。あるとき priorTurns の代わりに使う */
  priorDialogueChannel?: string;
  recalledEpisodes: RecalledEpisode[];
  recallDelivery: RecallDelivery;
  /** 意味記憶（夢で蒸留した知識）。背景のエピソード想起とは別チャンネル */
  semanticFacts: SemanticFactView[];
  /** 感情余韻（旧 innerState）。空 = 起きたて */
  affect: string;
  /** 認知的焦点（何に注目しているか）。空 = 特になし */
  concern: string;
  /** 計画チャンネル: 集中 State で取り組み中の計画のレンダリング済みビュー。空 = 取り組み中の計画なし */
  plan: string;
  /** 取り組み中の計画 id（focusPlan）。plan actor がその計画を更新するため。空 = なし */
  planId: string;
  /** memo_index から想起した関連メモの所在 */
  recalledNotes: MemoIndexHit[];

  /** 視覚チャンネル(image_feed): いま視界に入っているフレーム（base64・文字起こししない）。
   *  空 = 画像なし。image_feed を宣言したモジュール（当面は言語野）だけが生のまま受け取る */
  imageFeed: string[];
  /** 聴覚チャンネル(audio_feed): いま聞こえている音声（base64・文字起こししない）。空 = 音声なし。
   *  現状の消費者は符号化の横断ベクトル付与のみ（omni 音声入力は後）。docs/ARCH-NEXT.md「音声も同じ形」 */
  audioFeed: string[];

  /** withPersona で設定（言語野用） */
  persona?: string;

  /** memory-agent → research-agent の順で積む */
  actions: ActionOutcome[];
  /** language-agent が出力した次 State */
  nextState?: string;
  speech?: string | null;
};

export type CreateTurnContextInput = {
  turnId: string;
  state: AgentState;
  trigger: TurnTrigger;
  dialogue: DialogueFormatOptions;
  recentTurns: readonly ConversationTurn[];
  recalledEpisodes: RecalledEpisode[];
  semanticFacts?: SemanticFactView[];
  recalledNotes?: MemoIndexHit[];
  imageFeed?: string[];
  audioFeed?: string[];
  affect?: string;
  concern?: string;
  plan?: string;
  planId?: string;
  now?: Date;
  timeZone?: string;
};

function partnerUtteranceLine(
  trigger: TurnTrigger,
  dialogue: DialogueFormatOptions,
): string {
  if (trigger.type === "user_message") {
    const name = dialogue.resolveUserDisplayName(trigger.speakerId);
    return `${name}: ${trigger.content}`;
  }
  return "（ハートビート・相手の発話なし）";
}

function priorTurnsFromRecent(
  recentTurns: readonly ConversationTurn[],
  trigger: TurnTrigger,
): ConversationTurn[] {
  if (trigger.type !== "user_message" || recentTurns.length === 0) {
    return [...recentTurns];
  }
  const last = recentTurns[recentTurns.length - 1];
  if (last.role === "user" && last.content === trigger.content) {
    return recentTurns.slice(0, -1) as ConversationTurn[];
  }
  return [...recentTurns];
}

export function createTurnContext(input: CreateTurnContextInput): TurnContext {
  const now = input.now ?? new Date();
  const clock = buildContextClock(now, input.timeZone);
  return {
    turnId: input.turnId,
    state: input.state,
    executedAt: clock.executedAt,
    currentDateTime: clock.currentDateTime,
    now,
    trigger: input.trigger,
    dialogue: input.dialogue,
    partnerUtteranceLine: partnerUtteranceLine(input.trigger, input.dialogue),
    priorTurns: priorTurnsFromRecent(input.recentTurns, input.trigger),
    recalledEpisodes: [...input.recalledEpisodes],
    recallDelivery: "full",
    semanticFacts: [...(input.semanticFacts ?? [])],
    recalledNotes: [...(input.recalledNotes ?? [])],
    imageFeed: [...(input.imageFeed ?? [])],
    audioFeed: [...(input.audioFeed ?? [])],
    affect: input.affect ?? "",
    concern: input.concern ?? "",
    plan: input.plan ?? "",
    planId: input.planId ?? "",
    actions: [],
  };
}

/** エージェントの ActionOutcome を actions 配列に追記する */
export function withAction(
  ctx: TurnContext,
  action: ActionOutcome,
): TurnContext {
  const actions = [...ctx.actions, action];
  let recallDelivery = ctx.recallDelivery;
  if (
    action.attempted &&
    action.status === "succeeded" &&
    action.facts?.kind === "recall"
  ) {
    recallDelivery = "omit";
  }
  return { ...ctx, actions, recallDelivery };
}

export function withPersona(ctx: TurnContext, persona: string): TurnContext {
  return { ...ctx, persona };
}

export function withSpeech(
  ctx: TurnContext,
  speech: string | null,
): TurnContext {
  return { ...ctx, speech };
}

/** ジャッジ向けの作業記憶チャンネル（相手発話＋それ以前） */
export function formatWorkingMemoryChannel(ctx: TurnContext): string {
  if (ctx.priorDialogueChannel !== undefined) {
    const prior = ctx.priorDialogueChannel.trim();
    if (!prior) {
      return ctx.partnerUtteranceLine;
    }
    return `${prior}\n\n${ctx.partnerUtteranceLine}`;
  }
  const turns: ConversationTurn[] = [
    ...ctx.priorTurns,
    ...(ctx.trigger.type === "user_message"
      ? [
          {
            role: "user" as const,
            speakerId: ctx.trigger.speakerId,
            content: ctx.trigger.content,
          },
        ]
      : []),
  ];
  return formatWorkingMemoryDialogue(turns, ctx.dialogue, ctx.now);
}

export function formatPriorDialogue(ctx: TurnContext): string {
  if (ctx.priorDialogueChannel !== undefined) {
    return ctx.priorDialogueChannel.trim() || "（このターンの相手発話より前はまだない）";
  }
  if (ctx.priorTurns.length === 0) {
    return "（このターンの相手発話より前はまだない）";
  }
  return ctx.priorTurns
    .map((t) => formatDialogueTurn(t, ctx.dialogue, ctx.now))
    .join("\n\n");
}

/** priorTurns を末尾 maxTurns 件に絞って整形する（actor 向け軽量版） */
function formatPriorDialogueSliced(ctx: TurnContext, maxTurns: number): string {
  if (ctx.priorDialogueChannel !== undefined) {
    return ctx.priorDialogueChannel.trim() || "（このターンの相手発話より前はまだない）";
  }
  const turns = ctx.priorTurns.slice(-maxTurns);
  if (turns.length === 0) {
    return "（このターンの相手発話より前はまだない）";
  }
  return turns
    .map((t) => formatDialogueTurn(t, ctx.dialogue, ctx.now))
    .join("\n\n");
}

export function formatRecalledEpisodes(
  ctx: TurnContext,
  delivery: RecallDelivery = ctx.recallDelivery,
): string[] {
  if (delivery === "omit" || ctx.recalledEpisodes.length === 0) {
    return [];
  }
  return ctx.recalledEpisodes.map((e) => e.presented);
}

export function formatRecalledEpisodeMeta(ctx: TurnContext) {
  return ctx.recalledEpisodes.map((e) => ({
    relevance: e.relevance,
    presentation: e.presentation,
  }));
}

export function formatSemanticFacts(ctx: TurnContext): string[] {
  return ctx.semanticFacts.map((f) => f.body);
}

export function formatRecalledNotes(ctx: TurnContext): string[] {
  if (!ctx.recalledNotes.length) return [];
  return ctx.recalledNotes.map((n) => `${n.path}: ${n.preview}`);
}

/** 全ロールが参照する記憶スナップショット */
export function memorySnapshot(ctx: TurnContext) {
  return {
    state: ctx.state,
    executedAt: ctx.executedAt,
    currentDateTime: ctx.currentDateTime,
    partnerUtterance: ctx.partnerUtteranceLine,
    priorDialogue: formatPriorDialogue(ctx),
    workingMemory: formatWorkingMemoryChannel(ctx),
    recalledEpisodes: formatRecalledEpisodes(ctx),
    recalledMeta: formatRecalledEpisodeMeta(ctx),
    recallDelivery: ctx.recallDelivery,
    semanticFacts: formatSemanticFacts(ctx),
    recalledNotes: formatRecalledNotes(ctx),
    affect: ctx.affect,
    concern: ctx.concern,
    plan: ctx.plan,
  };
}

/** 計画チャンネル（集中 State で取り組み中のゴールノート全文）を注入する */
function appendPlan(parts: string[], ctx: TurnContext): void {
  if (!ctx.plan.trim()) return;
  parts.push(
    "",
    "## 取り組み中の計画",
    "（いま集中して進めているゴールの現状。状態と履歴の記録であって、次の手順の指示書ではない。次の一手は自分で決める）",
    ctx.plan,
  );
}

function appendInnerState(parts: string[], ctx: TurnContext): void {
  if (!ctx.affect.trim()) return;
  parts.push(
    "",
    "## いまの内心",
    "（いま抱えている気持ち。温度の素であって台本ではない）",
    ctx.affect,
  );
}

function appendSemanticFacts(parts: string[], ctx: TurnContext): void {
  if (ctx.semanticFacts.length === 0) return;
  parts.push(
    "",
    "## 知っていること（意味記憶）",
    "（夢で蒸留した経験由来の知識。自信を持って使ってよい）",
    ...ctx.semanticFacts.map((f, i) => `${i + 1}. ${f.body}`),
  );
}

function appendRecalledEpisodes(parts: string[], ctx: TurnContext): void {
  const recalled = formatRecalledEpisodes(ctx);
  if (recalled.length === 0) return;

  parts.push(
    "",
    "## 背景の記憶（口に出さない・参考のみ）",
    "（これは過去の内省。ユーザーには見せていない。口調の台本として使わない）",
    "（各項目の先頭 [N分前/N日前] はその記憶が作られた時点。記憶の中の「明日」「今日」「さっき」はその時点が基準＝いまの話とは限らない。古い記憶を今の事実として喋らない）",
    ...ctx.recalledEpisodes.map((ep, i) => {
      const tag =
        ep.presentation === "vague"
          ? "（おぼろげ）"
          : ep.presentation === "summarize"
            ? "（要約）"
            : "";
      const when = ep.occurredAt
        ? `[${formatRelativeTime(ep.occurredAt, ctx.now)}] `
        : "";
      return `${i + 1}. ${when}${tag}${ep.presented}`;
    }),
  );
}

function lastUserTurn(
  turns: readonly ConversationTurn[],
): ConversationTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") return turns[i];
  }
  return undefined;
}

export function renderLanguageUserContent(ctx: TurnContext): string {
  const snap = memorySnapshot(ctx);

  if (ctx.trigger.type === "heartbeat") {
    const pending = lastUserTurn(ctx.priorTurns);
    const pendingLine = pending
      ? `${ctx.dialogue.resolveUserDisplayName(pending.speakerId ?? "user")}: ${pending.content}`
      : "（直近のユーザー依頼は見当たらない）";

    const parts: string[] = [
      `（状況: ${snap.state} / ${snap.currentDateTime} / ハートビート・相手なし）`,
      "",
      "## 未完了の依頼",
      pendingLine,
      "",
      "## このターンで起きたこと",
      formatActionsForLanguage(ctx.actions),
      "",
      "## 直近の会話と独り言",
      snap.priorDialogue,
    ];

    appendPlan(parts, ctx);
    appendInnerState(parts, ctx);
    appendSemanticFacts(parts, ctx);
    appendRecalledEpisodes(parts, ctx);
    return parts.join("\n");
  }

  const partnerName = ctx.dialogue.resolveUserDisplayName(
    ctx.trigger.speakerId,
  );

  const parts: string[] = [
    `（状況: ${snap.state} / ${snap.currentDateTime} / 相手: ${partnerName}）`,
    "",
    `## ${partnerName}の発話（このターン）`,
    snap.partnerUtterance,
    "",
    "## このターンで起きたこと",
    formatActionsForLanguage(ctx.actions),
    "",
    "## 直近の会話",
    snap.priorDialogue,
  ];

  appendPlan(parts, ctx);
  appendInnerState(parts, ctx);
  appendSemanticFacts(parts, ctx);
  appendRecalledEpisodes(parts, ctx);
  return parts.join("\n");
}

/** actor / activator 向けの軽量コンテキスト文字列を組み立てる。
 *  知識チャンネル（recalledEpisodes / semanticFacts / recalledNotes）は含めない。
 *  activator と actor は同じチャンネルセットを宣言し、判断の一貫性を保つこと。 */
export function buildActorContext(
  ctx: TurnContext,
  channels: import("../config/settings.js").ContextChannel[],
  opts?: { actorList?: string[]; maxTurns?: number },
): string {
  const parts: string[] = [
    `（状況: ${ctx.state} / ${ctx.currentDateTime}）`,
  ];

  if (channels.includes("conversation")) {
    parts.push("", "## 今ターンのトリガー", ctx.partnerUtteranceLine);
    const prior = opts?.maxTurns !== undefined
      ? formatPriorDialogueSliced(ctx, opts.maxTurns)
      : formatPriorDialogue(ctx);
    parts.push("", "## 直近の会話", prior);
  }

  if (channels.includes("inner_state")) {
    if (ctx.concern.trim()) {
      parts.push("", "## 関心事", ctx.concern);
    }
    if (ctx.affect.trim()) {
      parts.push("", "## いまの内心", ctx.affect);
    }
  }

  if (channels.includes("actor_list") && opts?.actorList?.length) {
    parts.push("", "## 利用可能なアクター", opts.actorList.join(", "));
  }

  if (channels.includes("plan") && ctx.plan.trim()) {
    parts.push("", "## 取り組み中の計画", ctx.plan);
  }

  return parts.join("\n");
}

/** preprocess / verbose 用のトークン見積もり */
export function serializeMemoryForBudget(ctx: TurnContext): string {
  return JSON.stringify(memorySnapshot(ctx));
}

export function redactTurnContextForLog(
  ctx: TurnContext,
): Omit<
  TurnContext,
  "executedAt" | "currentDateTime" | "dialogue" | "trigger"
> & {
  dateTime: string;
  trigger: TurnTrigger;
} {
  const {
    executedAt: _e,
    currentDateTime: _c,
    dialogue: _d,
    ...rest
  } = ctx;
  return { ...rest, dateTime: "(コンテキスト内のみ)", trigger: ctx.trigger };
}

/**
 * priorTurns を実際の ChatMessage ターンに変換する。
 * - monologue（ハートビート独り言）は既定でスキップ。includeMonologue:true で含める
 * - 先頭の孤立 assistant ターン（user より前）はスキップ
 */
export function buildConversationTurns(
  ctx: TurnContext,
  opts?: { includeMonologue?: boolean },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let firstUserSeen = false;
  for (const turn of ctx.priorTurns) {
    if (turn.channel === "monologue" && !opts?.includeMonologue) continue;
    // 対話では先頭の孤立 assistant をスキップして user 始まりにする。
    // ただし独白取り込み時（heartbeat）は自分の独り言を落とさない＝静穏連続でも
    // 自己連続性を保つため role:assistant として残す（Ollama は assistant 始まりを許容）。
    if (!opts?.includeMonologue && !firstUserSeen && turn.role === "assistant") {
      continue;
    }
    if (turn.role === "user") firstUserSeen = true;
    const content = formatDialogueTurn(turn, ctx.dialogue, ctx.now);
    messages.push({ role: turn.role === "user" ? "user" : "assistant", content });
  }
  return messages;
}

/**
 * 内省・内心など「ターン後の振り返り」ロール向けに、このターンのやり取りを
 * role 構造（自分=assistant / 相手=user）で組み立てる。テキストラベル頼みにせず
 * 自他境界を構造で示すのが狙い。末尾は自分の行動・発話（assistant）。
 */
export function buildReflectionMessages(ctx: TurnContext): ChatMessage[] {
  const messages = buildConversationTurns(ctx, { includeMonologue: true });

  if (ctx.trigger.type === "user_message") {
    messages.push({
      role: "user",
      content: formatDialogueTurn(
        {
          role: "user",
          speakerId: ctx.trigger.speakerId,
          content: ctx.trigger.content,
        },
        ctx.dialogue,
        ctx.now,
      ),
    });
  }

  // このターンに自分がやったこと・言ったこと（すべて自分 = assistant）
  const selfParts: string[] = [];
  for (const action of ctx.actions) {
    if (!action.attempted) continue;
    selfParts.push(
      `（行動）${actionLabelJa(action.kind)} — ${action.intent}`,
      formatActionForIntrospection(action),
    );
  }
  const speech = ctx.speech?.trim();
  selfParts.push(speech || silenceLine());
  messages.push({ role: "assistant", content: selfParts.join("\n") });

  return messages;
}

/** 言語野の system メッセージに追記するコンテキスト部分（内心・意味記憶・背景の記憶） */
export function buildLanguageContextSuffix(ctx: TurnContext): string {
  const parts: string[] = [];
  appendPlan(parts, ctx);
  appendInnerState(parts, ctx);
  appendSemanticFacts(parts, ctx);
  appendRecalledEpisodes(parts, ctx);
  return parts.join("\n");
}
