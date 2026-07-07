import type { TerminalBlock } from "../../stores/blocksStore";

export type FeedOrphanShellsSegment = {
  kind: "orphan-shells";
  blocks: TerminalBlock[];
};

export type FeedAiRunSegment = {
  kind: "ai-run";
  ai: TerminalBlock;
  shells: TerminalBlock[];
};

export type FeedSegment = FeedOrphanShellsSegment | FeedAiRunSegment;

/** 将 Block 流按「AI + 其后 shell 直到下一条 AI」拆成吸顶段 */
export function groupFeedBlocksIntoSegments(blocks: TerminalBlock[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  let orphanShells: TerminalBlock[] = [];
  let currentRun: { ai: TerminalBlock; shells: TerminalBlock[] } | null = null;

  for (const block of blocks) {
    if (block.kind === "ai") {
      if (orphanShells.length > 0) {
        segments.push({ kind: "orphan-shells", blocks: orphanShells });
        orphanShells = [];
      }
      if (currentRun) {
        segments.push({ kind: "ai-run", ...currentRun });
      }
      currentRun = { ai: block, shells: [] };
      continue;
    }

    if (currentRun) {
      currentRun.shells.push(block);
    } else {
      orphanShells.push(block);
    }
  }

  if (orphanShells.length > 0) {
    segments.push({ kind: "orphan-shells", blocks: orphanShells });
  }
  if (currentRun) {
    segments.push({ kind: "ai-run", ...currentRun });
  }

  return segments;
}

/** 展开 AI 所在 segment 下标；-1 表示无或未找到 */
export function findExpandedAiSegmentIndex(
  segments: FeedSegment[],
  expandedAiBlockId: string | null,
): number {
  if (!expandedAiBlockId) return -1;
  return segments.findIndex(
    (segment) => segment.kind === "ai-run" && segment.ai.id === expandedAiBlockId,
  );
}
