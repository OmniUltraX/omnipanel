/**
 * INSERT ... (cols) VALUES (...) / SELECT ... 列名 inlay + 悬停高亮（DataGrip 风格）。
 * 仅处理显式列清单；无列清单 / INSERT SET 暂不标注。
 */
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type Decoration as DecorationType,
  type ViewUpdate,
} from "@codemirror/view";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";

export type InsertColumnInlay = {
  /** 文档绝对偏移：挂在 value token 起点前 */
  from: number;
  column: string;
};

/** value ↔ field 绑定（用于 inlay 与悬停高亮） */
export type InsertColumnBinding = {
  column: string;
  fieldFrom: number;
  fieldTo: number;
  valueFrom: number;
  valueTo: number;
};

type LexFlags = {
  inSingle: boolean;
  inDouble: boolean;
  inBacktick: boolean;
  lineComment: boolean;
  blockComment: boolean;
};

function createLexFlags(): LexFlags {
  return {
    inSingle: false,
    inDouble: false,
    inBacktick: false,
    lineComment: false,
    blockComment: false,
  };
}

function isEscaped(sql: string, i: number): boolean {
  let slashes = 0;
  for (let j = i - 1; j >= 0 && sql[j] === "\\"; j -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function stepLex(sql: string, i: number, flags: LexFlags): number {
  const ch = sql[i];
  const next = sql[i + 1];

  if (flags.lineComment) {
    if (ch === "\n") flags.lineComment = false;
    return i;
  }
  if (flags.blockComment) {
    if (ch === "*" && next === "/") {
      flags.blockComment = false;
      return i + 1;
    }
    return i;
  }
  if (!flags.inSingle && !flags.inDouble && !flags.inBacktick) {
    if (ch === "-" && next === "-") {
      flags.lineComment = true;
      return i + 1;
    }
    if (ch === "/" && next === "*") {
      flags.blockComment = true;
      return i + 1;
    }
  }
  if (ch === "'" && !flags.inDouble && !flags.inBacktick && !isEscaped(sql, i)) {
    flags.inSingle = !flags.inSingle;
    return i;
  }
  if (ch === '"' && !flags.inSingle && !flags.inBacktick && !isEscaped(sql, i)) {
    flags.inDouble = !flags.inDouble;
    return i;
  }
  if (ch === "`" && !flags.inSingle && !flags.inDouble) {
    flags.inBacktick = !flags.inBacktick;
  }
  return i;
}

function inCode(flags: LexFlags): boolean {
  return (
    !flags.inSingle &&
    !flags.inDouble &&
    !flags.inBacktick &&
    !flags.lineComment &&
    !flags.blockComment
  );
}

/** 仅跳过空白与注释；不吞掉字符串/反引号标识符（那是后续 token） */
function skipWsAndComments(sql: string, start: number): number {
  let i = start;
  let lineComment = false;
  let blockComment = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function matchKeywordAt(sql: string, i: number, keyword: string): number | null {
  if (i + keyword.length > sql.length) return null;
  const slice = sql.slice(i, i + keyword.length);
  if (slice.toUpperCase() !== keyword.toUpperCase()) return null;
  const after = sql[i + keyword.length];
  if (after && /[A-Za-z0-9_$]/.test(after)) return null;
  return i + keyword.length;
}

function stripIdentQuotes(name: string): string {
  if (name.length >= 2) {
    const a = name[0];
    const b = name[name.length - 1];
    if ((a === "`" && b === "`") || (a === '"' && b === '"') || (a === "[" && b === "]")) {
      return name.slice(1, -1);
    }
  }
  return name;
}

/** 读取标识符（含 schema.table），返回结束位置 */
function readQualifiedIdent(sql: string, start: number): number | null {
  let i = skipWsAndComments(sql, start);
  const readOne = (): number | null => {
    if (i >= sql.length) return null;
    const ch = sql[i];
    if (ch === "`" || ch === '"' || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      i += 1;
      while (i < sql.length && sql[i] !== close) i += 1;
      if (i >= sql.length) return null;
      i += 1;
      return i;
    }
    if (/[A-Za-z_]/.test(ch)) {
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i += 1;
      return i;
    }
    return null;
  };
  if (readOne() == null) return null;
  const afterFirst = skipWsAndComments(sql, i);
  if (sql[afterFirst] === ".") {
    i = afterFirst + 1;
    if (readOne() == null) return null;
  }
  return i;
}

function findMatchingCloseParen(sql: string, openIndex: number): number {
  const flags = createLexFlags();
  for (let i = 0; i < openIndex; i += 1) {
    i = stepLex(sql, i, flags);
  }
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inCode(flags)) {
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    i = stepLex(sql, i, flags);
  }
  return -1;
}

type NamedSpan = { column: string; from: number; to: number };
type PosRange = { from: number; to: number };

function trimRangeEnd(sql: string, from: number, endExclusive: number): number {
  let to = endExclusive;
  while (to > from && /\s/.test(sql[to - 1]!)) to -= 1;
  return to;
}

function parseColumnListSpans(
  sql: string,
  openParen: number,
  closeParen: number,
  baseOffset: number,
): NamedSpan[] {
  const inner = sql.slice(openParen + 1, closeParen);
  const columns: NamedSpan[] = [];
  const flags = createLexFlags();
  let depth = 0;
  let partStart = 0;
  const innerBase = baseOffset + openParen + 1;

  const flush = (end: number) => {
    const raw = inner.slice(partStart, end);
    const trimmed = raw.trim();
    if (!trimmed) return;
    const lead = raw.length - raw.trimStart().length;
    const from = innerBase + partStart + lead;
    columns.push({
      column: stripIdentQuotes(trimmed),
      from,
      to: from + trimmed.length,
    });
  };

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (inCode(flags)) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        flush(i);
        partStart = i + 1;
      }
    }
    i = stepLex(inner, i, flags);
  }
  flush(inner.length);
  return columns;
}

