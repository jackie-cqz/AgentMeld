/**
 * Simple token estimation: ~4 characters per token.
 * For production use, a proper tokenizer should be used,
 * but this is sufficient for budget calculations in Phase 1.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
