import type { TurnContext } from "../context/turn-context.js";
import type { TurnTrigger } from "./turn.js";

/**
 * ベクトル検索クエリを決定する。null のとき recall をスキップする。
 * heartbeat 優先順: lastUserContent → lastSpeech（前回発話） → innerState（ムード） → null
 */
export function buildRecallQuery(
  trigger: TurnTrigger,
  lastUserContent: string,
  lastSpeech = "",
  innerState = "",
): string | null {
  const last = lastUserContent.trim();
  if (trigger.type === "user_message") return last || ".";
  return last || lastSpeech.trim() || innerState.trim() || null;
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
