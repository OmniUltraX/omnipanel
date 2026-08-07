import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export type SqlSearchMatchInfo = {
  /** 1-based current match; 0 when none */
  current: number;
  total: number;
};

type SearchMatch = { from: number; to: number };

type SearchHighlightState = {
  query: string;
  currentIndex: number;
  matches: SearchMatch[];
  decorations: DecorationSet;
};

const emptyState: SearchHighlightState = {
  query: "",
  currentIndex: -1,
  matches: [],
  decorations: Decoration.none,
};

const setSearchQueryEffect = StateEffect.define<{
  query: string;
  preferFrom?: number;
}>();
const setSearchIndexEffect = StateEffect.define<number>();

function collectMatches(doc: string, query: string): SearchMatch[] {
  const needle = query.trim();
  if (!needle) return [];

  const matches: SearchMatch[] = [];
  const lowerDoc = doc.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let index = 0;
  while (index < doc.length) {
    const found = lowerDoc.indexOf(lowerNeedle, index);
    if (found < 0) break;
    matches.push({ from: found, to: found + needle.length });
    index = found + Math.max(1, needle.length);
  }
  return matches;
}

function buildDecorations(matches: SearchMatch[], currentIndex: number): DecorationSet {
  if (matches.length === 0) return Decoration.none;
  const ranges = matches.map((match, i) => ({
    from: match.from,
    to: match.to,
    value: Decoration.mark({
      class:
        i === currentIndex
          ? "cm-search-highlight cm-search-highlight-current"
          : "cm-search-highlight",
    }),
  }));
  return Decoration.set(ranges, true);
}

function resolveIndexNear(matches: SearchMatch[], preferFrom: number | undefined): number {
  if (matches.length === 0) return -1;
  if (preferFrom == null || preferFrom < 0) return 0;
  const next = matches.findIndex((m) => m.from >= preferFrom);
  return next >= 0 ? next : 0;
}

function rebuildState(
  doc: string,
  query: string,
  preferFrom: number | undefined,
  prevIndex: number,
): SearchHighlightState {
  const matches = collectMatches(doc, query);
  if (matches.length === 0) {
    return { query, currentIndex: -1, matches, decorations: Decoration.none };
  }
  let currentIndex =
    preferFrom !== undefined
      ? resolveIndexNear(matches, preferFrom)
      : prevIndex >= 0 && prevIndex < matches.length
        ? prevIndex
        : 0;
  if (currentIndex < 0 || currentIndex >= matches.length) currentIndex = 0;
  return {
    query,
    currentIndex,
    matches,
    decorations: buildDecorations(matches, currentIndex),
  };
}

