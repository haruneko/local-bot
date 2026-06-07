import {
  formatActionForIntrospection,
  formatActionForLanguage,
  silenceLine,
} from "../action/present.js";
import { actionLabelJa } from "../action/types.js";
import type { TurnTrigger } from "../orchestrator/turn.js";
import type {
  ActionOutcome,
  AgentState,
  ConversationTurn,
  JudgeOutput,
} from "../types.js";
import { buildContextClock } from "../sensor/datetime.js";
import {
  formatDialogueTurn,
  formatWorkingMemoryDialogue,
  type DialogueFormatOptions,
} from "./dialogue.js";
import type { RecalledEpisode } from "../recall/types.js";
import type { SemanticFactView } from "../recall/semantic-present.js";
import type { ChatMessage } from "../llm/types.js";

export type { RecalledEpisode } from "../recall/types.js";
export type { SemanticFactView } from "../recall/semantic-present.js";

/** 想起チャンネル全体の渡し方（ターン内で明示） */
export type RecallDelivery = "omit" | "full" | "summarize";

export type TurnContext = {
  turnId: string;
  state: AgentState;
  executedAt: string;
  currentDateTime: string;
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
  /** 持ち越す内心（余韻）。空 = 起きたて */
  innerState: string;

  /** withJudge で平坦化（内省は judge オブジェクトを参照しない） */
  reply?: boolean;
  /** withPersona で設定（言語野用） */
  persona?: string;

  judge?: JudgeOutput;
  action: ActionOutcome;
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
  innerState?: string;
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
  const clock = buildContextClock(input.now, input.timeZone);
  return {
    turnId: input.turnId,
    state: input.state,
    executedAt: clock.executedAt,
    currentDateTime: clock.currentDateTime,
    trigger: input.trigger,
    dialogue: input.dialogue,
    partnerUtteranceLine: partnerUtteranceLine(input.trigger, input.dialogue),
    priorTurns: priorTurnsFromRecent(input.recentTurns, input.trigger),
    recalledEpisodes: [...input.recalledEpisodes],
    recallDelivery: "full",
    semanticFacts: [...(input.semanticFacts ?? [])],
    innerState: input.innerState ?? "",
    action: { attempted: false },
  };
}

export function withJudge(ctx: TurnContext, judge: JudgeOutput): TurnContext {
  return { ...ctx, judge, reply: judge.REPLY };
}

export function withAction(
  ctx: TurnContext,
  action: ActionOutcome,
): TurnContext {
  let recallDelivery = ctx.recallDelivery;
  if (
    action.attempted &&
    action.status === "succeeded" &&
    action.facts?.kind === "recall"
  ) {
    recallDelivery = "omit";
  }
  return { ...ctx, action, recallDelivery };
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
  return formatWorkingMemoryDialogue(turns, ctx.dialogue);
}

export function formatPriorDialogue(ctx: TurnContext): string {
  if (ctx.priorDialogueChannel !== undefined) {
    return ctx.priorDialogueChannel.trim() || "（このターンの相手発話より前はまだない）";
  }
  if (ctx.priorTurns.length === 0) {
    return "（このターンの相手発話より前はまだない）";
  }
  return ctx.priorTurns
    .map((t) => formatDialogueTurn(t, ctx.dialogue))
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
    innerState: ctx.innerState,
  };
}

export function renderJudgeUserPayload(ctx: TurnContext): string {
  return JSON.stringify(
    {
      state: ctx.state,
      trigger: ctx.trigger,
      context: memorySnapshot(ctx),
    },
    null,
    2,
  );
}

function appendInnerState(parts: string[], ctx: TurnContext): void {
  if (!ctx.innerState.trim()) return;
  parts.push(
    "",
    "## いまの内心",
    "（いま抱えている気持ち。温度の素であって台本ではない）",
    ctx.innerState,
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
    ...ctx.recalledEpisodes.map((ep, i) => {
      const tag =
        ep.presentation === "vague"
          ? "（おぼろげ）"
          : ep.presentation === "summarize"
            ? "（要約）"
            : "";
      return `${i + 1}. ${tag}${ep.presented}`;
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
      formatActionForLanguage(ctx.action),
      "",
      "## 直近の会話と独り言",
      snap.priorDialogue,
    ];

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
    formatActionForLanguage(ctx.action),
    "",
    "## 直近の会話",
    snap.priorDialogue,
  ];

  appendInnerState(parts, ctx);
  appendSemanticFacts(parts, ctx);
  appendRecalledEpisodes(parts, ctx);
  return parts.join("\n");
}

export function renderIntrospectionPrompt(ctx: TurnContext): string {
  const reply = ctx.reply ?? false;
  const speechBlock = ctx.speech?.trim()
    ? ctx.speech
    : reply
      ? ""
      : silenceLine();

  const parts = [
    `（状況: ${ctx.state} / ${ctx.currentDateTime}）`,
    "",
    "【直近の会話】",
    formatWorkingMemoryChannel(ctx),
    "",
    "【いま自分が言ったこと】",
    speechBlock,
  ];

  if (ctx.action.attempted) {
    const label = actionLabelJa(ctx.action.kind);
    parts.push(
      "",
      "【行動】",
      `やろうとしたこと: ${label} — ${ctx.action.intent}`,
      formatActionForIntrospection(ctx.action),
    );
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
 * - monologue（ハートビート独り言）はスキップ
 * - 先頭の孤立 assistant ターン（user より前）はスキップ
 */
export function buildConversationTurns(ctx: TurnContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let firstUserSeen = false;
  for (const turn of ctx.priorTurns) {
    if (turn.channel === "monologue") continue;
    if (!firstUserSeen && turn.role === "assistant") continue;
    if (turn.role === "user") firstUserSeen = true;
    if (turn.role === "user") {
      const name = ctx.dialogue.resolveUserDisplayName(turn.speakerId ?? "");
      messages.push({ role: "user", content: `${name}: ${turn.content}` });
    } else {
      messages.push({ role: "assistant", content: turn.content });
    }
  }
  return messages;
}

/** ジャッジの system メッセージに追記するコンテキスト部分（状態・内心・想起・意味記憶） */
export function buildJudgeContextSuffix(ctx: TurnContext): string {
  const parts: string[] = ["", `状態: ${ctx.state}`, `日時: ${ctx.currentDateTime}`];
  if (ctx.innerState.trim()) {
    parts.push("", "## 内心", ctx.innerState);
  }
  const recalled = formatRecalledEpisodes(ctx);
  if (recalled.length > 0) {
    parts.push("", "## 想起（参考）", ...recalled.map((e, i) => `${i + 1}. ${e}`));
  }
  const semantic = formatSemanticFacts(ctx);
  if (semantic.length > 0) {
    parts.push("", "## 意味記憶", ...semantic.map((f, i) => `${i + 1}. ${f}`));
  }
  return parts.join("\n");
}

/** 言語野の system メッセージに追記するコンテキスト部分（内心・意味記憶・背景の記憶） */
export function buildLanguageContextSuffix(ctx: TurnContext): string {
  const parts: string[] = [];
  appendInnerState(parts, ctx);
  appendSemanticFacts(parts, ctx);
  appendRecalledEpisodes(parts, ctx);
  return parts.join("\n");
}
