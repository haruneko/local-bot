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
    case "synthesize":
      return `${noteDisplayPath(facts.filename)} に書き起こした:\n${truncateBody(facts.body)}`;
    case "plan":
      return `${noteDisplayPath(facts.filename)} の計画を更新した:\n${truncateBody(facts.body)}`;
  }
}

/** 言語野・内省に渡す本文の冒頭量（〜4文・手触りだけ）。全文は別経路でユーザーに届く */
const HEAD_PREVIEW_CHARS = 120;

function headPreview(text: string, max = HEAD_PREVIEW_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** 本文の分量メタ（内省が「これだけ作った」量感を掴むため） */
function bodyMeta(text: string): string {
  const t = text.trim();
  const lines = t ? t.split("\n").length : 0;
  return `全${t.length}字・${lines}行`;
}

/** facts の本文を渡す宛先。長さの扱いを宛先で非対称にする（ユーザー出力は別関数で全文） */
type FactAudience = "language" | "introspection";

/**
 * 生テキスト系の長い本文を宛先別に短縮する。
 * - language: 冒頭＋「全文は相手に別途そのまま届く＝ここで書き写さない」（二重生成・劣化を防ぐ）
 * - introspection: 冒頭＋分量メタ（全文は works/・memo_index が正本。手応えだけ残す）
 */
function shrinkBody(body: string, audience: FactAudience): string {
  const head = headPreview(body);
  if (audience === "language") {
    return `${head}\n（全文は相手に別途そのまま届く。ここで書き写さず、一言添えるだけにする）`;
  }
  return `${head}（${bodyMeta(body)}）`;
}

export function formatActionFactContent(
  action: ActionOutcome,
  audience: FactAudience = "language",
): string {
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
        shrinkBody(facts.body, audience),
      ].join("\n");
    case "memo_write":
      return [
        `${facts.filename} のメモに書き込んだ:`,
        shrinkBody(facts.body, audience),
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
        shrinkBody(facts.body, audience),
      ]
        .filter(Boolean)
        .join("\n");
    case "express":
      return [
        `${facts.tool} を使って送った:`,
        facts.title ? `件名: ${facts.title}` : "",
        shrinkBody(facts.body, audience),
      ]
        .filter(Boolean)
        .join("\n");
    case "synthesize":
      return [
        `${facts.filename} に、想起と外部情報と自分の感性を統合してこれを書き起こした:`,
        shrinkBody(facts.body, audience),
      ].join("\n");
    case "plan":
      return [`${facts.filename} の計画ノートを更新した:`, facts.body].join("\n");
  }
}

/**
 * preprocess 時点の context に無い「新しく立ち上がった情報」を運ぶ facts か。
 * 原則: そのターンのプリプロセスまでの情報を読んでも出てこない**成果物**は全文ユーザーに出す。
 * - synthesize: 生成した成果物 / memo_read: ファイル全文をこのターンで初ロード（読み上げ意図）
 * - **research は対象外**: 多ソースの生 dump は中間素材でチャットを流す。答え・要点は speech が運ぶ
 *   （language/内省は research facts を引き続き参照する＝この関数はユーザー出力の可否だけ）。
 * - memo_write(既出の転記)・recall(想起要約)・plan・forget も対象外
 */
export function factExternalizesNewInfo(facts: ActionFacts): boolean {
  switch (facts.kind) {
    case "synthesize":
    case "memo_read":
      return true;
    default:
      return false;
  }
}

/**
 * ユーザー（チャットチャンネル）向け。新規情報 facts のみ本文を**全文**返す（無ければ null）。
 * speech とは別経路で成果物・調査結果をそのまま届ける＝言語野に再生成させない。
 * 音声チャンネル等、本文を読み上げない宛先では呼び出し側が出さない選択をする。
 */
export function formatActionForUserOutput(action: ActionOutcome): string | null {
  if (!action.attempted || action.status !== "succeeded" || !action.facts) {
    return null;
  }
  const facts = action.facts;
  if (!factExternalizesNewInfo(facts)) return null;
  switch (facts.kind) {
    case "synthesize":
      return facts.body;
    case "memo_read":
      return facts.body;
    default:
      return null;
  }
}

/** このターンの全 ActionOutcome から、ユーザーに全文提示する成果物本文を集める */
export function collectUserArtifacts(actions: ActionOutcome[]): string[] {
  return actions
    .map((a) => formatActionForUserOutput(a))
    .filter((s): s is string => s !== null && s.trim() !== "");
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
  return formatActionFactContent(action, "introspection");
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
