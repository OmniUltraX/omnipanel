import type { TerminalBlock } from "../../stores/blocksStore";
import { isCdNavigationCommand } from "./terminalAutoLsPolicy";
import { isResidualShellNoise } from "./terminalCommandEcho";
import { tryParseLsListing } from "./lsListing/parseLsListing";
import { extractCommandOutput, isEchoOnlyTerminalOutput, normalizeBlockCommand } from "./terminalOutputText";

/** cd 后自动 ls 的 block，且目录为空或输出仅为回显/列表头 */
export function shouldUseDirectoryPreview(block: TerminalBlock): boolean {
  if (block.kind === "ai") return false;
  if (block.directoryPreview) return true;
  if (block.attachedListing) return false;
  if (block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0)) {
    return false;
  }

  const normalized = normalizeBlockCommand(block.command).trim();
  if (!isCdNavigationCommand(normalized)) return false;

  const listing = tryParseLsListing(block.command, block.output);
  if (listing && listing.entries.length > 0) return false;

  if (block.status === "running") {
    if (!block.output.trim()) return false;
    return isEchoOnlyTerminalOutput(block.output, block.command);
  }

  const cleaned = extractCommandOutput(block.output, block.command);
  if (!cleaned) return true;
  return isResidualShellNoise(cleaned);
}
