import type { VerboseLoggerImpl } from "../util/verbose.js";
import { detectLlmRole } from "../util/verbose.js";
import type { ChatMessage, ChatOptions, LlmClient } from "./types.js";

export function withVerboseLlm(
  inner: LlmClient,
  logger: VerboseLoggerImpl,
): LlmClient {
  const wrapped: LlmClient = {
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      const role = detectLlmRole(messages);
      const start = Date.now();
      const response = await inner.chat(messages, options);
      logger.llm(role, messages, options, response, Date.now() - start);
      return response;
    },
  };
  // chatStream は元クライアントに生えている時だけ生やす（無い時は undefined のまま＝呼び出し側が chat にフォールバック）
  const innerStream = inner.chatStream?.bind(inner);
  if (innerStream) {
    wrapped.chatStream = async function* (
      messages: ChatMessage[],
      options?: ChatOptions,
    ): AsyncIterable<string> {
      const role = detectLlmRole(messages);
      const start = Date.now();
      // 差分は素通しし、終了時に連結全文を chat と同じ debug ダンプ形式でログ
      let full = "";
      for await (const delta of innerStream(messages, options)) {
        full += delta;
        yield delta;
      }
      logger.llm(role, messages, options, full, Date.now() - start);
    };
  }
  return wrapped;
}
