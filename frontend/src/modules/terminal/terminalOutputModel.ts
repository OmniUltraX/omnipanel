import { stripTerminalControlSequences } from "./terminalOutputText";

function stripForLiveIngest(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n");
}

/** Block 运行期输出模型：支持当前行 `\r` 覆盖。 */
export interface TerminalOutputModel {
  lines: string[];
  currentLine: string;
}

export function createEmptyOutputModel(): TerminalOutputModel {
  return { lines: [], currentLine: "" };
}

export function ingestTerminalOutputChunk(
  model: TerminalOutputModel,
  chunk: string,
): TerminalOutputModel {
  const text = stripForLiveIngest(chunk);
  if (!text) return model;

  const lines = [...model.lines];
  let currentLine = model.currentLine;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\r") {
      const next = text[i + 1];
      if (next === "\n") {
        lines.push(currentLine);
        currentLine = "";
        i += 1;
      } else {
        currentLine = "";
      }
      continue;
    }
    if (ch === "\n") {
      lines.push(currentLine);
      currentLine = "";
      continue;
    }
    currentLine += ch;
  }

  return { lines, currentLine };
}

export function flattenOutputModel(model: TerminalOutputModel): string {
  const parts = [...model.lines];
  if (model.currentLine) parts.push(model.currentLine);
  return parts.join("\n");
}

/** 检测进度类输出（同行动态刷新），用于 block-running → inline-running。 */
export function isInlineProgressChunk(chunk: string): boolean {
  if (!chunk) return false;
  const stripped = chunk
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  return stripped.includes("\r");
}

export function renderLiveOutputText(model: TerminalOutputModel | undefined, fallback: string): string {
  if (!model) return fallback;
  const flattened = flattenOutputModel(model);
  return flattened || fallback;
}
