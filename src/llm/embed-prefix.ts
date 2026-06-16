/**
 * embedding モデルのタスク接頭辞（query/document）の単一情報源。
 * ruri/nomic/e5 はクエリと文書で別接頭辞を前置きしないと本来の retrieval 性能が出ない
 * （ruri は非対称＝「検索クエリ: 」/「検索文書: 」）。bge-m3 等は不要（空）。
 *
 * **重要**: 接頭辞はモデルの契約の一部。embedModel を変えたら必ず `npm run reindex`
 * （書き込み時の接頭辞と想起時の接頭辞が揃っている前提でベクトルが整合するため）。
 *
 * 評価ハーネス（eval:retrieval）と本番（bootstrap → OllamaEmbedClient）で共有する。
 */
export type EmbedPrefix = { query: string; doc: string };

export function embedPrefixFor(model: string): EmbedPrefix {
  const m = model.toLowerCase();
  if (m.includes("ruri")) return { query: "検索クエリ: ", doc: "検索文書: " };
  if (m.includes("nomic")) return { query: "search_query: ", doc: "search_document: " };
  if (m.includes("e5")) return { query: "query: ", doc: "passage: " };
  return { query: "", doc: "" };
}
