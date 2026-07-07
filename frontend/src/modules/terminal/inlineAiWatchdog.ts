/** 内联 AI 流式无 delta 超时阈值（毫秒） */
export const INLINE_AI_STALL_THRESHOLD_MS = 60_000;

const lastDeltaAtByBlock = new Map<string, number>();
const stalledBlocks = new Set<string>();

export function touchInlineAiDelta(blockId: string): void {
  lastDeltaAtByBlock.set(blockId, Date.now());
  stalledBlocks.delete(blockId);
}

export function clearInlineAiWatchdog(blockId: string): void {
  lastDeltaAtByBlock.delete(blockId);
  stalledBlocks.delete(blockId);
}

export function isInlineAiStalled(blockId: string): boolean {
  return stalledBlocks.has(blockId);
}

export function checkInlineAiStall(blockId: string, thresholdMs = INLINE_AI_STALL_THRESHOLD_MS): boolean {
  if (stalledBlocks.has(blockId)) return true;
  const lastAt = lastDeltaAtByBlock.get(blockId);
  if (!lastAt) return false;
  if (Date.now() - lastAt < thresholdMs) return false;
  stalledBlocks.add(blockId);
  return true;
}

export function resetInlineAiStall(blockId: string): void {
  stalledBlocks.delete(blockId);
  lastDeltaAtByBlock.set(blockId, Date.now());
}