/** 在 VALUES 元组内收集各 value 区间 */
function collectValueRanges(sql: string, openParen: number, closeParen: number): PosRange[] {
  const ranges: PosRange[] = [];
  const flags = createLexFlags();
  for (let i = 0; i < openParen; i += 1) {
    i = stepLex(sql, i, flags);
  }

  let depth = 0;
  let expectValue = false;
  let valueFrom: number | null = null;

  const closeValue = (endExclusive: number) => {
    if (valueFrom == null) return;
    ranges.push({ from: valueFrom, to: trimRangeEnd(sql, valueFrom, endExclusive) });
    valueFrom = null;
  };

  for (let i = openParen; i <= closeParen; i += 1) {
    const ch = sql[i]!;
    if (inCode(flags)) {
      if (ch === "(") {
        if (depth === 0) {
          depth = 1;
          expectValue = true;
        } else {
          depth += 1;
          if (expectValue && valueFrom == null) {
            valueFrom = i;
            expectValue = false;
          }
        }
      } else if (ch === ")") {
        if (depth === 1) {
          closeValue(i);
          depth = 0;
          expectValue = false;
        } else {
          depth = Math.max(0, depth - 1);
        }
      } else if (ch === "," && depth === 1) {
        closeValue(i);
        expectValue = true;
      } else if (
        expectValue &&
        valueFrom == null &&
        ch !== " " &&
        ch !== "\t" &&
        ch !== "\r" &&
        ch !== "\n"
      ) {
        valueFrom = i;
        expectValue = false;
      }
    }
    if (i < closeParen) {
      i = stepLex(sql, i, flags);
    }
  }
  return ranges;
}

/** 从 VALUES 后扫描所有 (...), (...) 元组 */
function collectValueTuples(sql: string, valuesKeywordEnd: number): Array<{ open: number; close: number }> {
  const tuples: Array<{ open: number; close: number }> = [];
  let i = skipWsAndComments(sql, valuesKeywordEnd);
  while (i < sql.length) {
    if (sql[i] !== "(") break;
    const close = findMatchingCloseParen(sql, i);
    if (close < 0) break;
    tuples.push({ open: i, close });
    i = skipWsAndComments(sql, close + 1);
    if (sql[i] === ",") {
      i = skipWsAndComments(sql, i + 1);
      continue;
    }
    break;
  }
  return tuples;
}

