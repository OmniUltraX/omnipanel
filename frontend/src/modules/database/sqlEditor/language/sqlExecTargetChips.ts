import { EditorState, RangeSetBuilder, StateEffect, StateField, type Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  layer,
  type DecorationSet,
  type LayerMarker,
} from "@codemirror/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DbConnectionConfig } from "../../api";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";
import { findSqlSubqueries, smallestSubqueryAt } from "../../sqlIntel/sqlSubquery";
import { statementCodeStart } from "./sqlStatementFrame";
import {
  assignStatementTargets,
  assignSubqueryTargets,
  persistStatementTargets,
  serializeSavedStatementTargets,
  sqlStatementFingerprint,
  statementIndexAt,
  statementVisualEnd,
  type SavedSqlStatementTarget,
  type SqlExecTarget,
} from "../../sqlIntel/sqlStatementTargets";
import { t } from "../../../../i18n";
import { SqlExecTargetPicker, sqlTargetConnections } from "./sqlExecTargetPicker";

type TargetScope = "statement" | "subquery";

interface TargetSlot {
  scope: TargetScope;
  index: number;
}

interface SqlRange {
  from: number;
  to: number;
  sql: string;
}

interface LiveTarget {
  from: number;
  to: number;
  fingerprint: string;
  targets: SqlExecTarget[];
  scope: TargetScope;
}

export interface SqlExecTargetChipOptions {
  getInitial: () => SavedSqlStatementTarget[];
  onChange: (saved: SavedSqlStatementTarget[]) => void;
  getConnections: () => DbConnectionConfig[];
  getDatabases: (connId: string) => string[];
  /** 文件当前的连接和库。库为空时仍返回连接，芯片上用来展示。 */
  getFileTarget: () => SqlExecTarget | null;
}

/** 工具栏改了连接或库之后，让语句末尾的默认芯片重画。 */
export const refreshSqlFileTargetEffect = StateEffect.define<null>();

type TargetPickerRequest = { mode: "edit"; slot: number } | { mode: "add" };

function bindLive(sql: string, saved: readonly SavedSqlStatementTarget[]): LiveTarget[] {
  const parts = splitSqlStatements(sql);
  const assigned = assignStatementTargets(parts, saved);
  const subqueries = findSqlSubqueries(sql);
  const subqueryAssigned = assignSubqueryTargets(subqueries, saved);
  const live: LiveTarget[] = [];
  parts.forEach((part, index) => {
    const targets = assigned[index] ?? [];
    if (targets.length === 0) return;
    live.push({
      from: part.from,
      to: part.to,
      fingerprint: sqlStatementFingerprint(part.sql),
      targets,
      scope: "statement",
    });
  });
  subqueries.forEach((query, index) => {
    const targets = subqueryAssigned[index] ?? [];
    if (targets.length === 0) return;
    live.push({
      from: query.from,
      to: query.to,
      fingerprint: sqlStatementFingerprint(query.sql),
      targets,
      scope: "subquery",
    });
  });
  return live;
}

function rangeAt(text: string, slot: TargetSlot): SqlRange | null {
  if (slot.scope === "subquery") return findSqlSubqueries(text)[slot.index] ?? null;
  const part = splitSqlStatements(text)[slot.index];
  return part ? { from: part.from, to: part.to, sql: part.sql } : null;
}

function activeSlot(text: string, head: number): TargetSlot | null {
  const subquery = smallestSubqueryAt(text, head);
  if (subquery) {
    const index = findSqlSubqueries(text).findIndex(
      (query) => query.from === subquery.from && query.to === subquery.to,
    );
    if (index >= 0) return { scope: "subquery", index };
  }
  const index = statementIndexAt(text, head);
  return index >= 0 ? { scope: "statement", index } : null;
}

function sameSlot(left: TargetSlot, right: TargetSlot): boolean {
  return left.scope === right.scope && left.index === right.index;
}

