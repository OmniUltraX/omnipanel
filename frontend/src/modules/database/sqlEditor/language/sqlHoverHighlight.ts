import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { formatStatement } from "./formatter";
import { getSqlSnippetHighlightExtensions } from "../../sqlEditorTheme";

export interface SqlHighlightMount {
  host: HTMLElement;
  destroy: () => void;
}

function formatExpression(source: string, dbType?: string | null): string {
  const trimmed = source.trim();
  if (!trimmed) return "";
  return formatStatement(trimmed, dbType);
}

/** 在容器内挂载只读、格式化且语法高亮的 SQL 片段。 */
export function mountSqlHighlightBlock(source: string, dbType?: string | null): SqlHighlightMount {
  const host = document.createElement("div");
  host.className = "db-sql-hover-expr db-sql-hover-expr--highlighted";

  const state = EditorState.create({
    doc: formatExpression(source, dbType),
    extensions: getSqlSnippetHighlightExtensions(dbType),
  });

  const view = new EditorView({ state, parent: host });

  return {
    host,
    destroy: () => view.destroy(),
  };
}