const SELECT_LIST_TERMINATORS = [
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "FETCH",
  "WINDOW",
] as const;

function matchAnyKeywordAt(sql: string, i: number, keywords: readonly string[]): number | null {
  for (const kw of keywords) {
    const end = matchKeywordAt(sql, i, kw);
    if (end != null) return end;
  }
  return null;
}

/**
 * INSERT ... SELECT expr, expr, ... [FROM|WHERE|...]
 * 收集 SELECT 列表各项区间（depth=0 逗号分隔，遇终止关键字停止）。
 */
function collectSelectListRanges(sql: string, selectKeywordEnd: number): PosRange[] {
  let i = skipWsAndComments(sql, selectKeywordEnd);
  const distinct =
    matchKeywordAt(sql, i, "DISTINCTROW") ??
    matchKeywordAt(sql, i, "DISTINCT") ??
    matchKeywordAt(sql, i, "ALL");
  if (distinct != null) {
    i = skipWsAndComments(sql, distinct);
  }

  if (sql[i] === "*") {
    const afterStar = skipWsAndComments(sql, i + 1);
    if (
      afterStar >= sql.length ||
      sql[afterStar] === "," ||
      matchAnyKeywordAt(sql, afterStar, SELECT_LIST_TERMINATORS) != null
    ) {
      return [];
    }
  }

  const ranges: PosRange[] = [];
  const flags = createLexFlags();
  for (let p = 0; p < i; p += 1) {
    p = stepLex(sql, p, flags);
  }

  let depth = 0;
  let expectItem = true;
  let itemFrom: number | null = null;

  const closeItem = (endExclusive: number) => {
    if (itemFrom == null) return;
    ranges.push({ from: itemFrom, to: trimRangeEnd(sql, itemFrom, endExclusive) });
    itemFrom = null;
  };

  while (i < sql.length) {
    const ch = sql[i]!;
    if (inCode(flags)) {
      if (depth === 0 && itemFrom != null && !expectItem) {
        const term = matchAnyKeywordAt(sql, i, SELECT_LIST_TERMINATORS);
        if (term != null) {
          closeItem(i);
          break;
        }
      }
      if (ch === "(") {
        if (expectItem && depth === 0 && itemFrom == null) {
          itemFrom = i;
          expectItem = false;
        }
        depth += 1;
      } else if (ch === ")") {
        depth = Math.max(0, depth - 1);
      } else if (ch === "," && depth === 0) {
        closeItem(i);
        expectItem = true;
      } else if (
        expectItem &&
        depth === 0 &&
        itemFrom == null &&
        ch !== " " &&
        ch !== "\t" &&
        ch !== "\r" &&
        ch !== "\n"
      ) {
        if (matchAnyKeywordAt(sql, i, SELECT_LIST_TERMINATORS) != null) {
          break;
        }
        itemFrom = i;
        expectItem = false;
      }
    }
    const next = stepLex(sql, i, flags);
    i = next > i ? next : i + 1;
  }
  if (itemFrom != null) {
    closeItem(sql.length);
  }
  return ranges;
}

/** 跳过 INSERT 与 INTO 之间的可选修饰：IGNORE / OR REPLACE 等 */
function skipInsertModifiers(sql: string, start: number): number {
  let i = skipWsAndComments(sql, start);
  for (;;) {
    const orEnd = matchKeywordAt(sql, i, "OR");
    if (orEnd != null) {
      i = skipWsAndComments(sql, orEnd);
      const mod =
        matchKeywordAt(sql, i, "REPLACE") ??
        matchKeywordAt(sql, i, "IGNORE") ??
        matchKeywordAt(sql, i, "ABORT") ??
        matchKeywordAt(sql, i, "FAIL") ??
        matchKeywordAt(sql, i, "ROLLBACK");
      if (mod == null) return i;
      i = skipWsAndComments(sql, mod);
      continue;
    }
    const single =
      matchKeywordAt(sql, i, "IGNORE") ??
      matchKeywordAt(sql, i, "LOW_PRIORITY") ??
      matchKeywordAt(sql, i, "DELAYED") ??
      matchKeywordAt(sql, i, "HIGH_PRIORITY");
    if (single != null) {
      i = skipWsAndComments(sql, single);
      continue;
    }
    return i;
  }
}

