/** 将 Monaco 行列转为字符串 offset。 */
export function positionToOffset(text: string, lineNumber: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lineNumber - 1; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset + column - 1;
}

/** 从 offset 所在位置提取单条 SQL（以分号分隔，忽略字符串与注释中的分号）。 */
export function extractStatementAtOffset(sql: string, offset: number): string {
  const pos = Math.max(0, Math.min(offset, sql.length));
  let start = 0;
  let end = sql.length;

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let lineComment = false;
  let blockComment = false;

  const isEscaped = (i: number) => {
    let slashes = 0;
    for (let j = i - 1; j >= 0 && sql[j] === "\\"; j--) {
      slashes++;
    }
    return slashes % 2 === 1;
  };

  for (let i = 0; i < pos; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "-" && next === "-") {
        lineComment = true;
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        blockComment = true;
        i++;
        continue;
      }
    }
    if (ch === "'" && !inDouble && !inBacktick && !isEscaped(i)) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick && !isEscaped(i)) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }
    if (ch === ";" && !inSingle && !inDouble && !inBacktick) {
      start = i + 1;
    }
  }

  inSingle = false;
  inDouble = false;
  inBacktick = false;
  lineComment = false;
  blockComment = false;

  for (let i = pos; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "-" && next === "-") {
        lineComment = true;
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        blockComment = true;
        i++;
        continue;
      }
    }
    if (ch === "'" && !inDouble && !inBacktick && !isEscaped(i)) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick && !isEscaped(i)) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }
    if (ch === ";" && !inSingle && !inDouble && !inBacktick) {
      end = i;
      break;
    }
  }

  return sql.slice(start, end).trim();
}

/** 在 offset 处提取语句；无分句时回退为全文 trim。 */
export function sqlAtOffset(sql: string, offset: number): string {
  const statement = extractStatementAtOffset(sql, offset);
  return statement || sql.trim();
}

/** 当前焦点是否在 SQL Monaco 编辑器内。 */
export function isSqlMonacoEditorFocused(): boolean {
  const el = document.activeElement;
  return !!el?.closest(".sql-monaco-editor");
}