export const searchHighlightField = StateField.define<SearchHighlightState>({
  create() {
    return emptyState;
  },
  update(value, tr) {
    let next = value;
    let queryTouched = false;
    let preferFrom: number | undefined;
    let indexTouched: number | null = null;

    for (const effect of tr.effects) {
      if (effect.is(setSearchQueryEffect)) {
        queryTouched = true;
        preferFrom = effect.value.preferFrom;
        next = { ...next, query: effect.value.query };
      } else if (effect.is(setSearchIndexEffect)) {
        indexTouched = effect.value;
      }
    }

    if (queryTouched || tr.docChanged) {
      const prefer =
        preferFrom ??
        (tr.docChanged ? tr.state.selection.main.head : undefined);
      next = rebuildState(
        tr.newDoc.toString(),
        next.query,
        queryTouched ? prefer : undefined,
        queryTouched ? -1 : next.currentIndex,
      );
    }

    if (indexTouched != null && next.matches.length > 0) {
      const clamped =
        ((indexTouched % next.matches.length) + next.matches.length) % next.matches.length;
      if (clamped !== next.currentIndex) {
        next = {
          ...next,
          currentIndex: clamped,
          decorations: buildDecorations(next.matches, clamped),
        };
      }
    }

    if (!queryTouched && !tr.docChanged && indexTouched == null) {
      return value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

function matchInfoFromState(state: SearchHighlightState): SqlSearchMatchInfo {
  if (state.matches.length === 0 || state.currentIndex < 0) {
    return { current: 0, total: 0 };
  }
  return { current: state.currentIndex + 1, total: state.matches.length };
}

function readSearchState(state: EditorState): SearchHighlightState {
  return state.field(searchHighlightField, false) ?? emptyState;
}

function scrollToCurrent(view: EditorView, search: SearchHighlightState): void {
  if (search.currentIndex < 0) return;
  const match = search.matches[search.currentIndex];
  if (!match) return;
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(match.from, { y: "center" }),
  });
}

/** 更新搜索词并高亮；preferFrom 默认取光标位置。 */
export function updateSearchHighlight(
  view: EditorView,
  query: string,
  options?: { preferFrom?: number; scroll?: boolean },
): SqlSearchMatchInfo {
  const preferFrom = options?.preferFrom ?? view.state.selection.main.head;
  const scroll = options?.scroll !== false;
  view.dispatch({
    effects: setSearchQueryEffect.of({ query, preferFrom }),
  });
  const search = readSearchState(view.state);
  if (scroll && search.matches.length > 0) {
    scrollToCurrent(view, search);
  }
  return matchInfoFromState(search);
}

export function getSearchMatchInfo(view: EditorView): SqlSearchMatchInfo {
  return matchInfoFromState(readSearchState(view.state));
}

export function findNextSearchMatch(view: EditorView): SqlSearchMatchInfo {
  const search = readSearchState(view.state);
  if (search.matches.length === 0) return { current: 0, total: 0 };
  const next =
    search.currentIndex < 0 ? 0 : (search.currentIndex + 1) % search.matches.length;
  view.dispatch({ effects: setSearchIndexEffect.of(next) });
  scrollToCurrent(view, readSearchState(view.state));
  return getSearchMatchInfo(view);
}

export function findPrevSearchMatch(view: EditorView): SqlSearchMatchInfo {
  const search = readSearchState(view.state);
  if (search.matches.length === 0) return { current: 0, total: 0 };
  const prev =
    search.currentIndex < 0
      ? search.matches.length - 1
      : (search.currentIndex - 1 + search.matches.length) % search.matches.length;
  view.dispatch({ effects: setSearchIndexEffect.of(prev) });
  scrollToCurrent(view, readSearchState(view.state));
  return getSearchMatchInfo(view);
}

export function replaceCurrentSearchMatch(
  view: EditorView,
  replacement: string,
): SqlSearchMatchInfo {
  if (view.state.readOnly) return getSearchMatchInfo(view);
  const search = readSearchState(view.state);
  if (search.currentIndex < 0 || search.matches.length === 0) {
    return { current: 0, total: 0 };
  }
  const match = search.matches[search.currentIndex]!;
  const preferFrom = match.from + replacement.length;
  view.dispatch({
    changes: { from: match.from, to: match.to, insert: replacement },
    effects: setSearchQueryEffect.of({ query: search.query, preferFrom }),
  });
  const next = readSearchState(view.state);
  if (next.matches.length > 0) {
    scrollToCurrent(view, next);
  }
  return matchInfoFromState(next);
}

export function replaceAllSearchMatches(view: EditorView, replacement: string): number {
  if (view.state.readOnly) return 0;
  const search = readSearchState(view.state);
  if (search.matches.length === 0) return 0;
  const count = search.matches.length;
  // 从后往前替换，避免偏移
  const changes = [...search.matches]
    .reverse()
    .map((m) => ({ from: m.from, to: m.to, insert: replacement }));
  view.dispatch({
    changes,
    effects: setSearchQueryEffect.of({
      query: search.query,
      preferFrom: 0,
    }),
  });
  return count;
}

export function clearSearchHighlight(view: EditorView): void {
  view.dispatch({
    effects: setSearchQueryEffect.of({ query: "" }),
  });
}

export function getSearchHighlightExtension() {
  return searchHighlightField;
}
