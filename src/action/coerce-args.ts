// 小型モデルはツール引数の形をよく間違える（string のところにオブジェクトを入れる等）。
// MCP に渡す前にツールスキーマと照合し、軽い型強制と必須チェックを行う。
// これがないと `new URL([object Object])` のような不可解な -32603 が出てリトライも潰れる。

type PropSpec = { type?: string };
type ToolSchema = {
  properties?: Record<string, PropSpec>;
  required?: string[];
};

export type CoerceResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * LLM が生成した引数を tool スキーマに合わせて検証・強制する。
 * - string 期待の項目に number/boolean → String() 化
 * - string 期待の項目にオブジェクト → 同名キーまたは唯一の文字列値を一段アンラップ
 * - 必須項目が欠落 / string が空・非文字列 → ok:false（明確なメッセージ）
 * スキーマに properties が無ければ検証不能としてそのまま通す。
 */
export function coerceToolArgs(
  parameters: Record<string, unknown> | undefined,
  rawArgs: Record<string, unknown>,
): CoerceResult {
  const schema = (parameters ?? {}) as ToolSchema;
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    return { ok: true, args: rawArgs };
  }

  const out: Record<string, unknown> = { ...rawArgs };
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in out)) continue;
    if (spec?.type === "string" && typeof out[key] !== "string") {
      const unwrapped = unwrapString(out[key], key);
      if (unwrapped !== undefined) out[key] = unwrapped;
    }
  }

  // キー名取り違えの救済: 必須 string が欠落していて、スキーマに無いキーに string が
  // ちょうど1つだけ来ている場合（小モデルが query→q / url→link 等と名前を間違える）、
  // その値を欠落している必須キーへ移す。曖昧（複数候補）なら触らず正直に弾く。
  const required = schema.required ?? [];
  for (const reqKey of required) {
    if (props[reqKey]?.type !== "string") continue;
    const cur = out[reqKey];
    if (typeof cur === "string" && cur.trim() !== "") continue;
    const spares = Object.entries(out).filter(
      ([k, v]) => !(k in props) && typeof v === "string" && v.trim() !== "",
    );
    if (spares.length === 1) {
      out[reqKey] = spares[0][1];
      delete out[spares[0][0]];
    }
  }

  const invalid: string[] = [];
  for (const key of required) {
    const value = out[key];
    if (value === undefined || value === null) {
      invalid.push(key);
      continue;
    }
    if (
      props[key]?.type === "string" &&
      (typeof value !== "string" || value.trim() === "")
    ) {
      invalid.push(key);
    }
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `必須の引数が不正: ${invalid.join(", ")}（受信: ${preview(rawArgs)}）`,
    };
  }

  return { ok: true, args: out };
}

function unwrapString(value: unknown, key: string): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj[key] === "string") return obj[key] as string;
    const strings = Object.values(obj).filter(
      (v): v is string => typeof v === "string",
    );
    if (strings.length === 1) return strings[0];
  }
  return undefined;
}

function preview(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length <= 120 ? s : `${s.slice(0, 120)}…`;
}