function collectBindingsInStatement(sql: string, baseOffset: number): InsertColumnBinding[] {
  let i = skipWsAndComments(sql, 0);
  const afterInsert = matchKeywordAt(sql, i, "INSERT");
  if (afterInsert == null) return [];
  i = skipInsertModifiers(sql, afterInsert);
  const afterInto = matchKeywordAt(sql, i, "INTO");
  if (afterInto == null) return [];
  i = afterInto;

  const afterTable = readQualifiedIdent(sql, i);
  if (afterTable == null) return [];
  i = skipWsAndComments(sql, afterTable);

  if (sql[i] !== "(") return [];
  const colOpen = i;
  const colClose = findMatchingCloseParen(sql, colOpen);
  if (colClose < 0) return [];
  const columns = parseColumnListSpans(sql, colOpen, colClose, baseOffset);
  if (columns.length === 0) return [];

  i = skipWsAndComments(sql, colClose + 1);
  const bindings: InsertColumnBinding[] = [];

  const pushPair = (valueRanges: PosRange[]) => {
    const n = Math.min(columns.length, valueRanges.length);
    for (let k = 0; k < n; k += 1) {
      const col = columns[k]!;
      const val = valueRanges[k]!;
      bindings.push({
        column: col.column,
        fieldFrom: col.from,
        fieldTo: col.to,
        valueFrom: baseOffset + val.from,
        valueTo: baseOffset + val.to,
      });
    }
  };

  const afterValues = matchKeywordAt(sql, i, "VALUES");
  if (afterValues != null) {
    for (const tuple of collectValueTuples(sql, afterValues)) {
      pushPair(collectValueRanges(sql, tuple.open, tuple.close));
    }
    return bindings;
  }

  const afterSelect = matchKeywordAt(sql, i, "SELECT");
  if (afterSelect != null) {
    pushPair(collectSelectListRanges(sql, afterSelect));
  }

  return bindings;
}

/** 从整份文档收集 INSERT value↔field 绑定 */
export function collectInsertColumnBindings(doc: string): InsertColumnBinding[] {
  const result: InsertColumnBinding[] = [];
  for (const stmt of splitSqlStatements(doc)) {
    result.push(...collectBindingsInStatement(stmt.sql, stmt.from));
  }
  result.sort((a, b) => a.valueFrom - b.valueFrom || a.column.localeCompare(b.column));
  return result;
}

/** 从整份文档收集 INSERT 列名 inlay 锚点 */
export function collectInsertColumnInlays(doc: string): InsertColumnInlay[] {
  return collectInsertColumnBindings(doc).map((b) => ({
    from: b.valueFrom,
    column: b.column,
  }));
}

/** 光标/鼠标落在某个 value 上时，返回对应绑定 */
export function findInsertBindingAtValue(
  bindings: InsertColumnBinding[],
  pos: number,
): InsertColumnBinding | null {
  for (const b of bindings) {
    if (pos >= b.valueFrom && pos < b.valueTo) return b;
  }
  return null;
}

class InsertColumnTagWidget extends WidgetType {
  constructor(readonly column: string) {
    super();
  }

