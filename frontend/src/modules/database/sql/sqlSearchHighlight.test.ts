import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  findNextSearchMatch,
  findPrevSearchMatch,
  getSearchHighlightExtension,
  getSearchMatchInfo,
  replaceAllSearchMatches,
  replaceCurrentSearchMatch,
  updateSearchHighlight,
} from "./sqlSearchHighlight";

function createView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [getSearchHighlightExtension()],
    }),
  });
}

describe("sqlSearchHighlight", () => {
  it("高亮并支持下一个/上一个", () => {
    const view = createView("select a from t; select b from t;");
    const info = updateSearchHighlight(view, "select");
    expect(info).toEqual({ current: 1, total: 2 });

    expect(findNextSearchMatch(view)).toEqual({ current: 2, total: 2 });
    expect(findNextSearchMatch(view)).toEqual({ current: 1, total: 2 });
    expect(findPrevSearchMatch(view)).toEqual({ current: 2, total: 2 });
    view.destroy();
  });

  it("替换当前与全部", () => {
    const view = createView("foo bar foo");
    updateSearchHighlight(view, "foo");
    replaceCurrentSearchMatch(view, "baz");
    expect(view.state.doc.toString()).toBe("baz bar foo");
    expect(getSearchMatchInfo(view).total).toBe(1);

    updateSearchHighlight(view, "foo");
    expect(replaceAllSearchMatches(view, "qux")).toBe(1);
    expect(view.state.doc.toString()).toBe("baz bar qux");
    view.destroy();
  });
});
