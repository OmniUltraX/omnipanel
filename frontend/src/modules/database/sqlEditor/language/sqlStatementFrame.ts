import { type Extension } from "@codemirror/state";
import {
  Direction,
  EditorView,
  layer,
  type LayerMarker,
  type ViewUpdate,
} from "@codemirror/view";
import { splitSqlStatements, type SqlStatementPart } from "../../sqlIntel/sqlLex";

/** 语句可视范围从第一行真正的 SQL 开始，开头的 `--` / 块注释留在框外。 */
export function statementCodeStart(text: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (text.startsWith("--", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 || nl >= to ? to : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 || end + 2 > to ? to : end + 2;
      continue;
    }
    break;
  }
  return i;
}

export interface SqlSubqueryRange {
  /** 括号内 SELECT / WITH 的起点 */
  from: number;
  /** 对应右括号之前 */
  to: number;
  sql: string;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_]/.test(ch);
}

function keywordAt(text: string, i: number, word: string): boolean {
  if (i < 0 || i + word.length > text.length) return false;
  if (text.slice(i, i + word.length).toLowerCase() !== word) return false;
  if (isIdentChar(text[i - 1]) || isIdentChar(text[i + word.length])) return false;
  return true;
}

function skipSpaceAndComments(text: string, i: number, end: number): number {
  while (i < end) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (text.startsWith("--", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? end : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    break;
  }
  return i;
}

/** 括号内以 SELECT / WITH 开头的子查询，不含函数调用和值列表。 */
export function findSqlSubqueries(text: string): SqlSubqueryRange[] {
  const found: SqlSubqueryRange[] = [];
  const parenStack: number[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "-" && next === "-") {
        lineComment = true;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        blockComment = true;
        i += 1;
        continue;
      }
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick) continue;
    if (ch === "(") {
      parenStack.push(i);
      continue;
    }
    if (ch !== ")" || parenStack.length === 0) continue;
    const open = parenStack.pop();
    if (open == null) continue;
    const keyword = skipSpaceAndComments(text, open + 1, i);
    if (!keywordAt(text, keyword, "select") && !keywordAt(text, keyword, "with")) continue;
    let end = i;
    while (end > keyword && /\s/.test(text[end - 1] ?? "")) end -= 1;
    if (end <= keyword) continue;
    found.push({ from: keyword, to: end, sql: text.slice(keyword, end).trim() });
  }
  return found;
}

export function smallestSubqueryAt(text: string, head: number): SqlSubqueryRange | null {
  let best: SqlSubqueryRange | null = null;
  for (const query of findSqlSubqueries(text)) {
    if (head < query.from || head > query.to) continue;
    if (!best || query.to - query.from < best.to - best.from) best = query;
  }
  return best;
}

const PAD = 3;

