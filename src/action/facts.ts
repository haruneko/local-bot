export type ActionFacts =
  | { kind: "memo_read"; filename: string; body: string }
  | { kind: "memo_write"; filename: string; body: string }
  | { kind: "remember"; body: string }
  | { kind: "recall"; bullets: string[] }
  | { kind: "forget"; body: string }
  | { kind: "research"; tool: string; title: string; summary: string; body: string }
  | { kind: "express"; tool: string; title: string; body: string }
  | { kind: "synthesize"; filename: string; body: string }
  | { kind: "plan"; planId: string; filename: string; body: string; achieved: boolean };
