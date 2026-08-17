/**
 * 本地 decoration 占位（\r\n）与 ConPTY 行号脱节时，PSReadLine 仍按 PTY
 * 里的提示符行做绝对定位（CUP/HVP/CUU）。前 1～2 个字符往往只是相对回显，
 * 第 3 个字符开始语法着色/预测会整行重绘，光标就被 CUP 拉回卡片区。
 *
 * 光标已在卡下 + 空闲提示符：落进占位的 CUP 改到当前行（CR/CHA），
 * 否则丢掉 CUP 后 PSReadLine 会把整行叠在已输入文字后面（pw + pwd → pwpwd）。
 *
 * Get-Date 式插入（同一块里 CUP 前面已有正文，如 `11:25` + CUP + `:22`）
 * 仍丢掉 CUP，避免变成 `\x1b[22G` 把 `:22` 甩到 PS> 后面。
 *
 * 光标还在卡内时：跳到卡底下一行列 1。
 * 真清屏（2J / 3J）原样通过。`\x1b[J` / `0J` 不是 cls。
 */

const CSI_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;

export type ConptyCursorRewriteContext = {
  /** 所有卡片占位底（不含该行）。null 表示无卡 */
  cardsBottomAbs: number | null;
  viewportY: number;
  cursorAbs: number;
  /** 视口行数，用于把卡底换成 CUP 行号 */
  viewportRows?: number;
  /**
   * 空闲 PS> 上打字（无前台命令 / Agent 执行）。
   * 此时落进卡区的行首 CUP 是 PSReadLine 重绘，必须钉在当前行。
   */
  idlePrompt?: boolean;
};

/** 真清屏：2J 全屏 / 3J scrollback。不含 0J/J（擦下方）和 1J（擦上方） */
export function hasConptyScreenReset(input: string): boolean {
  return /\x1b\[[23]J/.test(input);
}

function cupToCurrentLine(params: string): string {
  const parts = params.split(";");
  const colRaw = parts.length >= 2 ? parts[1] : "1";
  const col = Number(colRaw || "1");
  if (!Number.isFinite(col) || col <= 1) return "\r";
  return `\x1b[${col}G`;
}

function parseCsiCount(params: string, fallback: number): number {
  const n = Number(params || String(fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cupHitsCard(
  params: string,
  ctx: ConptyCursorRewriteContext,
): boolean {
  if (ctx.cardsBottomAbs == null) return false;
  const parts = params.split(";");
  const row = parseCsiCount(parts[0] ?? "", 1);
  const absLine = ctx.viewportY + row - 1;
  return absLine < ctx.cardsBottomAbs;
}

function cupCol(params: string): number {
  const parts = params.split(";");
  if (parts.length < 2) return 1;
  return parseCsiCount(parts[1] ?? "", 1);
}

function cupToBelowCards(ctx: ConptyCursorRewriteContext): string {
  if (ctx.cardsBottomAbs == null) return "\r";
  const row = ctx.cardsBottomAbs - ctx.viewportY + 1;
  const maxRow = ctx.viewportRows ?? 0;
  if (row < 1 || (maxRow > 0 && row > maxRow)) return "\r";
  return `\x1b[${row};1H`;
}

/** CUP 前面同一块里已有可见正文 → Get-Date 那种列插入，不是 PSReadLine 重绘 */
function csiHasPrintablePrefix(input: string, offset: number): boolean {
  const prefix = input.slice(0, offset);
  const text = prefix
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "");
  return text.length > 0;
}

/**
 * 改写 ConPTY 光标序列。
 * - 无 ctx：一律把 CUP 钉在当前行（旧行为，单测保留）
 * - 有 ctx：只拦截会画进卡片占位的 CUP/CUU/1J；卡下的定位放行
 */
export function stripConptyCursorRestore(
  input: string,
  ctx?: ConptyCursorRewriteContext,
): string {
  if (!input.includes("\x1b[")) return input;
  if (hasConptyScreenReset(input)) return input;
  const selective = ctx != null && ctx.cardsBottomAbs != null;
  return input.replace(CSI_RE, (full, params: string, cmd: string, offset: number) => {
    if (cmd === "A") {
      if (!selective || !ctx) return "";
      const n = parseCsiCount(params, 1);
      const target = ctx.cursorAbs - n;
      if (target >= ctx.cardsBottomAbs!) return full;
      const allowed = ctx.cursorAbs - ctx.cardsBottomAbs!;
      if (allowed <= 0) return "";
      return `\x1b[${allowed}A`;
    }
    if (cmd === "H" || cmd === "f") {
      if (selective && ctx) {
        if (!cupHitsCard(params, ctx)) return full;
        const below = ctx.cursorAbs >= ctx.cardsBottomAbs!;
        const col = cupCol(params);
        // Get-Date：`11:25` + CUP col22 + `:22` —— 丢掉 CUP，让秒数接在后面
        if (col > 1 && csiHasPrintablePrefix(input, offset)) return "";
        // 空闲提示符上的 PSReadLine 重绘：钉在当前输入行，禁止丢掉 CUP 叠字
        if (below && ctx.idlePrompt) return cupToCurrentLine(params);
        // 命令输出：换行续写或已在卡下则丢掉，避免跳进占位 / :22 甩到 PS>
        if (col > 1 || below) return "";
        return cupToBelowCards(ctx);
      }
      return cupToCurrentLine(params);
    }
    if (cmd === "J" && selective && ctx) {
      const n = params === "" ? 0 : Number(params);
      if (n === 1) return "";
    }
    return full;
  });
}
