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
      return `LanceDB（source: remember）に記録した: ${preview}`;
    }
    case "recall":
      return facts.bullets.map((b) => `- ${b}`).join("\n");
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
        `メモ（${facts.filename}）を読んだ。書かれていた内容:`,
        facts.body,
      ].join("\n");
    case "memo_write":
      return [
        `メモ（${facts.filename}）に書き込んだ。書いた内容:`,
        facts.body,
      ].join("\n");
    case "remember":
      return ["記憶（LanceDB）に残した内容:", facts.body].join("\n");
    case "recall":
      return [
        "記憶（LanceDB）を検索した。ヒットした内容:",
        facts.bullets.map((b) => `- ${b}`).join("\n"),
      ].join("\n");
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
