import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  Direction,
  EditorView,
  layer,
  type DecorationSet,
  type LayerMarker,
  type ViewUpdate,
} from "@codemirror/view";
import { sqlErrorUnderline } from "../../sql/sqlExecErrorPresent";
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

export interface SqlFrameError {
  sql: string;
  message: string;
}

export const setSqlFrameErrorEffect = StateEffect.define<SqlFrameError | null>();

export interface SqlFrameFocus {
  from: number;
  to: number;
  /** 刚设上的框在短时间内不被同一次点击的选区清掉。 */
  at?: number;
}

export const setSqlFrameFocusEffect = StateEffect.define<SqlFrameFocus | null>();

const sqlFrameFocusField = StateField.define<SqlFrameFocus | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSqlFrameFocusEffect)) {
        return effect.value ? { ...effect.value, at: Date.now() } : null;
      }
    }
    if (tr.selection && value) {
      if (value.at != null && Date.now() - value.at < 500) return value;
      const head = tr.selection.main.head;
      if (head < value.from || head > value.to) return null;
    }
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from);
      const to = tr.changes.mapPos(value.to);
      return to > from ? { from, to } : null;
    }
    return value;
  },
});

export function findSqlInDoc(doc: string, sql: string): SqlFrameFocus | null {
  const needle = sql.trim();
  if (!needle) return null;
  const exact = doc.indexOf(needle);
  if (exact >= 0) return { from: exact, to: exact + needle.length };
  const parts = needle.split(/\s+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return null;
  const match = new RegExp(parts.join("\\s+")).exec(doc);
  if (!match) return null;
  return { from: match.index, to: match.index + match[0].length };
}

const sqlFrameErrorField = StateField.define<SqlFrameError | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSqlFrameErrorEffect)) return effect.value;
    }
    return value;
  },
});

function sameSql(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

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
  readonly failed: boolean;

  constructor(path: string, width: number, height: number, failed: boolean) {
    this.path = path;
    this.width = width;
    this.height = height;
    this.failed = failed;
  }

  eq(other: LayerMarker): boolean {
    return other instanceof StatementFrameMarker && other.path === this.path && other.failed === this.failed;
  }

  draw(): HTMLElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", this.failed ? "cm-sql-stmt-frame is-failed" : "cm-sql-stmt-frame");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", this.path);
    path.style.stroke = this.failed ? "var(--danger, #ff453a)" : "var(--accent)";
    svg.appendChild(path);
    this.place(svg);
    return svg as unknown as HTMLElement;
  }

  update(dom: HTMLElement): boolean {
    const path = dom.querySelector("path");
    if (!path) return false;
    dom.setAttribute("class", this.failed ? "cm-sql-stmt-frame is-failed" : "cm-sql-stmt-frame");
    path.setAttribute("d", this.path);
    path.style.stroke = this.failed ? "var(--danger, #ff453a)" : "var(--accent)";
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

class SqlFixButtonMarker implements LayerMarker {
  readonly left: number;
  readonly top: number;
  private readonly onFix: () => void;

  constructor(left: number, top: number, onFix: () => void) {
    this.left = left;
    this.top = top;
    this.onFix = onFix;
  }

  eq(other: LayerMarker): boolean {
    return other instanceof SqlFixButtonMarker && other.left === this.left && other.top === this.top;
  }

  draw(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-sql-stmt-fix";
    btn.textContent = "修复";
    btn.style.whiteSpace = "nowrap";
    btn.style.width = "max-content";
    btn.style.left = `${this.left}px`;
    btn.style.top = `${this.top}px`;
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onFix();
    });
    return btn;
  }

  update(dom: HTMLElement): boolean {
    dom.style.left = `${this.left}px`;
    dom.style.top = `${this.top}px`;
    return true;
  }
}

function statementMarkers(view: EditorView, onFix: () => void): readonly LayerMarker[] {
  const text = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const focus = view.state.field(sqlFrameFocusField, false);
  const focused = focus && focus.from >= 0 && focus.to <= text.length && focus.to > focus.from
    ? {
        sql: text.slice(focus.from, focus.to),
        from: focus.from,
        to: focus.to,
        hadTrailingSemicolon: false,
      }
    : null;
  const subquery = smallestSubqueryAt(text, head);
  const stmt = focused
    ?? (subquery
      ? { sql: subquery.sql, from: subquery.from, to: subquery.to, hadTrailingSemicolon: false }
      : statementAtCursor(text, head));
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
  const failedSql = view.state.field(sqlFrameErrorField, false);
  const failed = Boolean(failedSql && (sameSql(failedSql.sql, stmt.sql) || sameSql(failedSql.sql, text)));
  const markers: LayerMarker[] = [
    new StatementFrameMarker(outlinePath(boxes), width + PAD, height + PAD, failed),
  ];
  if (failed) {
    const edge = Math.max(...boxes.map((box) => box.right));
    markers.push(new SqlFixButtonMarker(edge + 8, boxes[0].top, onFix));
  }
  return markers;
}

const errorUnderlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let error = tr.startState.field(sqlFrameErrorField, false);
    for (const effect of tr.effects) {
      if (effect.is(setSqlFrameErrorEffect)) error = effect.value;
    }
    if (!error) return Decoration.none;
    if (!tr.docChanged && !tr.effects.some((effect) => effect.is(setSqlFrameErrorEffect))) {
      return value.map(tr.changes);
    }
    const text = tr.state.doc.toString();
    const span = sqlErrorUnderline(text, error.message);
    if (!span || span.from < 0 || span.to > text.length || span.from >= span.to) return Decoration.none;
    return Decoration.set([
      Decoration.mark({ class: "cm-sql-error-underline" }).range(span.from, span.to),
    ]);
  },
});

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
  ".cm-sql-stmt-frame.is-failed path": {
    stroke: "var(--danger, #ff453a)",
  },
  ".cm-sql-error-underline": {
    textDecoration: "underline wavy var(--danger, #ff453a)",
    textUnderlineOffset: "2px",
  },
  ".cm-sql-stmt-fix": {
    position: "absolute",
    zIndex: "4",
    width: "max-content",
    height: "18px",
    padding: "0 6px",
    border: "1px solid var(--danger, #ff453a)",
    borderRadius: "4px",
    background: "var(--surface, #fff)",
    color: "var(--danger, #ff453a)",
    fontSize: "11px",
    lineHeight: "16px",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
});

export function createSqlStatementFrame(onFix: () => void): Extension[] {
  return [
    sqlFrameErrorField,
    sqlFrameFocusField,
    errorUnderlineField,
    EditorView.decorations.from(errorUnderlineField),
    layer({
      above: true,
      update(update: ViewUpdate) {
        return (
          update.docChanged
          || update.selectionSet
          || update.viewportChanged
          || update.geometryChanged
          || update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(setSqlFrameErrorEffect) || effect.is(setSqlFrameFocusEffect))
          )
        );
      },
      markers: (view) => statementMarkers(view, onFix),
    }),
    frameTheme,
  ];
}
