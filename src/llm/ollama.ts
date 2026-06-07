import { Ollama } from "ollama";
import type { OllamaThinkSetting } from "../config/settings.js";
import type { ChatMessage, ChatOptions, LlmClient } from "./types.js";

export type OllamaClientConfig = {
  host: string;
  model: string;
  /** false で thinking off（Ollama think API） */
  think?: OllamaThinkSetting;
  /** Ollama num_ctx: コンテキストウィンドウサイズ。未設定時は Ollama デフォルト(2048)のまま */
  numCtx?: number;
};

export class OllamaLlmClient implements LlmClient {
  private readonly client: Ollama;

  constructor(private readonly config: OllamaClientConfig) {
    this.client = new Ollama({ host: config.host });
  }

  get model(): string {
    return this.config.model;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    const response = await this.client.chat({
      model: this.config.model,
      messages,
      stream: false,
      format: options?.format,
      think: this.config.think ?? false,
      options: {
        temperature: options?.temperature ?? 0.7,
        ...(this.config.numCtx !== undefined && { num_ctx: this.config.numCtx }),
        ...(options?.numPredict !== undefined && { num_predict: options.numPredict }),
      },
    });
    return response.message.content;
  }
}

export class OllamaEmbedClient {
  private readonly client: Ollama;

  constructor(host: string, private readonly model: string) {
    this.client = new Ollama({ host });
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      return embedEmptyVector(this.client, this.model);
    }
    const response = await this.client.embed({
      model: this.model,
      input: text,
    });
    const first = response.embeddings[0];
    if (!first?.length) {
      throw new Error("Ollama embed returned empty vector");
    }
    return first;
  }
}

async function embedEmptyVector(
  client: Ollama,
  model: string,
): Promise<number[]> {
  const response = await client.embed({ model, input: "." });
  const first = response.embeddings[0];
  if (!first?.length) throw new Error("Cannot determine embed dimensions");
  return first.map(() => 0);
}
