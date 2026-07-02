import type { Extension } from "@codemirror/state";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap, closeBrackets } from "@codemirror/autocomplete";
import type { DatabaseSchema } from "../../types";
import { resolveSqlDialect } from "../../sqlIntel/sqlDialect";
import { getSearchHighlightExtension } from "../../sqlSearchHighlight";
import { getSqlEditorThemeExtensions, isLightTheme } from "../../sqlEditorTheme";
import {
  createSqlCompletionSource,
  sqlCompletionReopenOnDelete,
  sqlCompletionTriggerAfterClause,
} from "../language/autocomplete";
import { createSqlLinter } from "../language/lint";
import { createSqlHoverTooltip } from "../language/hover";
import { createSqlLintRunGutter } from "../language/runStatementGutter";
import { createFunctionSignaturePlugin } from "../language/signature";
import { resolveSqlToRun } from "../language/selection";

export interface SqlEditorExtensionOptions {
  getSchemas: () => DatabaseSchema[];
  getDbType: () => string | undefined;
  getReadOnly: () => boolean;
  onDocChange: (value: string) => void;
  onCursorSync: (view: EditorView) => void;
  getOnRun?: () => ((sql: string) => void) | undefined;
  getOnSave?: () => (() => void) | undefined;
  themeCompartment: Compartment;
  readOnlyCompartment: Compartment;
  languageCompartment: Compartment;
}

export function createSqlEditorExtensions(options: SqlEditorExtensionOptions): Extension[] {
  const {
    getSchemas,
    getDbType,
    getReadOnly,
    onDocChange,
    onCursorSync,
    getOnRun,
    getOnSave,
    themeCompartment,
    readOnlyCompartment,
    languageCompartment,
  } = options;

  const dialectProfile = resolveSqlDialect(getDbType());

  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    dropCursor(),
    history(),
    ...createSqlLintRunGutter(getOnRun ?? (() => undefined), getReadOnly),
    EditorState.tabSize.of(2),
    indentOnInput(),
    bracketMatching(),
    foldGutter(),
    closeBrackets(),
    languageCompartment.of(
      sql({ dialect: dialectProfile.cmDialect, upperCaseKeywords: true }),
    ),
    EditorView.lineWrapping,
    getSearchHighlightExtension(),
    createFunctionSignaturePlugin(getDbType),
    createSqlLinter(getDbType, getSchemas),
    createSqlHoverTooltip(getSchemas, getDbType),
    autocompletion({
      activateOnTyping: true,
      maxRenderedOptions: 80,
      icons: true,
      optionClass: (completion) =>
        `cm-sql-completion cm-sql-completion--${completion.type ?? "text"}`,
      override: [createSqlCompletionSource(getSchemas, getDbType)],
    }),
    sqlCompletionReopenOnDelete(),
    sqlCompletionTriggerAfterClause(getSchemas, getDbType),
    keymap.of([
      {
        key: "Mod-Enter",
        run: (view) => {
          if (getReadOnly()) return false;
          const onRun = getOnRun?.();
          if (!onRun) return false;
          const text = view.state.doc.toString();
          const { from, to, head } = view.state.selection.main;
          onRun(resolveSqlToRun(text, { from, to, head }));
          return true;
        },
      },
      {
        key: "Mod-s",
        run: () => {
          if (getReadOnly()) return false;
          const onSave = getOnSave?.();
          if (!onSave) return false;
          onSave();
          return true;
        },
      },
      ...completionKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    themeCompartment.of(getSqlEditorThemeExtensions(isLightTheme())),
    readOnlyCompartment.of(EditorState.readOnly.of(getReadOnly())),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange(update.state.doc.toString());
      }
      if (update.selectionSet || (update.focusChanged && !update.view.hasFocus)) {
        onCursorSync(update.view);
      }
    }),
    EditorView.domEventHandlers({
      blur: (_event, view) => {
        onCursorSync(view);
        return false;
      },
    }),
  ];
}
