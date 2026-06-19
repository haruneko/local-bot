import { formatActionFailureForIntrospection } from "./error.js";
import type { ActionFacts } from "./facts.js";
import type { ActionOutcome } from "../types.js";

const MAX_BODY_IN_SUMMARY = 800;

export function noteDisplayPath(filename: string): string {
  return `data/notes/${filename}`;
}

/** plan facts.action → 表示用の動詞。 */
function planVerb(action: "view" | "create" | "activate" | "shelve" | "retire" | "update"): string {
  switch (action) {
    case "view":
      return "確認した";
    case "create":
      return "立てた";
    case "activate":
      return "始めた";
    case "shelve":
      return "棚上げした";
    case "retire":
      return "見限った";
    case "update":
      return "更新した";
  }
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
      return `${noteDisplayPath(facts.filename)} の計画を${planVerb(facts.action)}:\n${truncateBody(facts.body)}`;
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
function shrinkBody(
  body: string,
  audience: FactAudience,
  delivered = false,
): string {
  const head = headPreview(body);
  if (audience === "language") {
    // delivered=true の kind（synthesize/memo_read/research）だけ「別途届く」＝二重生成を防ぐ。
    // それ以外（memo_write 等）は相手に届かないので注記を付けない。
    return delivered
      ? `${head}\n（全文は別途そのまま相手に届く。書き写さず、一言添えるだけにする）`
      : head;
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
        shrinkBody(facts.body, audience, factExternalizesNewInfo(facts)),
      ].join("\n");
    case "memo_write":
      return [
        `${facts.filename} のメモに書き込んだ:`,
        shrinkBody(facts.body, audience, factExternalizesNewInfo(facts)),
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
        shrinkBody(facts.body, audience, factExternalizesNewInfo(facts)),
      ]
        .filter(Boolean)
        .join("\n");
    case "express":
      return [
        `${facts.tool} を使って送った:`,
        facts.title ? `件名: ${facts.title}` : "",
        shrinkBody(facts.body, audience, factExternalizesNewInfo(facts)),
      ]
        .filter(Boolean)
        .join("\n");
    case "synthesize":
      return [
        `${facts.filename} に、想起と外部情報と自分の感性を統合してこれを書き起こした:`,
        shrinkBody(facts.body, audience, factExternalizesNewInfo(facts)),
      ].join("\n");
    case "plan":
      return [`${facts.filename} の計画ノートを${planVerb(facts.action)}:`, facts.body].join("\n");
  }
}

/**
 * preprocess 時点の context に無い「新しく立ち上がった情報」をユーザーに出す facts か。
 * 原則: そのターンのプリプロセスまでの情報を読んでも出てこない情報は出す。ただし量は kind 次第：
 * - synthesize / memo_read: 成果物・読み上げ＝**全文**（既存ファイルあり）
 * - research: **要約だけ**（多ソースの生 dump=全文 body はチャットを流すので出さない・要点は届ける）
 * - memo_write(既出の転記)・recall(想起要約)・plan・forget は対象外
 */