interface LineBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function documentBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  const ltr = view.textDirection === Direction.LTR;
  const left = ltr
    ? rect.left
    : rect.right - view.scrollDOM.clientWidth * view.scaleX;
  return {
    left: left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

function statementAtCursor(text: string, head: number): SqlStatementPart | null {
  const parts = splitSqlStatements(text);
  for (const stmt of parts) {
    if (head >= stmt.from && head < stmt.to) return stmt;
  }
  if (parts.length > 0 && head === text.length && head === parts[parts.length - 1].to) {
    return parts[parts.length - 1];
  }
  return null;
}

function lineBoxes(view: EditorView, stmt: SqlStatementPart, text: string): LineBox[] {
  const start = statementCodeStart(text, stmt.from, stmt.to);
  if (start >= stmt.to) return [];
  const base = documentBase(view);
  const first = view.state.doc.lineAt(start);
  const last = view.state.doc.lineAt(Math.max(start, stmt.to - 1));
  const boxes: LineBox[] = [];
  for (let n = first.number; n <= last.number; n += 1) {
    const line = view.state.doc.line(n);
    const from = Math.max(line.from, start);
    const to = Math.min(line.to, stmt.to);
    if (from >= to) continue;
    const a = view.coordsAtPos(from, 1);
    const b = view.coordsAtPos(to, -1);
    if (!a || !b) continue;
    const left = Math.min(a.left, b.left) - base.left - PAD;
    const right = Math.max(a.right, b.right) - base.left + PAD;
    if (right - left < 2) continue;
    boxes.push({
      left,
      right,
      top: Math.min(a.top, b.top) - base.top,
      bottom: Math.max(a.bottom, b.bottom) - base.top,
    });
  }
  if (boxes.length === 0) return [];
  boxes[0].top -= PAD;
  boxes[boxes.length - 1].bottom += PAD;
  for (let i = 1; i < boxes.length; i += 1) {
    const mid = (boxes[i - 1].bottom + boxes[i].top) / 2;
    boxes[i - 1].bottom = mid;
    boxes[i].top = mid;
  }
  return boxes;
}

/** 主体是齐边长方形；只有最后一行比上面窄时，底边右侧才收进去。 */
function outlinePath(boxes: LineBox[]): string {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = boxes[0].top;
  const bottom = boxes[boxes.length - 1].bottom;
  const last = boxes[boxes.length - 1];
  const bodyRight = Math.max(...boxes.slice(0, -1).map((box) => box.right), left);
  const right = boxes.length === 1 ? last.right : Math.max(bodyRight, last.right);
  const narrowLast = boxes.length > 1 && last.right < bodyRight - 1;
  const pts: Array<[number, number]> = narrowLast
    ? [
        [left, top],
        [bodyRight, top],
        [bodyRight, last.top],
        [last.right, last.top],
        [last.right, bottom],
        [left, bottom],
      ]
    : [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ];
  return `M ${pts.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
}

class StatementFrameMarker implements LayerMarker {
  readonly path: string;
  readonly width: number;
  readonly height: number;

  constructor(path: string, width: number, height: number) {
    this.path = path;
    this.width = width;
    this.height = height;
  }

  eq(other: LayerMarker): boolean {
    return other instanceof StatementFrameMarker && other.path === this.path;
  }

  draw(): HTMLElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "cm-sql-stmt-frame");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", this.path);
    svg.appendChild(path);
    this.place(svg);
    return svg as unknown as HTMLElement;
  }

  update(dom: HTMLElement): boolean {
    const path = dom.querySelector("path");
    if (!path) return false;
    path.setAttribute("d", this.path);
    this.place(dom);
    return true;
  }

  private place(svg: SVGSVGElement | HTMLElement) {
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.width = `${this.width}px`;
    svg.style.height = `${this.height}px`;
  }
}

function statementMarkers(view: EditorView): readonly LayerMarker[] {
  const text = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const subquery = smallestSubqueryAt(text, head);
  const stmt = subquery
    ? { sql: subquery.sql, from: subquery.from, to: subquery.to, hadTrailingSemicolon: false }
    : statementAtCursor(text, head);
  if (!stmt) return [];
  if (stmt.to <= view.viewport.from || stmt.from >= view.viewport.to) return [];
  const boxes = lineBoxes(view, stmt, text);
  if (boxes.length === 0) return [];
  let width = 0;
  let height = 0;
  for (const box of boxes) {
    width = Math.max(width, box.right);
    height = Math.max(height, box.bottom);
  }
  return [new StatementFrameMarker(outlinePath(boxes), width + PAD, height + PAD)];
}

const frameTheme = EditorView.baseTheme({
  ".cm-sql-stmt-frame": {
    position: "absolute",
    overflow: "visible",
    pointerEvents: "none",
  },
  ".cm-sql-stmt-frame path": {
    fill: "none",
    stroke: "var(--accent)",
    strokeWidth: "1px",
    strokeLinejoin: "round",
  },
});

export function createSqlStatementFrame(): Extension[] {
  return [
    layer({
      above: true,
      update(update: ViewUpdate) {
        return (
          update.docChanged
          || update.selectionSet
          || update.viewportChanged
          || update.geometryChanged
        );
      },
      markers: statementMarkers,
    }),
    frameTheme,
  ];
}