function targetsCovering(live: readonly LiveTarget[], range: SqlRange, scope: TargetScope): SqlExecTarget[] {
  return (
    live.find((item) => item.scope === scope && item.from < range.to && item.to > range.from)?.targets ?? []
  );
}

function remapLive(items: readonly LiveTarget[], tr: Transaction): LiveTarget[] {
  let replacedAll = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (fromA === 0 && toA === tr.startState.doc.length) replacedAll = true;
  });
  const text = tr.newDoc.toString();
  if (replacedAll) {
    return bindLive(
      text,
      items.map((item) => ({
        fingerprint: item.fingerprint,
        targets: item.targets,
        ...(item.scope === "subquery" ? { scope: "subquery" as const } : {}),
      })),
    );
  }
  const parts = splitSqlStatements(text);
  const subqueries = findSqlSubqueries(text);
  const usedStatement = new Set<number>();
  const usedSubquery = new Set<number>();
  const next: LiveTarget[] = [];
  for (const item of items) {
    const anchor = tr.changes.mapPos(item.from, 1);
    const collapsed =
      tr.changes.mapPos(item.from, -1) === tr.changes.mapPos(item.to, 1) && item.to > item.from;
    if (collapsed) continue;
    const scope: TargetScope = item.scope === "subquery" ? "subquery" : "statement";
    const pool = scope === "subquery" ? subqueries : parts;
    const used = scope === "subquery" ? usedSubquery : usedStatement;
    const index = pool.findIndex(
      (part, partIndex) => !used.has(partIndex) && anchor >= part.from && anchor <= part.to,
    );
    if (index < 0) continue;
    used.add(index);
    const part = pool[index]!;
    next.push({
      from: part.from,
      to: part.to,
      fingerprint: sqlStatementFingerprint(part.sql),
      targets: item.targets,
      scope,
    });
  }
  return next;
}

function savedFromLive(items: readonly LiveTarget[]): SavedSqlStatementTarget[] {
  return items
    .filter((item) => item.targets.length > 0)
    .map((item) => ({
      fingerprint: item.fingerprint,
      targets: item.targets,
      ...(item.scope === "subquery" ? { scope: "subquery" as const } : {}),
    }));
}


const FRAME_PAD = 3;

function layerOrigin(view: EditorView): { x: number; y: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    x: -rect.left + view.scrollDOM.scrollLeft,
    y: -rect.top + view.scrollDOM.scrollTop,
  };
}

function viewportRight(view: EditorView): number {
  return Math.floor(view.scrollDOM.scrollLeft + view.scrollDOM.clientWidth) - 4;
}