  eq(other: InsertColumnTagWidget): boolean {
    return other.column === this.column;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-sql-insert-column-inlay";
    el.textContent = this.column;
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildInsertColumnDecorations(doc: string): DecorationType {
  const inlays = collectInsertColumnInlays(doc);
  if (inlays.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<ReturnType<typeof Decoration.widget>>();
  for (const inlay of inlays) {
    builder.add(
      inlay.from,
      inlay.from,
      Decoration.widget({
        widget: new InsertColumnTagWidget(inlay.column),
        side: -1,
      }),
    );
  }
  return builder.finish();
}

const fieldHighlightMark = Decoration.mark({ class: "cm-sql-insert-field-highlight" });
const valueHighlightMark = Decoration.mark({ class: "cm-sql-insert-value-highlight" });

const setInsertHoverHighlight = StateEffect.define<DecorationSet>();

const insertHoverHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setInsertHoverHighlight)) {
        return effect.value;
      }
    }
    if (tr.docChanged) {
      return Decoration.none;
    }
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildHoverHighlightDecorations(binding: InsertColumnBinding | null): DecorationType {
  if (!binding) return Decoration.none;
  const ranges = [
    fieldHighlightMark.range(binding.fieldFrom, binding.fieldTo),
    valueHighlightMark.range(binding.valueFrom, binding.valueTo),
  ].sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges);
}

const insertColumnInlayTheme = EditorView.baseTheme({
  ".cm-sql-insert-column-inlay": {
    display: "inline-block",
    fontSize: "0.78em",
    lineHeight: "1.2",
    padding: "0 4px",
    marginRight: "4px",
    borderRadius: "3px",
    verticalAlign: "middle",
    pointerEvents: "none",
    userSelect: "none",
    color: "var(--fg-2, #9aa0a6)",
    backgroundColor: "color-mix(in srgb, var(--fg, #fff) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--fg, #fff) 16%, transparent)",
  },
  ".cm-sql-insert-field-highlight": {
    backgroundColor: "color-mix(in srgb, var(--accent, #3b82f6) 28%, transparent)",
    borderRadius: "2px",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
  ".cm-sql-insert-value-highlight": {
    backgroundColor: "color-mix(in srgb, var(--accent, #3b82f6) 16%, transparent)",
    borderRadius: "2px",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
});

/** CodeMirror：在 INSERT VALUES/SELECT 各值前显示对应列名 tag */
export function createInsertColumnInlayPlugin(): ViewPlugin<{ decorations: DecorationType }> {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationType;

      constructor(view: EditorView) {
        this.decorations = buildInsertColumnDecorations(view.state.doc.toString());
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = buildInsertColumnDecorations(update.state.doc.toString());
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/** 鼠标移入 value 时高亮对应 field（及当前 value） */
function createInsertColumnHoverPlugin() {
  const plugin = ViewPlugin.fromClass(
    class {
      bindings: InsertColumnBinding[] = [];
      activeKey: string | null = null;

      constructor(view: EditorView) {
        this.bindings = collectInsertColumnBindings(view.state.doc.toString());
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.bindings = collectInsertColumnBindings(update.state.doc.toString());
          this.activeKey = null;
        }
      }

      setHover(view: EditorView, pos: number | null) {
        const binding = pos == null ? null : findInsertBindingAtValue(this.bindings, pos);
        const key = binding
          ? `${binding.fieldFrom}:${binding.fieldTo}:${binding.valueFrom}:${binding.valueTo}`
          : null;
        if (key === this.activeKey) return;
        this.activeKey = key;
        view.dispatch({
          effects: setInsertHoverHighlight.of(buildHoverHighlightDecorations(binding)),
        });
      }
    },
    {
      eventHandlers: {
        mousemove(event, view) {
          const inst = view.plugin(plugin);
          if (!inst) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          inst.setHover(view, pos);
          return false;
        },
        mouseleave(_event, view) {
          view.plugin(plugin)?.setHover(view, null);
          return false;
        },
      },
    },
  );
  return plugin;
}

export function createInsertColumnInlayExtension(): Extension[] {
  return [
    createInsertColumnInlayPlugin(),
    insertHoverHighlightField,
    createInsertColumnHoverPlugin(),
    insertColumnInlayTheme,
  ];
}
