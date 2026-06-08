import type { TurnContext } from "../context/turn-context.js";
import type { TurnTrigger } from "./turn.js";
import type { AgentState } from "../types.js";

/** heartbeat 時のベクトル検索クエリ（直近ユーザー発話がなければ state ベース） */
export function buildRecallQuery(
  trigger: TurnTrigger,
  state: AgentState,
  lastUserContent: string,
): string {
  const last = lastUserContent.trim();
  if (trigger.type === "user_message") return last || ".";
  return last || `heartbeat ${state}`;
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
