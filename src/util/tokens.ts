/** 粗いトークン見積もり（英日混在向け） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function exceedsTokenBudget(text: string, budget: number): boolean {
  return estimateTokens(text) > budget;
}
