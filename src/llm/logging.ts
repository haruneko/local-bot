import type { VerboseLoggerImpl } from "../util/verbose.js";
import { detectLlmRole } from "../util/verbose.js";
import type { ChatMessage, ChatOptions, LlmClient } from "./types.js";

export function withVerboseLlm(
  inner: LlmClient,
  logger: VerboseLoggerImpl,
): LlmClient {
  return {
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      const role = detectLlmRole(messages);
      const start = Date.now();
      const response = await inner.chat(messages, options);
      logger.llm(role, messages, options, response, Date.now() - start);
      return response;
    },
  };
}