export function factExternalizesNewInfo(facts: ActionFacts): boolean {
  switch (facts.kind) {
    case "synthesize":
    case "memo_read":
    case "research":
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
    case "research": {
      // 全文 body でなく要約だけ（dump を避ける）。要点は届けるが流さない
      const s = facts.summary.trim();
      if (!s) return null;
      return facts.title ? `【${facts.title}】\n${s}` : s;
    }
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


/** 成功（facts あり）: op 別に「やったこと」を事実として述べる。中身が空なら空振りの言い方に。 */
function languageSuccessLine(facts: ActionFacts, intent: string): string {
  const subject = intent || "それ";
  switch (facts.kind) {
    case "recall":
      return facts.bullets.length
        ? [
            `${subject}について思い出そうとしたところ、次のことを思い出した:`,
            facts.bullets.map((b) => `- ${b}`).join("\n"),
          ].join("\n")
        : `${subject}について思い出そうとしたが、何も思い出せなかった`;
    case "memo_read":
      return [
        `${subject}についてメモを探したところ、次のことが書いてあった:`,
        shrinkBody(facts.body, "language", true),
      ].join("\n");
    case "memo_write":
      return [
        `${facts.filename} のメモに書き込んだ:`,
        shrinkBody(facts.body, "language", false),
      ].join("\n");
    case "remember":
      return ["次のことを記憶に残した:", facts.body].join("\n");
    case "forget":
      return `${subject}の記憶を手放した`;
    case "research":
      return !facts.summary.trim() && !facts.body.trim()
        ? `${subject}を調べたが、何も見つからなかった`
        : [
            `${facts.tool}で${subject}を調べたところ、次の情報を見つけた:`,
            shrinkBody(facts.body, "language", true),
          ].join("\n");
    case "express":
      return `${facts.tool}に${subject}を送った`;
    case "synthesize":
      return `${facts.filename}に思いついたことを書き留めた`;
    case "plan":
      // view（報告・確認）は本文（やり残し一覧 or 計画の状況）を相手に伝えるための内容なので body を載せる。
      // それ以外（立てた/始めた/棚上げ等）は短い事実だけでよい。
      return facts.action === "view"
        ? [`いまの状況を確認した:`, facts.body].join("\n")
        : `${facts.filename}の計画を${planVerb(facts.action)}`;
  }
}

/** 成功だが facts 無し（空振り）: op 別の「見つからなかった」言い方。 */
function languageEmptyLine(op: ActionFacts["kind"], intent: string): string {
  const subject = intent || "それ";
  switch (op) {
    case "recall":
      return `${subject}について思い出そうとしたが、何も思い出せなかった`;
    case "memo_read":
      return `${subject}についてメモを探したが、見つけられなかった`;
    case "forget":
      return "手放す記憶が見つからなかった";
    case "research":
      return `${subject}を調べたが、何も見つからなかった`;
    default:
      return `${subject}はできなかった`;
  }
}

/** 失敗（本当のエラー）: op 別に何ができなかったかを述べ、理由を添える。 */
function languageErrorLine(
  op: ActionFacts["kind"] | undefined,
  intent: string,
  reason: string,
): string {
  const subject = intent || "それ";
  const head = (() => {
    switch (op) {
      case "recall":
        return `${subject}を思い出そうとしたが、うまくいかなかった`;
      case "memo_read":
        return `${subject}のメモを探そうとしたが、うまくいかなかった`;
      case "memo_write":
        return `${subject}をメモに書き込もうとしたが、できなかった`;
      case "remember":
        return "記憶に残せなかった";
      case "forget":
        return "記憶を手放せなかった";
      case "research":
        return `${subject}を調べようとしたが、うまくいかなかった`;
      case "express":
        return "送信できなかった";
      case "synthesize":
        return "書き留められなかった";
      case "plan":
        return "計画を更新できなかった";
      default:
        return `${subject}はうまくいかなかった`;
    }
  })();
  return reason ? `${head}\n${reason}` : head;
}

/**
 * 言語野向け。一人称は載せず事実のみ（口調は character.md に任せる）。op 別に
 * 「やったこと／空振り／失敗」を事実として述べる＝失敗を「やった」と取り違えない（言行一致）。
 */
export function formatActionForLanguage(action: ActionOutcome): string {
  if (!action.attempted) {
    return "（このターンでは行動していない）";
  }
  const intent = action.intent.trim();
  if (action.status === "failed") {
    const reason = action.error
      ? formatActionFailureForIntrospection(action.error)
      : action.summary;
    return languageErrorLine(action.op, intent, reason);
  }
  if (action.facts) return languageSuccessLine(action.facts, intent);
  if (action.op) return languageEmptyLine(action.op, intent);
  return action.summary;
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
