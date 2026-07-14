import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

const setSearchHighlight = StateEffect.define<string>();

let currentHighlightQuery = "";

function buildHighlightDecorations(doc: string, query: string): DecorationSet {
  const needle = query.trim();
  if (!needle) {
    return Decoration.none;
  }

  const ranges: { from: number; to: number; value: Decoration }[] = [];
  const lowerDoc = doc.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let index = 0;
  let isFirst = true;

  while (index < doc.length) {
    const found = lowerDoc.indexOf(lowerNeedle, index);
    if (found < 0) break;
    const mark = Decoration.mark({
      class: isFirst
        ? "cm-search-highlight cm-search-highlight-current"
        : "cm-search-highlight",
    });
    ranges.push({ from: found, to: found + needle.length, value: mark });
    isFirst = false;
    index = found + Math.max(1, needle.length);
  }

  return Decoration.set(ranges, true);
}

export const searchHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let queryChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setSearchHighlight)) {
        currentHighlightQuery = effect.value;
        queryChanged = true;
      }
    }
    if (queryChanged || tr.docChanged) {
      return buildHighlightDecorations(tr.newDoc.toString(), currentHighlightQuery);
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function updateSearchHighlight(view: EditorView, query: string) {
  const prevNeedle = currentHighlightQuery.trim();
  const needle = query.trim();
  view.dispatch({ effects: setSearchHighlight.of(query) });
  if (!needle || needle === prevNeedle) {
    return;
  }
  const found = view.state.doc.toString().toLowerCase().indexOf(needle.toLowerCase());
  if (found < 0) {
    return;
  }
  view.dispatch({
    effects: EditorView.scrollIntoView(found, { y: "center" }),
  });
}

export function getSearchHighlightExtension() {
  return searchHighlightField;
}
