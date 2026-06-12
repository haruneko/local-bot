import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { TurnContext } from "../context/turn-context.js";
import {
  buildConversationTurns,
  buildLanguageContextSuffix,
  renderLanguageUserContent,
} from "../context/turn-context.js";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
} from "../prompts/roles.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import { formatActionsForLanguage } from "../action/present.js";

export type GenerateLanguageOptions = {
  persona: string;
  systemPrefix: string;
  userContent: string;
  temperature?: number;
};

export type LanguageOutput = { speech: string; nextState: string };

const languageOutputSchema = z.object({
  speech: z.string(),
  nextState: z.string(),
});

const languageJsonSchema = zodToJsonSchema(languageOutputSchema, {
  name: "LanguageOutput",
  $refStrategy: "none",
}) as Record<string, unknown>;

function parseLanguageOutput(raw: string, fallbackState: string): LanguageOutput {
  const trimmed = raw.trim();
  for (const candidate of [trimmed, `{${trimmed}}`]) {
    try {
      const obj = JSON.parse(candidate) as unknown;
      const parsed = languageOutputSchema.safeParse(obj);
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
  }
  return { speech: trimmed, nextState: fallbackState };
}

export async function generateLanguageText(
  llm: LlmClient,
  options: GenerateLanguageOptions,
): Promise<string> {
  return llm.chat(
    [
      {
        role: "system",
        content: `${options.systemPrefix}\n\n## キャラクタールール\n${options.persona}`,
      },
      { role: "user", content: options.userContent },
    ],
    { temperature: options.temperature ?? 0.7 },
  );
}

function collectUniqueSpeakerNames(ctx: TurnContext): string[] {
  const names = new Map<string, string>();
  for (const turn of ctx.priorTurns) {
    if (turn.role === "user" && turn.speakerId) {
      names.set(turn.speakerId, ctx.dialogue.resolveUserDisplayName(turn.speakerId));
    }
  }
  if (ctx.trigger.type === "user_message") {
    names.set(ctx.trigger.speakerId, ctx.dialogue.resolveUserDisplayName(ctx.trigger.speakerId));
  }
  return [...names.values()];
}

function buildLanguageDialogueMessages(
  ctx: TurnContext,
  systemPrefix: string,
  persona: string,
): ChatMessage[] {
  let situationLine: string;
  let triggerLine: string;
  let partnerBlock = "";
  if (ctx.trigger.type === "heartbeat") {
    situationLine = `\n\n状況: ${ctx.state} / ${ctx.currentDateTime} / ハートビート`;
    triggerLine = "（ハートビート）";
  } else {
    const partnerName = ctx.dialogue.resolveUserDisplayName(ctx.trigger.speakerId);
    const speakers = collectUniqueSpeakerNames(ctx);
    const speakerLabel = speakers.length > 1
      ? `話者: ${speakers.join(", ")}`
      : `相手: ${partnerName}`;
    situationLine = `\n\n状況: ${ctx.state} / ${ctx.currentDateTime} / ${speakerLabel}`;
    triggerLine = `${partnerName}: ${ctx.trigger.content}`;

    // 相手の関係性プロフィール（あれば）。誰と話しているかで反応を変える材料。
    const profile = ctx.dialogue.resolveUserProfile?.(ctx.trigger.speakerId);
    if (profile?.note?.trim()) {
      partnerBlock = `\n\n## 相手について\n${profile.displayName}。${profile.note.trim()}`;
    }
  }

  const systemContent =
    `${systemPrefix}\n\n## キャラクタールール\n${persona}` +
    situationLine +
    partnerBlock +
    buildLanguageContextSuffix(ctx);

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...buildConversationTurns(ctx, { includeMonologue: ctx.trigger.type === "heartbeat" }),
  ];

  const actionText = formatActionsForLanguage(ctx.actions);
  const hasAction = ctx.actions.some((a) => a.attempted);
  const userContent = hasAction
    ? `${triggerLine}\n\n## このターンで起きたこと\n${actionText}`
    : triggerLine;

  messages.push({ role: "user", content: userContent });
  return messages;
}

export async function generateExpressText(
  llm: LlmClient,
  ctx: TurnContext,
  intent: string,
): Promise<string> {
  const persona = ctx.persona ?? "";
  const base = renderLanguageUserContent(ctx);
  const userContent = [
    base,
    "",
    "【発信の意図】",
    intent,
    "",
    "上記の意図に沿った、外部チャンネル向けの短文を1つだけ書く。",
    "ユーザーへの返答ではなく、投稿・送信向けの本文のみ。",
  ].join("\n");

  return generateLanguageText(llm, {
    persona,
    systemPrefix: LANGUAGE_SYSTEM_PREFIX,
    userContent,
    temperature: 0.7,
  });
}

function resolveNumPredict(ctx: TurnContext, defaultNumPredict: number): number {
  if (
    ctx.actions.some(
      (a) =>
        a.attempted &&
        a.status === "succeeded" &&
        a.facts?.kind === "research",
    )
  ) {
    return -1;
  }
  return defaultNumPredict;
}

export async function generateDialogueSpeech(
  llm: LlmClient,
  ctx: TurnContext,
  defaultNumPredict = 400,
): Promise<LanguageOutput> {
  const persona = ctx.persona ?? "";
  const format = languageJsonSchema;
  const systemPrefix = ctx.trigger.type === "heartbeat"
    ? LANGUAGE_HEARTBEAT_SYSTEM_PREFIX
    : LANGUAGE_SYSTEM_PREFIX;
  const numPredict = resolveNumPredict(ctx, defaultNumPredict);
  const messages = buildLanguageDialogueMessages(ctx, systemPrefix, persona);
  const raw = await llm.chat(messages, { temperature: 0.8, numPredict, format });
  return parseLanguageOutput(raw, ctx.state);
}
