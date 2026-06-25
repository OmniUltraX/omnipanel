import type { TerminalBlock } from "../../stores/blocksStore";

export const DEFAULT_AI_DOCK_HEIGHT = 480;
export const MIN_AI_DOCK_HEIGHT = 200;
export const MAX_AI_DOCK_HEIGHT = 720;

export function clampAiDockHeight(height: number): number {
  const viewportCap = typeof window !== "undefined"
    ? Math.floor(window.innerHeight * 0.78)
    : MAX_AI_DOCK_HEIGHT;
  const max = Math.min(MAX_AI_DOCK_HEIGHT, viewportCap);
  return Math.min(max, Math.max(MIN_AI_DOCK_HEIGHT, Math.round(height)));
}

export function findLastAiBlock(blocks: TerminalBlock[]): TerminalBlock | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === "ai") return blocks[i];
  }
  return null;
}

export function findLastAiBlockId(blocks: TerminalBlock[]): string | null {
  return findLastAiBlock(blocks)?.id ?? null;
}
