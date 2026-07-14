import { Ollama } from "ollama";
import type { OllamaThinkSetting } from "../config/settings.js";
import type { ChatMessage, ChatOptions, LlmClient } from "./types.js";
import { runLimited, runLimitedStream, withLlmRetry } from "./limit.js";

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
    // 同時実行リミッタ越し＋一過性エラーは1回リトライ（サーバ過負荷・瞬断に強くする）
    return runLimited(() =>
      withLlmRetry(async () => {
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
      }),
    );
  }

  /**
   * ストリーミング生成。`/api/chat` を stream:true で叩き、各チャンクの
   * message.content を差分として yield する。全差分の連結 = chat() の返り値と同等。
   * chat() と同じオプション処理。スロットは runLimitedStream が反復完了まで保持する。
   * リトライは付けない（差分を1つでも yield した後の再試行は出力が二重になるため。
   * chat() の一過性リトライは「まだ何も返していない」から成立する）。
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<string> {
    const config = this.config;
    const client = this.client;
    yield* runLimitedStream(async function* () {
      const stream = await client.chat({
        model: config.model,
        messages,
        stream: true,
        format: options?.format,
        think: config.think ?? false,
        options: {
          temperature: options?.temperature ?? 0.7,
          ...(config.numCtx !== undefined && { num_ctx: config.numCtx }),
          ...(options?.numPredict !== undefined && { num_predict: options.numPredict }),
        },
      });
      for await (const chunk of stream) {
        const delta = chunk.message?.content ?? "";
        if (delta) yield delta;
        if (chunk.done) break;
      }
    });
  }
}

export class OllamaEmbedClient {
  private readonly client: Ollama;

  /**
   * @param prefixes モデルのタスク接頭辞（embedPrefixFor で決める）。未指定＝接頭辞なし。
   *   embedQuery/embedDocument が query/doc 接頭辞を前置きする。raw な embed() は付けない。
   */
  constructor(
    host: string,
    private readonly model: string,
    private readonly prefixes: { query: string; doc: string } = { query: "", doc: "" },
  ) {
    this.client = new Ollama({ host });
  }

  /** 想起クエリの埋め込み（query 接頭辞を付ける）。 */
  embedQuery(text: string): Promise<number[]> {
    return this.embed(this.prefixes.query + text);
  }

  /** 符号化（保存）するドキュメントの埋め込み（doc 接頭辞を付ける）。 */
  embedDocument(text: string): Promise<number[]> {
    return this.embed(this.prefixes.doc + text);
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      return embedEmptyVector(this.client, this.model);
    }
    // chat と同じ Ollama を叩くので同じリミッタを共有する
    return runLimited(() =>
      withLlmRetry(async () => {
        const response = await this.client.embed({
          model: this.model,
          input: text,
        });
        const first = response.embeddings[0];
        if (!first?.length) {
          throw new Error("Ollama embed returned empty vector");
        }
        return first;
      }),
    );
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
