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

/** docker compose TTY 进度头：`[+] up 1/2` / `[-] Running 2/3` */
export function isDockerComposeProgressHeader(line: string): boolean {
  return /^\[(?:\+|-)\]\s+\S+/.test(line.trim());
}

/** docker compose 进度明细行（spinner / Image Pulling 等） */
export function isDockerComposeProgressDetail(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏❖✔✘◎○●]\s+\S+/.test(trimmed)) return true;
  if (
    /^(?:Image|Container|Service|Volume|Network|Build)\s+\S+/i.test(trimmed) &&
    /\b(?:Pulling|Pulled|Waiting|Downloading|Download complete|Extracting|Building|Built|Creating|Created|Starting|Started|Recreate|Running|Exited|Healthy|Error)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

/** 识别 apt/docker/snap 等工具的进度行（含换行刷新，无 `\r`）。 */
export function isProgressStatusLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isDockerComposeProgressHeader(trimmed)) return true;
  if (isDockerComposeProgressDetail(trimmed)) return true;
  if (/\d+\s*%/.test(trimmed)) return true;
  if (/\d+(?:\.\d+)?\s*(?:MB|KB|GB|kB|KiB|MiB|GiB)\/s/i.test(trimmed)) return true;
  if (
    /\b(?:Download(?:ing)?|Fetch(?:ing)?|Install(?:ing)?|Extract(?:ing)?|Pull(?:ing)?|Building|Unpacking|Resolving|Waiting|Setup|Run)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

function findLastComposeProgressHeaderIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isDockerComposeProgressHeader(lines[i])) return i;
  }
  return -1;
}

function shouldCollapseProgressLine(lines: string[], line: string): boolean {
  // Compose 多行帧只按 `[+]` 帧头折叠，避免把明细盖到帧头上、或误合并多镜像行
  if (isDockerComposeProgressHeader(line) || isDockerComposeProgressDetail(line)) {
    return false;
  }
  if (!isProgressStatusLine(line)) return false;
  if (lines.length === 0) return false;
  const prev = lines[lines.length - 1];
  if (isDockerComposeProgressHeader(prev) || isDockerComposeProgressDetail(prev)) {
    return false;
  }
  return isProgressStatusLine(prev);
}

function commitLine(lines: string[], line: string): string[] {
  // Compose 每帧以 `[+] ...` 重绘整段；CSI 被剥离后会无限追加，遇到新帧头就丢掉旧帧。
  if (isDockerComposeProgressHeader(line)) {
    const headerIdx = findLastComposeProgressHeaderIndex(lines);
    if (headerIdx >= 0) {
      return [...lines.slice(0, headerIdx), line];
    }
    return [...lines, line];
  }

  const next = [...lines];
  if (shouldCollapseProgressLine(next, line)) {
    next[next.length - 1] = line;
    return next;
  }
  next.push(line);
  return next;
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

  let lines = [...model.lines];
  let currentLine = model.currentLine;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\r") {
      const next = text[i + 1];
      if (next === "\n") {
        lines = commitLine(lines, currentLine);
        currentLine = "";
        i += 1;
      } else {
        currentLine = "";
      }
      continue;
    }
    if (ch === "\n") {
      lines = commitLine(lines, currentLine);
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
  if (stripped.includes("\r")) return true;
  if (isDockerComposeProgressHeader(stripped) || /\[(?:\+|-)\]\s+\S+/.test(stripped)) {
    return true;
  }
  const trailing = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return trailing ? isProgressStatusLine(trailing) : false;
}

export function renderLiveOutputText(model: TerminalOutputModel | undefined, fallback: string): string {
  if (!model) return fallback;
  const flattened = flattenOutputModel(model);
  return flattened || fallback;
}

/** 展示用：将已压平的进度刷屏折叠为末帧（兼容历史 block）。 */
export function collapseProgressOutputText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 1) return text;

  const result: string[] = [];
  for (const line of lines) {
    if (isDockerComposeProgressHeader(line)) {
      const headerIdx = findLastComposeProgressHeaderIndex(result);
      if (headerIdx >= 0) {
        result.length = headerIdx;
      }
      result.push(line);
      continue;
    }
    if (shouldCollapseProgressLine(result, line)) {
      result[result.length - 1] = line;
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}