interface StatementBand {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function measureStatement(view: EditorView, text: string, from: number, to: number): StatementBand | null {
  const start = statementCodeStart(text, from, to);
  if (start >= to) return null;
  const origin = layerOrigin(view);
  const firstLine = view.state.doc.lineAt(start);
  const lastLine = view.state.doc.lineAt(Math.max(start, to - 1));
  const contentRight = (() => {
    const content = view.contentDOM.getBoundingClientRect();
    const lineElt = view.contentDOM.querySelector(".cm-line");
    const padRight = lineElt ? Number.parseInt(window.getComputedStyle(lineElt).paddingRight, 10) || 0 : 0;
    return content.right - padRight + origin.x;
  })();
  const limit = viewportRight(view);
  let left = Number.POSITIVE_INFINITY;
  let right = 0;
  let top = 0;
  let bottom = 0;
  let seen = false;
  for (let n = firstLine.number; n <= lastLine.number; n += 1) {
    const line = view.state.doc.line(n);
    const sliceFrom = Math.max(line.from, start);
    const sliceTo = Math.min(line.to, to);
    if (sliceFrom >= sliceTo) continue;
    if (!text.slice(sliceFrom, sliceTo).trim()) continue;
    const head = view.coordsAtPos(sliceFrom, 1);
    const tail = view.coordsAtPos(sliceTo, -1);
    if (!head || !tail) continue;
    const wrapped = Math.abs(head.top - tail.top) > view.defaultLineHeight / 2;
    const lineLeft = Math.min(head.left, tail.left) + origin.x;
    const lineRight = wrapped
      ? Math.min(contentRight, limit)
      : Math.max(head.right, tail.right) + origin.x;
    const lineTop = Math.min(head.top, tail.top) + origin.y;
    const lineBottom = (wrapped ? head.bottom : Math.max(head.bottom, tail.bottom)) + origin.y;
    if (!seen) {
      top = lineTop;
      seen = true;
    }
    left = Math.min(left, lineLeft);
    right = Math.max(right, lineRight);
    bottom = lineBottom;
  }
  if (!seen) return null;
  return {
    left: left - FRAME_PAD,
    right: Math.min(right + FRAME_PAD, limit),
    top,
    bottom,
  };
}

const CORNER_CHIP_HEIGHT = 20;

/** 没改过执行库的语句：高亮时贴在框外左上角，不把正文往下顶。 */
function placeHighlightCorner(
  view: EditorView,
  text: string,
  from: number,
  to: number,
): { left: number; top: number } | null {
  const band = measureStatement(view, text, from, to);
  if (!band) return null;
  return {
    left: Math.max(view.scrollDOM.scrollLeft + 4, band.left),
    top: Math.max(0, band.top - FRAME_PAD - CORNER_CHIP_HEIGHT),
  };
}

function chipLabel(target: SqlExecTarget, connections: readonly DbConnectionConfig[]): string {
  const connection = connections.find((item) => item.id === target.connId);
  const name = connection?.name ?? t("database.sqlTarget.missingConnection");
  return `${name} · ${target.database}`;
}

function fileChipLabel(file: SqlExecTarget | null, connections: readonly DbConnectionConfig[]): string {
  if (!file?.connId.trim()) return t("database.sqlTarget.unset");
  const connection = connections.find((item) => item.id === file.connId);
  const name = connection?.name ?? t("database.sqlTarget.missingConnection");
  const database = file.database.trim();
  return database ? `${name} · ${database}` : name;
}

let pickerEl: HTMLElement | null = null;
let pickerRoot: Root | null = null;
let pickerCleanup: (() => void) | null = null;
let pickerEpoch = 0;

function closeTargetPicker() {
  pickerEpoch += 1;
  pickerCleanup?.();
  pickerCleanup = null;
  pickerRoot?.unmount();
  pickerRoot = null;
  pickerEl?.remove();
  pickerEl = null;
}

function pickerContainsEventTarget(target: EventTarget | null, anchor: HTMLElement): boolean {
  if (!(target instanceof Node)) return false;
  if (pickerEl?.contains(target) || anchor.contains(target)) return true;
  return target instanceof Element && Boolean(target.closest(".omni-select-panel, .omni-select"));
}

export function createSqlExecTargetChips(options: SqlExecTargetChipOptions) {
  const setTargetsEffect = StateEffect.define<LiveTarget[]>();
  const targetField = StateField.define<LiveTarget[]>({
    create(state) {
      return bindLive(state.doc.toString(), options.getInitial());
    },
    update(value, tr) {
      let next = value;
      for (const effect of tr.effects) {
        if (effect.is(setTargetsEffect)) next = effect.value;
      }
      return tr.docChanged ? remapLive(next, tr) : next;
    },
  });

  const replaceTargets = (view: EditorView, slot: TargetSlot, targets: SqlExecTarget[]) => {
    const text = view.state.doc.toString();
    const part = rangeAt(text, slot);
    if (!part) return;
    const current = view.state.field(targetField).filter(
      (item) => !(item.scope === slot.scope && item.from < part.to && item.to > part.from),
    );
    const normalized = persistStatementTargets(targets, options.getFileTarget());
    if (normalized.length > 0) {
      current.push({
        from: part.from,
        to: part.to,
        fingerprint: sqlStatementFingerprint(part.sql),
        targets: normalized,
        scope: slot.scope,
      });
      current.sort((a, b) => a.from - b.from);
    }
    view.dispatch({ effects: setTargetsEffect.of(current) });
  };

  const openPicker = (
    view: EditorView,
    slot: TargetSlot,
    anchor: HTMLElement,
    request: TargetPickerRequest,
  ) => {
    if (view.state.readOnly) return;
    closeTargetPicker();
    const text = view.state.doc.toString();
    const part = rangeAt(text, slot);
    if (!part) return;
    const readTargets = () => {
      const live = view.state.field(targetField, false) ?? [];
      return targetsCovering(live, part, slot.scope);
    };
    const connections = sqlTargetConnections(options.getConnections());
    const file = options.getFileTarget();
    const current = readTargets();
    const initial =
      request.mode === "add"
        ? file?.connId
          ? { connId: file.connId, database: "" }
          : null
        : request.slot < 0
          ? file
          : (current[request.slot] ?? null);

    const finish = (next: readonly SqlExecTarget[]) => {
      replaceTargets(view, slot, [...next]);
      queueMicrotask(() => closeTargetPicker());
    };

    const picker = document.createElement("div");
    picker.className = "cm-sql-exec-target-picker";
    document.body.append(picker);
    const root = createRoot(picker);
    root.render(
      createElement(SqlExecTargetPicker, {
        connections,
        getDatabases: (connId: string) => options.getDatabases(connId),
        mode: request.mode,
        initial,
        canRemove: request.mode === "edit" && request.slot >= 0,
        onCommit: (target: SqlExecTarget) => {
          if (request.mode === "add") {
            const base =
              current.length > 0 ? current : file?.connId && file.database.trim() ? [file] : [];
            finish([...base, target]);
            return;
          }
          if (request.slot < 0) {
            finish([target]);
            return;
          }
          finish(current.map((item, itemIndex) => (itemIndex === request.slot ? target : item)));
        },
        onRemove: () => {
          if (request.mode !== "edit" || request.slot < 0) return;
          finish(current.filter((_, itemIndex) => itemIndex !== request.slot));
        },
      }),
    );
    pickerRoot = root;
    pickerEl = picker;

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const box = picker.getBoundingClientRect();
      const width = box.width || 240;
      const height = box.height || 180;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const top =
        rect.bottom + 6 + height > window.innerHeight
          ? Math.max(8, rect.top - height - 6)
          : rect.bottom + 6;
      picker.style.left = `${left}px`;
      picker.style.top = `${top}px`;
    };
    requestAnimationFrame(place);

    const epoch = pickerEpoch;
    const onPointer = (event: Event) => {
      if (pickerContainsEventTarget(event.target, anchor)) return;
      closeTargetPicker();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".omni-select-panel")) return;
      closeTargetPicker();
    };
    // 等这次按下结束再听外部点击，避免刚打开就被同一下关掉。
    // Escape 用冒泡：选择器自己先关掉下拉，不要把整个弹层一起关了。
    window.setTimeout(() => {
      if (epoch !== pickerEpoch || pickerEl !== picker) return;
      document.addEventListener("mousedown", onPointer, true);
      document.addEventListener("keydown", onKey);
      pickerCleanup = () => {
        document.removeEventListener("mousedown", onPointer, true);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
  };

  function fillTargetChips(
    root: HTMLElement,
    view: EditorView,
    slot: TargetSlot,
    labels: readonly string[],
    inherited: boolean,
    showAdd: boolean,
  ) {
    const fileTitle =
      slot.scope === "subquery" ? t("database.sqlTarget.subqueryFileTitle") : t("database.sqlTarget.fileTitle");
    const editTitle =
      slot.scope === "subquery" ? t("database.sqlTarget.subqueryEditTitle") : t("database.sqlTarget.editTitle");
    const bind = (button: HTMLButtonElement, request: TargetPickerRequest) => {
      button.style.pointerEvents = "auto";
      button.addEventListener(
        "mousedown",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPicker(view, slot, button, request);
        },
        true,
      );
    };
    labels.forEach((label, chip) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = inherited ? "cm-sql-exec-target is-file" : "cm-sql-exec-target";
      button.textContent = label;
      button.title = inherited ? fileTitle : editTitle;
      bind(button, { mode: "edit", slot: inherited ? -1 : chip });
      root.append(button);
    });
    if (showAdd) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "cm-sql-exec-target cm-sql-exec-target-add";
      add.textContent = "+";
      add.title = t("database.sqlTarget.add");
      bind(add, { mode: "add" });
      root.append(add);
    }
  }

  class TargetLensWidget extends WidgetType {
    readonly labels: readonly string[];
    readonly active: boolean;
    readonly showAdd: boolean;
    readonly slot: TargetSlot;

    constructor(
      labels: readonly string[],
      active: boolean,
      showAdd: boolean,
      slot: TargetSlot,
    ) {
      super();
      this.labels = labels;
      this.active = active;
      this.showAdd = showAdd;
      this.slot = slot;
    }

    eq(other: WidgetType): boolean {
      return (
        other instanceof TargetLensWidget &&
        sameSlot(other.slot, this.slot) &&
        other.active === this.active &&
        other.showAdd === this.showAdd &&
        other.labels.join("\0") === this.labels.join("\0")
      );
    }

    get estimatedHeight(): number {
      return 22;
    }

    ignoreEvent(): boolean {
      return true;
    }

    toDOM(view: EditorView): HTMLElement {
      const root = document.createElement("div");
      root.className = this.active ? "cm-sql-exec-lens is-active" : "cm-sql-exec-lens";
      fillTargetChips(root, view, this.slot, this.labels, false, this.showAdd);
      scheduleLensAlign(view, root, this.slot);
      return root;
    }

    updateDOM(dom: HTMLElement, view: EditorView): boolean {
      // eq 对不上时编辑器会复用这块 DOM。只返回 true 而不重画，激活态和加号就停在上一次。
      dom.className = this.active ? "cm-sql-exec-lens is-active" : "cm-sql-exec-lens";
      dom.replaceChildren();
      fillTargetChips(dom, view, this.slot, this.labels, false, this.showAdd);
      scheduleLensAlign(view, dom, this.slot);
      return true;
    }
  }

  /**
   * 块级芯片从内容区左缘起画，高亮框则从首个代码字符再向外扩一圈。
   * 左缘要收到同一条线上。测量必须等这次更新结束，更新过程中读布局会抛错。
   */
  function scheduleLensAlign(view: EditorView, root: HTMLElement, slot: TargetSlot) {
    view.requestMeasure({
      read() {
        const text = view.state.doc.toString();
        const part = rangeAt(text, slot);
        if (!part) return 0;
        const start = statementCodeStart(text, part.from, part.to);
        if (start >= part.to) return 0;
        const head = view.coordsAtPos(start, 1);
        if (!head) return 0;
        const content = view.contentDOM;
        const style = window.getComputedStyle(content);
        const origin =
          content.getBoundingClientRect().left +
          (Number.parseInt(style.borderLeftWidth, 10) || 0) +
          (Number.parseInt(style.paddingLeft, 10) || 0);
        return Math.max(0, head.left - FRAME_PAD - origin);
      },
      write(inset) {
        if (!root.isConnected) return;
        root.style.paddingLeft = `${inset}px`;
      },
    });
  }

  function pushLens(
    marks: Array<{ from: number; deco: Decoration }>,
    state: EditorState,
    text: string,
    live: readonly LiveTarget[],
    slot: TargetSlot,
    range: SqlRange,
    cursor: TargetSlot | null,
    readOnly: boolean,
    connections: ReturnType<SqlExecTargetChipOptions["getConnections"]>,
  ) {
    const targets = targetsCovering(live, range, slot.scope);
    if (targets.length === 0) return;
    const start = statementCodeStart(text, range.from, range.to);
    if (start >= range.to) return;
    const lineFrom = state.doc.lineAt(start).from;
    const active = cursor != null && sameSlot(cursor, slot);
    marks.push({
      from: lineFrom,
      deco: Decoration.widget({
        widget: new TargetLensWidget(
          targets.map((target) => chipLabel(target, connections)),
          active,
          active && !readOnly,
          slot,
        ),
        block: true,
        side: -1,
      }),
    });
  }

  function buildTargetLenses(state: EditorState): DecorationSet {
    const text = state.doc.toString();
    const live = state.field(targetField);
    const readOnly = state.readOnly;
    const cursor = activeSlot(text, state.selection.main.head);
    const connections = options.getConnections();
    const marks: Array<{ from: number; deco: Decoration }> = [];
    splitSqlStatements(text).forEach((part, index) => {
      pushLens(marks, state, text, live, { scope: "statement", index }, part, cursor, readOnly, connections);
    });
    marks.sort((a, b) => a.from - b.from);
    const builder = new RangeSetBuilder<Decoration>();
    for (const mark of marks) builder.add(mark.from, mark.from, mark.deco);
    return builder.finish();
  }

  class TargetRowMarker implements LayerMarker {
    readonly left: number;
    readonly top: number;
    readonly slot: TargetSlot;
    readonly labels: readonly string[];
    readonly active: boolean;
    readonly inherited: boolean;
    readonly showAdd: boolean;
    readonly view: EditorView;

    constructor(
      left: number,
      top: number,
      slot: TargetSlot,
      labels: readonly string[],
      active: boolean,
      inherited: boolean,
      showAdd: boolean,
      view: EditorView,
    ) {
      this.left = left;
      this.top = top;
      this.slot = slot;
      this.labels = labels;
      this.active = active;
      this.inherited = inherited;
      this.showAdd = showAdd;
      this.view = view;
    }

    eq(other: LayerMarker): boolean {
      return (
        other instanceof TargetRowMarker &&
        other.left === this.left &&
        other.top === this.top &&
        sameSlot(other.slot, this.slot) &&
        other.active === this.active &&
        other.inherited === this.inherited &&
        other.showAdd === this.showAdd &&
        other.labels.join("\0") === this.labels.join("\0")
      );
    }

    draw(): HTMLElement {
      return this.paint(document.createElement("div"));
    }

    update(dom: HTMLElement): boolean {
      this.paint(dom);
      return true;
    }

    private paint(root: HTMLElement): HTMLElement {
      root.className = this.active ? "cm-sql-exec-targets is-active" : "cm-sql-exec-targets";
      root.style.left = `${this.left}px`;
      root.style.top = `${this.top}px`;
      root.replaceChildren();
      root.style.pointerEvents = "auto";
      fillTargetChips(root, this.view, this.slot, this.labels, this.inherited, this.showAdd);
      return root;
    }
  }

  const markers = (view: EditorView): readonly LayerMarker[] => {
    const text = view.state.doc.toString();
    const slot = activeSlot(text, view.state.selection.main.head);
    if (!slot) return [];
    const range = rangeAt(text, slot);
    if (!range) return [];
    const live = view.state.field(targetField);
    const targets = targetsCovering(live, range, slot.scope);
    // 子查询不占行，高亮时才在框外浮出；有覆盖就显示覆盖，没有就显示文件当前的库。
    if (slot.scope === "statement" && targets.length > 0) return [];
    const readOnly = view.state.readOnly;
    const connections = options.getConnections();
    const end =
      slot.scope === "statement"
        ? statementVisualEnd(
            text,
            range.from,
            range.to,
            slot.index + 1 < splitSqlStatements(text).length
              ? splitSqlStatements(text)[slot.index + 1]!.from
              : text.length,
          )
        : range.to;
    const place = placeHighlightCorner(view, text, range.from, end);
    if (!place) return [];
    const inherited = targets.length === 0;
    return [
      new TargetRowMarker(
        place.left,
        place.top,
        slot,
        inherited
          ? [fileChipLabel(options.getFileTarget(), connections)]
          : targets.map((target) => chipLabel(target, connections)),
        true,
        inherited,
        !readOnly,
        view,
      ),
    ];
  };

  const sync = ViewPlugin.fromClass(
    class {
      private last: string;

      constructor(view: EditorView) {
        const saved = savedFromLive(view.state.field(targetField));
        this.last = serializeSavedStatementTargets(saved) ?? "";
        const initial = serializeSavedStatementTargets(options.getInitial()) ?? "";
        if (this.last !== initial) options.onChange(saved);
      }

      update(update: { docChanged: boolean; transactions: readonly Transaction[]; view: EditorView }) {
        const touched =
          update.docChanged ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setTargetsEffect)));
        if (!touched) return;
        const saved = savedFromLive(update.view.state.field(targetField));
        const json = serializeSavedStatementTargets(saved) ?? "";
        if (json === this.last) return;
        this.last = json;
        options.onChange(saved);
      }

      destroy() {
        closeTargetPicker();
      }
    },
  );

  const lensField = StateField.define<DecorationSet>({
    create(state) {
      return buildTargetLenses(state);
    },
    update(_value, tr) {
      const targetsChanged = tr.effects.some(
        (effect) => effect.is(setTargetsEffect) || effect.is(refreshSqlFileTargetEffect),
      );
      if (!tr.docChanged && !tr.selection && !targetsChanged && !tr.reconfigured) return _value;
      return buildTargetLenses(tr.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  return [
    targetField,
    sync,
    lensField,
    layer({
      above: true,
      class: "cm-sql-exec-target-layer",
      mount(dom) {
        // contain:size 会把这一层的点击吃掉，按钮看起来在、点下去没反应。
        dom.style.contain = "style";
        dom.style.pointerEvents = "none";
        dom.removeAttribute("aria-hidden");
      },
      markers,
      update(update) {
        return (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged ||
          update.transactions.some(
            (tr) =>
              tr.reconfigured ||
              tr.effects.some(
                (effect) => effect.is(setTargetsEffect) || effect.is(refreshSqlFileTargetEffect),
              ),
          )
        );
      },
    }),
    EditorView.baseTheme({
      ".cm-sql-exec-lens": {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        minHeight: "22px",
        padding: "1px 0 3px",
        pointerEvents: "auto",
      },
      ".cm-sql-exec-targets": {
        position: "absolute",
        zIndex: "5",
        display: "flex",
        gap: "4px",
        pointerEvents: "auto",
        whiteSpace: "nowrap",
      },
      ".cm-sql-exec-target": {
        maxWidth: "180px",
        height: "18px",
        padding: "0 6px",
        overflow: "hidden",
        border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
        borderRadius: "4px",
        background: "color-mix(in srgb, var(--surface, #fff) 82%, transparent)",
        color: "color-mix(in srgb, var(--muted-foreground, #888) 70%, var(--foreground, #222))",
        fontSize: "11px",
        lineHeight: "16px",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: "pointer",
      },
      ".cm-sql-exec-target:hover": {
        borderColor: "var(--accent)",
        background: "var(--surface, #fff)",
        color: "var(--accent)",
      },
      ".cm-sql-exec-lens.is-active .cm-sql-exec-target, .cm-sql-exec-targets.is-active .cm-sql-exec-target": {
        borderColor: "var(--accent)",
        background: "var(--surface, #fff)",
        color: "var(--foreground, #222)",
      },
      ".cm-sql-exec-lens.is-active .cm-sql-exec-target.is-file, .cm-sql-exec-targets.is-active .cm-sql-exec-target.is-file": {
        borderColor: "var(--border, #d0d0d0)",
        background: "var(--surface, #fff)",
        color: "var(--fg-2, var(--muted-foreground, #666))",
      },
      ".cm-sql-exec-lens.is-active .cm-sql-exec-target.is-file:hover, .cm-sql-exec-targets.is-active .cm-sql-exec-target.is-file:hover": {
        borderColor: "var(--accent)",
        color: "var(--accent)",
      },
      ".cm-sql-exec-target-add": {
        width: "18px",
        padding: "0",
        textAlign: "center",
      },
    }),
  ];
}
