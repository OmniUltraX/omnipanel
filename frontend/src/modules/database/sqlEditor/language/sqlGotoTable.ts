import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import type { DatabaseSchema } from "../../types";
import { resolveSqlTableAtPos, type SqlTableAtPos } from "./sqlTableAtPos";

export type SqlGotoTableTarget = {
  databaseName: string;
  tableName: string;
};

const gotoMark = Decoration.mark({ class: "cm-sql-goto-table" });
const setGotoTableDeco = StateEffect.define<DecorationSet>();

const gotoTableDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGotoTableDeco)) {
        return effect.value;
      }
    }
    if (tr.docChanged) {
      return deco.map(tr.changes);
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function isGotoModifier(event: MouseEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

function tableAtCoords(
  view: EditorView,
  x: number,
  y: number,
  schemas: DatabaseSchema[],
  dbType?: string,
): SqlTableAtPos | null {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  return resolveSqlTableAtPos(view.state.doc.toString(), pos, schemas, dbType);
}

function decoForTable(hit: SqlTableAtPos | null): DecorationSet {
  if (!hit) return Decoration.none;
  return Decoration.set([gotoMark.range(hit.from, hit.to)]);
}

function hitKey(hit: SqlTableAtPos | null): string | null {
  return hit ? `${hit.from}:${hit.to}` : null;
}

const gotoTableTheme = EditorView.baseTheme({
  ".cm-sql-goto-table": {
    textDecoration: "underline",
    cursor: "pointer",
  },
});

/** Ctrl/Cmd+点击表名（或表别名）打开表数据面板。 */
export function createSqlGotoTableExtension(
  getSchemas: () => DatabaseSchema[],
  getDbType: () => string | undefined,
  getOnOpenTable: () => ((target: SqlGotoTableTarget) => void) | undefined,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      activeKey: string | null = null;
      lastX = 0;
      lastY = 0;
      hasPointer = false;
      view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.onModKey = this.onModKey.bind(this);
        window.addEventListener("keydown", this.onModKey);
        window.addEventListener("keyup", this.onModKey);
      }

      update(update: { view: EditorView }) {
        this.view = update.view;
      }

      destroy() {
        window.removeEventListener("keydown", this.onModKey);
        window.removeEventListener("keyup", this.onModKey);
      }

      onModKey(event: KeyboardEvent) {
        if (event.key !== "Control" && event.key !== "Meta") return;
        if (!this.hasPointer) return;
        const holding = event.type === "keydown";
        this.applyFromPointer(this.view, {
          ctrlKey: holding && event.key === "Control" ? true : holding ? event.ctrlKey : false,
          metaKey: holding && event.key === "Meta" ? true : holding ? event.metaKey : false,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        });
      }

      applyFromPointer(
        view: EditorView,
        mods: Pick<MouseEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
      ) {
        if (!getOnOpenTable() || !isGotoModifier(mods as MouseEvent)) {
          this.setHit(view, null);
          return;
        }
        this.setHit(view, tableAtCoords(view, this.lastX, this.lastY, getSchemas(), getDbType()));
      }

      setHit(view: EditorView, hit: SqlTableAtPos | null) {
        const key = hitKey(hit);
        if (key === this.activeKey) return;
        this.activeKey = key;
        view.dispatch({ effects: setGotoTableDeco.of(decoForTable(hit)) });
      }
    },
    {
      eventHandlers: {
        mousemove(event, view) {
          if (!getOnOpenTable()) return false;
          const inst = view.plugin(plugin);
          if (!inst) return false;
          inst.hasPointer = true;
          inst.lastX = event.clientX;
          inst.lastY = event.clientY;
          inst.applyFromPointer(view, event);
          return false;
        },
        mouseleave(_event, view) {
          const inst = view.plugin(plugin);
          if (!inst) return false;
          inst.hasPointer = false;
          inst.setHit(view, null);
          return false;
        },
        mousedown(event, view) {
          if (event.button !== 0 || !isGotoModifier(event)) return false;
          const onOpen = getOnOpenTable();
          if (!onOpen) return false;
          const hit = tableAtCoords(view, event.clientX, event.clientY, getSchemas(), getDbType());
          if (!hit) return false;
          event.preventDefault();
          onOpen({ databaseName: hit.databaseName, tableName: hit.tableName });
          return true;
        },
      },
    },
  );

  return [gotoTableDecoField, gotoTableTheme, Prec.high(plugin)];
}
