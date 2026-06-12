import { formatActionFailureForIntrospection } from "./error.js";
import type { ActionFacts } from "./facts.js";
import type { ActionOutcome } from "../types.js";

const MAX_BODY_IN_SUMMARY = 800;

export function noteDisplayPath(filename: string): string {
  return `data/notes/${filename}`;
}

function truncateBody(text: string, max = MAX_BODY_IN_SUMMARY): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function formatActionSummary(facts: ActionFacts): string {
  switch (facts.kind) {
    case "memo_write":
      return `${noteDisplayPath(facts.filename)} に書き込んだ:\n${truncateBody(facts.body)}`;
    case "memo_read":
      return `${noteDisplayPath(facts.filename)} を読んだ:\n${truncateBody(facts.body, 500)}`;
    case "remember": {
      const preview = truncateBody(facts.body, 120);
      return `記憶に残した: ${preview}`;
    }
    case "recall":
      return facts.bullets.map((b) => `- ${b}`).join("\n");
    case "forget": {
      const preview = truncateBody(facts.body, 120);
      return `記憶を手放した: ${preview}`;
    }
    case "research":
      return `${facts.tool} で調べた結果: ${truncateBody(facts.body, 500)}`;
    case "express":
      return `${facts.tool} に送った: ${truncateBody(facts.body, 500)}`;
    case "plan":
      return `${noteDisplayPath(facts.filename)} の計画を更新した:\n${truncateBody(facts.body)}`;
  }
}

export function formatActionFactContent(action: ActionOutcome): string {
  if (!action.attempted) {
    return "（行動なし）";
  }
  if (action.status === "failed") {
    return action.summary;
  }
  if (!action.facts) {
    return action.summary;
  }

  const facts = action.facts;
  switch (facts.kind) {
    case "memo_read":
      return [
        `${facts.filename} のメモを読んでみた。こんなことが書いてあった:`,
        facts.body,
      ].join("\n");
    case "memo_write":
      return [
        `${facts.filename} のメモに書き込んだ:`,
        facts.body,
      ].join("\n");
    case "remember":
      return ["こんなことを記憶に残した:", facts.body].join("\n");
    case "recall":
      return [
        "記憶を探してみた。こんなことが思い出せた:",
        facts.bullets.map((b) => `- ${b}`).join("\n"),
      ].join("\n");
    case "forget":
      return ["この記憶を手放した:", facts.body].join("\n");
    case "research":
      return [
        `${facts.tool} で調べてみたら、こんな情報が見つかった:`,
        facts.title ? `件名: ${facts.title}` : "",
        facts.body,
      ]
        .filter(Boolean)
        .join("\n");
    case "express":
      return [
        `${facts.tool} を使って送った:`,
        facts.title ? `件名: ${facts.title}` : "",
        facts.body,
      ]
        .filter(Boolean)
        .join("\n");
    case "plan":
      return [`${facts.filename} の計画ノートを更新した:`, facts.body].join("\n");
  }
}

type AttemptedAction = Extract<ActionOutcome, { attempted: true }>;

function formatActionContentForIntrospection(
  action: AttemptedAction,
): string {
  if (action.status === "failed") {
    if (action.error) {
      return formatActionFailureForIntrospection(action.error);
    }
    return action.summary;
  }
  return formatActionFactContent(action);
}

export function formatActionForIntrospection(action: ActionOutcome): string {
  if (!action.attempted) {
    return "";
  }
  const resultLabel =
    action.status === "succeeded" ? "できた" : "できなかった";
  return [
    `結果: ${resultLabel}`,
    "内容:",
    formatActionContentForIntrospection(action),
  ].join("\n");
}

/** 言語野向け。一人称は載せず事実のみ（口調は character.md に任せる） */
export function formatActionForLanguage(action: ActionOutcome): string {
  if (!action.attempted) {
    return "（このターンでは行動していない）";
  }
  if (action.status === "failed") {
    return action.summary;
  }
  return formatActionFactContent(action);
}

export function silenceLine(): string {
  return "（返答はしなかった）";
}

/** 複数 ActionOutcome を言語野向けにまとめる */
export function formatActionsForLanguage(actions: ActionOutcome[]): string {
  const attempted = actions.filter(
    (a): a is Extract<ActionOutcome, { attempted: true }> => a.attempted,
  );
  if (attempted.length === 0) return "（このターンでは行動していない）";
  return attempted.map((a) => formatActionForLanguage(a)).join("\n\n");
}
