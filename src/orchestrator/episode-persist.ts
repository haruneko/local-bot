import type { TurnContext } from "../context/turn-context.js";
import type { TurnTrigger } from "./turn.js";

/**
 * ベクトル検索クエリを決定する。null のとき recall をスキップする。
 * user_message: 生の発話＋concern（認知的焦点）を合成して**クエリを研ぐ**（concern-aware）。
 *   ＝注目していることに沿って想起が偏る＝能動 recall の "研いだクエリ" を機械的に代替（LLM 不要）。
 * heartbeat 優先順: lastUserContent → lastSpeech（前回発話） → concern → affect（ムード） → null
 */
export function buildRecallQuery(
  trigger: TurnTrigger,
  lastUserContent: string,
  lastSpeech = "",
  affect = "",
  concern = "",
): string | null {
  const last = lastUserContent.trim();
  const c = concern.trim();
  if (trigger.type === "user_message") return (c ? `${last} ${c}` : last).trim() || ".";
  return last || lastSpeech.trim() || c || affect.trim() || null;
}

/** 内省を LanceDB に書くか（idle heartbeat は書かない）
 * idle heartbeat = heartbeat かつ actions 空 かつ speech 空
 */
export function shouldPersistIntrospection(ctx: TurnContext): boolean {
  if (ctx.trigger.type === "user_message") return true;
  const anySucceeded = ctx.actions.some(
    (a) => a.attempted && a.status === "succeeded",
  );
  if (anySucceeded) return true;
  if (ctx.speech?.trim()) return true;
  return false;
}
