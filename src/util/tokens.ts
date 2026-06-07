/** 粗いトークン見積もり（日本語寄り係数） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function exceedsTokenBudget(text: string, budget: number): boolean {
  return estimateTokens(text) > budget;
}
