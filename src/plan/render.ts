import type { PlanState } from "./state.js";

/**
 * 構造化plan を markdown にレンダリングする（決定的）。
 * LLM もこのビュー（id 付き）を読んで op を出す。Obsidian 互換ミラーにも使う。
 */
export function renderPlan(state: PlanState): string {
  const parts: string[] = [`# ${state.title}`];
  if (state.goal.trim()) parts.push("## 目標", state.goal);

  parts.push("## マイルストーン");
  if (state.milestones.length === 0) {
    parts.push("（まだない）");
  } else {
    for (const m of state.milestones) {
      const box = m.done ? "[x]" : "[ ]";
      const cur = m.id === state.current ? "  ← いまここ" : "";
      parts.push(`- ${box} (${m.id}) ${m.text}${cur}`);
    }
  }

  parts.push("## 履歴");
  if (state.log.length === 0) {
    parts.push("（まだない）");
  } else {
    for (const e of state.log) parts.push(`- ${e.date}: ${e.text}`);
  }

  return parts.join("\n");
}

/**
 * 言語野（発話）向けの柔らかいビュー。op 用の renderPlan と違い id・チェックボックス・
 * 全履歴を出さない＝選ばせる機械でなく「いま何をしていて、どこにいて、残りは何か」の想起的な提示。
 */
export function renderPlanForLanguage(state: PlanState): string {
  const current = state.milestones.find((m) => m.id === state.current);
  const goalPart = state.goal.trim() ? `（${state.goal.trim()}）` : "";
  const where = current ? `、いまは「${current.text}」のところ` : "";
  const parts = [
    "## いま取り組んでいること",
    `「${state.title}」${goalPart}を進めていて${where}。`,
  ];
  if (state.milestones.length > 0) {
    parts.push("進捗:");
    for (const m of state.milestones) {
      const mark = m.done ? "済んだ" : m.id === state.current ? "いま" : "まだ";
      parts.push(`- ${mark}: ${m.text}`);
    }
  }
  return parts.join("\n");
}
