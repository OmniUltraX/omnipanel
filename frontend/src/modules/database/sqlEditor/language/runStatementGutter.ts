import {
  StateField,
  RangeSet,
  RangeSetBuilder,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  gutter,
  GutterMarker,
  type EditorView as EditorViewType,
} from "@codemirror/view";
import {
  forEachDiagnostic,
  setDiagnosticsEffect,
  type Diagnostic,
} from "@codemirror/lint";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";

const RUN_BUTTON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

function severityWeight(sev: Diagnostic["severity"]): number {
  if (sev === "error") return 4;
  if (sev === "warning") return 3;
  if (sev === "info") return 2;
  return 1;
}

function maxSeverity(diagnostics: Diagnostic[]): Diagnostic["severity"] {
  let sev: Diagnostic["severity"] = "hint";
  let weight = 1;
  for (const d of diagnostics) {
    const w = severityWeight(d.severity);
    if (w > weight) {
      weight = w;
      sev = d.severity;
    }
  }
  return sev;
}

class RunButtonMarker extends GutterMarker {
  private readonly sql: string;
  private readonly getOnRun: () => ((sql: string) => void) | undefined;
  private readonly getReadOnly: () => boolean;

  constructor(
    sql: string,
    getOnRun: () => ((sql: string) => void) | undefined,
    getReadOnly: () => boolean,
  ) {
    super();
    this.sql = sql;
    this.getOnRun = getOnRun;
    this.getReadOnly = getReadOnly;
  }

  eq(other: RunButtonMarker): boolean {
    return other instanceof RunButtonMarker && other.sql === this.sql;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-sql-run-button";
    btn.title = "运行此语句";
    btn.setAttribute("aria-label", "运行此语句");
    btn.innerHTML = RUN_BUTTON_SVG;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.getReadOnly()) return;
      const onRun = this.getOnRun();
      if (onRun) {
        onRun(this.sql);
      }
    });
    return btn;
  }
}

class SqlLintGutterMarker extends GutterMarker {
  readonly severity: Diagnostic["severity"];

  diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super();
    this.diagnostics = diagnostics;
    this.severity = maxSeverity(diagnostics);
  }

  eq(other: SqlLintGutterMarker): boolean {
    return (
      other instanceof SqlLintGutterMarker &&
      other.diagnostics.length === this.diagnostics.length &&
      other.diagnostics.every((d, i) => d.message === this.diagnostics[i]?.message && d.from === this.diagnostics[i]?.from)
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-lint-marker cm-lint-marker-${this.severity}`;
    return el;
  }
}

class SqlLintRunGutterMarker extends GutterMarker {
  private readonly run: RunButtonMarker | null;
  private readonly lint: SqlLintGutterMarker | null;

  constructor(
    run: RunButtonMarker | null,
    lint: SqlLintGutterMarker | null,
  ) {
    super();
    this.run = run;
    this.lint = lint;
  }

  eq(other: SqlLintRunGutterMarker): boolean {
    if (!(other instanceof SqlLintRunGutterMarker)) {
      return false;
    }
    const runEq =
      this.run === other.run ||
      (this.run !== null && other.run !== null && this.run.eq(other.run));
    const lintEq =
      this.lint === other.lint ||
      (this.lint !== null && other.lint !== null && this.lint.eq(other.lint));
    return runEq && lintEq;
  }

  toDOM(_view: EditorViewType): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-sql-lint-run-cell";
    if (this.run) {
      wrap.appendChild(this.run.toDOM());
    }
    if (this.lint) {
      wrap.appendChild(this.lint.toDOM());
    }
    return wrap;
  }
}

class SqlLintRunGutterSpacer extends GutterMarker {
  eq(other: SqlLintRunGutterSpacer): boolean {
    return other instanceof SqlLintRunGutterSpacer;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-sql-run-gutter-spacer";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = RUN_BUTTON_SVG;
    return span;
  }
}

function buildSqlLintRunGutterMarkers(
  state: EditorState,
  getOnRun: () => ((sql: string) => void) | undefined,
  getReadOnly: () => boolean,
): RangeSet<GutterMarker> {
  const byLine = new Map<number, { sql?: string; diagnostics: Diagnostic[] }>();

  const readOnly = getReadOnly();
  const onRun = getOnRun();
  if (!readOnly && onRun) {
    const seenLineFrom = new Set<number>();
    for (const stmt of splitSqlStatements(state.doc.toString())) {
      const line = state.doc.lineAt(stmt.from);
      if (seenLineFrom.has(line.from)) {
        continue;
      }
      seenLineFrom.add(line.from);
      const entry = byLine.get(line.from) ?? { diagnostics: [] };
      entry.sql = stmt.sql;
      byLine.set(line.from, entry);
    }
  }

  forEachDiagnostic(state, (diagnostic, from) => {
    const line = state.doc.lineAt(from);
    const entry = byLine.get(line.from) ?? { diagnostics: [] };
    entry.diagnostics.push(diagnostic);
    byLine.set(line.from, entry);
  });

  const builder = new RangeSetBuilder<GutterMarker>();
  // RangeSetBuilder 要求按 from 升序添加；Map 是插入序，diagnostic 可能打乱行号顺序
  const lineFroms = [...byLine.keys()].sort((a, b) => a - b);
  for (const lineFrom of lineFroms) {
    const entry = byLine.get(lineFrom);
    if (!entry) {
      continue;
    }
    const run =
      entry.sql !== undefined
        ? new RunButtonMarker(entry.sql, getOnRun, getReadOnly)
        : null;
    const lint =
      entry.diagnostics.length > 0 ? new SqlLintGutterMarker(entry.diagnostics) : null;
    if (!run && !lint) {
      continue;
    }
    builder.add(lineFrom, lineFrom, new SqlLintRunGutterMarker(run, lint));
  }

  return builder.finish();
}

function createSqlLintRunGutterMarkersField(
  getOnRun: () => ((sql: string) => void) | undefined,
  getReadOnly: () => boolean,
) {
  return StateField.define<RangeSet<GutterMarker>>({
    create(state) {
      return buildSqlLintRunGutterMarkers(state, getOnRun, getReadOnly);
    },
    update(markers, tr) {
      markers = markers.map(tr.changes);
      if (
        tr.docChanged ||
        tr.effects.some((effect) => effect.is(setDiagnosticsEffect)) ||
        tr.effects.length > 0
      ) {
        return buildSqlLintRunGutterMarkers(tr.state, getOnRun, getReadOnly);
      }
      return markers;
    },
  });
}

const sqlLintMarkerTheme = EditorView.baseTheme({
  ".cm-lint-marker": {
    width: "1em",
    height: "1em",
    flexShrink: "0",
  },
  ".cm-lint-marker-info": {
    content: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="%23aaf" stroke="%2377e" stroke-width="6" stroke-linejoin="round" d="M5 5L35 5L35 35L5 35Z"/></svg>')`,
  },
  ".cm-lint-marker-warning": {
    content: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="%23fe8" stroke="%23fd7" stroke-width="6" stroke-linejoin="round" d="M20 6L37 35L3 35Z"/></svg>')`,
  },
  ".cm-lint-marker-error": {
    content: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="%23f87" stroke="%23f43" stroke-width="6"/></svg>')`,
  },
});

/**
 * 合并 lint gutter 与 SQL 运行按钮：在 cm-gutter-lint 列显示 lint 标记与 ▶ 按钮。
 * 使用 renderEmptyElements 确保无 lint 的行也有 gutter 单元格可挂载运行按钮。
 */
export function createSqlLintRunGutter(
  getOnRun: () => ((sql: string) => void) | undefined,
  getReadOnly: () => boolean,
): Extension[] {
  const markersField = createSqlLintRunGutterMarkersField(getOnRun, getReadOnly);

  return [
    markersField,
    gutter({
      class: "cm-gutter-lint",
      renderEmptyElements: true,
      markers: (view) => view.state.field(markersField),
      initialSpacer: () => new SqlLintRunGutterSpacer(),
    }),
    sqlLintMarkerTheme,
  ];
}
