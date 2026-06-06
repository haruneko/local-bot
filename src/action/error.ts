export const ACTION_ERROR_CODES = {
  LLM_PARSE: "llm_parse_failed",
  LLM_SCHEMA: "llm_schema_invalid",
  INVALID_ARGS: "invalid_args",
  TOOL_FAILED: "tool_failed",
  FILE_NOT_FOUND: "file_not_found",
  PICK_FAILED: "pick_failed",
  NO_MEMO_FILES: "no_memo_files",
  ACTION_DISCONNECTED: "action_disconnected",
} as const;

export type ActionErrorCode =
  (typeof ACTION_ERROR_CODES)[keyof typeof ACTION_ERROR_CODES];

export type ActionErrorInfo = {
  code: ActionErrorCode;
  message: string;
  detail?: string;
};

export function truncateErrorDetail(text: string, max = 500): string {
  const t = text.trim();
  if (!t) return "（空）";
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function formatFailureSummary(
  headline: string,
  error: ActionErrorInfo,
): string {
  const lines = [headline, `原因コード: ${error.code}`, `原因: ${error.message}`];
  if (error.detail) {
    lines.push(`詳細: ${error.detail}`);
  }
  return lines.join("\n");
}

/** 内省向け。LLM 生応答（detail）は載せない */
export function formatActionFailureForIntrospection(
  error: ActionErrorInfo,
): string {
  return [`原因コード: ${error.code}`, `原因: ${error.message}`].join("\n");
}

export function errorFromLlmAttempts(
  attempts: readonly string[],
  lastReason?: "json_syntax" | "schema" | "empty",
  zodMessage?: string,
): ActionErrorInfo {
  const detail = attempts
    .map((raw, i) => `--- LLM応答 ${i + 1} ---\n${truncateErrorDetail(raw, 400)}`)
    .join("\n");

  if (lastReason === "schema") {
    return {
      code: ACTION_ERROR_CODES.LLM_SCHEMA,
      message: zodMessage ?? "JSONの形は合ったが必須フィールドが不足している",
      detail,
    };
  }

  return {
    code: ACTION_ERROR_CODES.LLM_PARSE,
    message:
      lastReason === "empty"
        ? "LLMが空の応答を返した"
        : "LLM応答をJSONとして解釈できなかった",
    detail,
  };
}
