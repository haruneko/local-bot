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

/** 内省を LanceDB に書くか（idle heartbeat は書かない） */
export function shouldPersistIntrospection(ctx: TurnContext): boolean {
  if (ctx.trigger.type === "user_message") return true;
  if (ctx.action.attempted && ctx.action.status === "succeeded") return true;
  if (ctx.reply && ctx.speech?.trim()) return true;
  return false;
}

/** 言語野（対話返答 or heartbeat 独り言）を走らせるか */
export function shouldRunLanguage(ctx: TurnContext): boolean {
  if (ctx.reply) return true;
  return (
    ctx.trigger.type === "heartbeat" &&
    ctx.action.attempted &&
    ctx.action.status === "succeeded"
  );
}
