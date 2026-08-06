/** 从 xterm 当前物理行提取可见文本（含提示符），供直通 Enter 回退识别 NL */

type XtermLine = {
  length: number;
  getCell: (i: number) => { getChars: () => string; getWidth: () => number } | undefined;
};

type XtermLike = {
  cols?: number;
  buffer: {
    active: {
      cursorY: number;
      baseY: number;
      getLine: (y: number) => XtermLine | undefined;
    };
  };
};

function readLineText(line: XtermLine): string {
  let text = "";
  for (let i = 0; i < line.length; i += 1) {
    const cell = line.getCell(i);
    if (!cell) continue;
    // 宽字符占多列，只在首格有 chars
    if (cell.getWidth() === 0) continue;
    text += cell.getChars() ?? "";
  }
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\u00a0/g, " ").trimEnd();
}

export function readActiveTerminalLine(term: XtermLike): string {
  const buf = term.buffer.active;
  const y = buf.cursorY + buf.baseY;
  const line = buf.getLine(y);
  if (!line) return "";
  return readLineText(line);
}

/**
 * 粗剥提示符：取最后一个 $/#/>/% 之后的内容；若无分隔符则整行。
 * 对 `user@host:~# 当前的时间` 这类行有效。
 */
export function stripShellPromptPrefix(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const markers = ["# ", "$ ", "% ", "> "];
  let cut = -1;
  for (const m of markers) {
    const idx = trimmed.lastIndexOf(m);
    if (idx >= 0) cut = Math.max(cut, idx + m.length);
  }
  if (cut > 0) {
    return trimmed.slice(cut).trim();
  }
  // 无空格标记时：形如 user@host:~#cmd
  const m = /^(?:.*?)[$#%>]\s+/.exec(trimmed);
  if (m) return trimmed.slice(m[0].length).trim();
  return trimmed;
}

/** 提示符截止到正文起点的字符串下标（含 `$ ` 后空格） */
export function promptPrefixEndIndex(line: string): number {
  const body = stripShellPromptPrefix(line);
  if (!body) {
    // 整行像提示符：尽量对齐到末尾
    const m = /^(.*[$#%>]\s*)/.exec(line);
    return m ? m[1].length : Math.min(2, line.length);
  }
  const idx = line.lastIndexOf(body);
  if (idx < 0) return 0;
  return idx;
}

export function splitPromptAndBody(line: string): { prefix: string; body: string } {
  const end = promptPrefixEndIndex(line);
  return {
    prefix: line.slice(0, end),
    body: line.slice(end).trimEnd(),
  };
}

/**
 * 量提示符占用的终端列数（xterm cell columns）。
 * 卡片左缘应对齐到该列，即 `$ ` 之后与用户正文齐平。
 */
export function measurePromptPrefixCols(term: XtermLike): number {
  const buf = term.buffer.active;
  const y = buf.cursorY + buf.baseY;
  const line = buf.getLine(y);
  if (!line) return 2;

  const text = readLineText(line);
  const end = promptPrefixEndIndex(text);
  if (end <= 0) return 2;

  // 按单元格扫描，把字符串下标映射到列
  let seen = 0;
  for (let col = 0; col < line.length; col += 1) {
    const cell = line.getCell(col);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() ?? "";
    if (!chars) {
      // 空格格
      seen += 1;
      if (seen >= end) return col + 1;
      continue;
    }
    for (let i = 0; i < chars.length; i += 1) {
      seen += 1;
      if (seen >= end) {
        // 当前字符所在列的下一列 = 正文起点
        return col + cell.getWidth();
      }
    }
  }

  // 回退：字符串长度近似（ASCII 提示符足够准）
  return Math.min(line.length, Math.max(2, end));
}

