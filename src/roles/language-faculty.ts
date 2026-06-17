import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { TurnContext } from "../context/turn-context.js";
import {
  buildConversationTurns,
  buildLanguageContextSuffix,
} from "../context/turn-context.js";
import {
  LANGUAGE_HEARTBEAT_SYSTEM_PREFIX,
  LANGUAGE_SYSTEM_PREFIX,
} from "../prompts/roles.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import { formatActionsForLanguage } from "../action/present.js";
import {
  extractJsonText,
  repairCommonJsonErrors,
  stripThinkBlocks,
} from "../action/parse-json.js";

export type LanguageOutput = { speech: string; nextState: string };

const languageOutputSchema = z.object({
  speech: z.string(),
  nextState: z.string(),
});

const languageJsonSchema = zodToJsonSchema(languageOutputSchema, {
  name: "LanguageOutput",
  $refStrategy: "none",
}) as Record<string, unknown>;

/**
 * 壊れた JSON から speech 値だけを正規表現で救出する。
 * speech 文字列が閉じず nextState を巻き込んだケースは、その痕跡を末尾から除去する。
 */
function salvageSpeech(text: string): string | null {
  const m = text.match(/"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  let speech: string;
  try {
    speech = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    speech = m[1];
  }
  return speech.replace(/\s*["']?\s*nextState["']?\s*:?.*$/is, "").trim();
}

/**
 * 言語野の生出力を {speech,nextState} に解す。**生の JSON / 思考は絶対にユーザーへ出さない**。
 *  1. <think> 除去 → JSON 抽出 → 軽微な壊れを修復してスキーマ検証
 *  2. 失敗時は speech 値だけ救出
 *  3. JSON の痕跡が無ければ素テキストを発話とみなす（構造化出力なのに素で返した保険）
 *  4. 壊れた JSON 断片しか無ければ沈黙（空発話）にフォールバック
 */
function parseLanguageOutput(raw: string, fallbackState: string): LanguageOutput {
  const cleaned = stripThinkBlocks(raw).trim();
  const extracted = extractJsonText(raw);
  for (const candidate of [
    extracted,
    repairCommonJsonErrors(extracted),
    cleaned,
    `{${cleaned}}`,
  ]) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate) as unknown;
      const parsed = languageOutputSchema.safeParse(obj);
      if (parsed.success) {
        return {
          speech: stripThinkBlocks(parsed.data.speech).trim(),
          nextState: parsed.data.nextState,
        };
      }
    } catch {
      // fall through
    }
  }

  const salvaged = salvageSpeech(cleaned);
  if (salvaged) {
    const sm = cleaned.match(/"nextState"\s*:\s*"([^"]*)"/);
    return { speech: salvaged, nextState: sm?.[1] ?? fallbackState };
  }

  // JSON の痕跡が無い＝素のテキストで返した → そのまま発話とみなす
  if (!/[{}]|"speech"|"nextState"/.test(cleaned)) {
    return { speech: cleaned, nextState: fallbackState };
  }

  // 壊れた JSON 断片しか残らない → 沈黙（生は出さない・記憶に残さない）
  return { speech: "", nextState: fallbackState };
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
    `${systemPrefix}\n\n${persona}` +
    situationLine +
    partnerBlock +
    buildLanguageContextSuffix(ctx);

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...buildConversationTurns(ctx, { includeMonologue: ctx.trigger.type === "heartbeat" }),
  ];

  const actionText = formatActionsForLanguage(ctx.actions);
  const hasAction = ctx.actions.some((a) => a.attempted);
  let userContent = hasAction
    ? `${triggerLine}\n\n## このターンで起きたこと\n${actionText}`
    : triggerLine;

  // 視覚チャンネル(image_feed): いま視界に入っている景色を生のまま添える（文字起こししない）。
  // 周辺視野として枠づけ＝話題に関係するときだけ触れる（景色に引っ張られすぎを防ぐ）。
  if (ctx.imageFeed.length > 0) {
    userContent +=
      "\n\n（画像はいま視界に入っている景色＝周辺視野。話題に関係するときだけ触れればよく、" +
      "毎回描写する必要はない。）";
    messages.push({ role: "user", content: userContent, images: ctx.imageFeed });
    return messages;
  }

  messages.push({ role: "user", content: userContent });
  return messages;
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
