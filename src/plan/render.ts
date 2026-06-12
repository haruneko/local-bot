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
