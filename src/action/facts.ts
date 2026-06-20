// remember / recall は現状どの actor も生成しない名残（remember 廃止＝importance 採点へ・能動 recall actor 撤去＝背景 recall へ）。
// present.ts の exhaustive switch と過去エピソードの互換のため型は残す。forget は out-of-band の runForget が、
// research/express は webSearch/urlBrowse の研究実行器が生成する（現役）。
export type ActionFacts =
  | { kind: "memo_read"; filename: string; body: string }
  | { kind: "memo_write"; filename: string; body: string }
  | { kind: "remember"; body: string }
  | { kind: "recall"; bullets: string[] }
  | { kind: "forget"; body: string }
  | { kind: "research"; tool: string; title: string; summary: string; body: string }
  | { kind: "express"; tool: string; title: string; body: string }
  | { kind: "synthesize"; filename: string; body: string }
  | {
      kind: "steps";
      stepsId: string;
      filename: string;
      body: string;
      achieved: boolean;
      /** この op が計画に対して何をしたか（表示と focus 制御に使う）。
       *  view=参照(読むだけ・focus変えない) / create=立てた / activate=始めた・再開した /
       *  shelve=棚上げ / retire=見限り / update=手で更新 */
      action: "view" | "create" | "activate" | "shelve" | "retire" | "update";
    };
