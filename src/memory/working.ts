import type { ConversationTurn } from "../types.js";

function turnChannel(turn: ConversationTurn): "dialogue" | "monologue" {
  return turn.channel ?? "dialogue";
}

function isSameTurn(a: ConversationTurn, b: ConversationTurn): boolean {
  return (
    a.role === b.role &&
    turnChannel(a) === turnChannel(b) &&
    a.content === b.content &&
    a.speakerId === b.speakerId
  );
}

function dedupeConsecutiveTurns(
  turns: readonly ConversationTurn[],
): ConversationTurn[] {
  const result: ConversationTurn[] = [];
  for (const turn of turns) {
    const last = result[result.length - 1];
    if (last && isSameTurn(last, turn)) continue;
    result.push(turn);
  }
  return result;
}

export class WorkingMemory {
  private turns: ConversationTurn[];

  constructor(
    private readonly maxTurns: number,
    initial: readonly ConversationTurn[] = [],
  ) {
    this.turns = dedupeConsecutiveTurns(initial).slice(-maxTurns);
  }

  append(turn: ConversationTurn): void {
    const last = this.turns[this.turns.length - 1];
    if (last && isSameTurn(last, turn)) return;
    const withTs: ConversationTurn = turn.createdAt
      ? turn
      : { ...turn, createdAt: new Date().toISOString() };
    this.turns.push(withTs);
    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns);
    }
  }

  getRecent(): readonly ConversationTurn[] {
    return this.turns;
  }

  lastUserContent(): string {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === "user") return this.turns[i].content;
    }
    return "";
  }
}
