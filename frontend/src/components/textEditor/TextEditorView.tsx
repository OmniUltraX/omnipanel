import { ContentPreviewView, type ContentPreviewTextMode } from "../ui/content/ContentPreviewView";
import { useI18n } from "../../i18n";
import type { CodeEditorLanguage } from "../ui/content/CodeEditor";
import type { TextEditorPanelStatus } from "./types";

export interface TextEditorViewProps {
  status: TextEditorPanelStatus;
  text: string;
  onTextChange?: (text: string) => void;
  editable?: boolean;
  language?: CodeEditorLanguage;
  textMode?: ContentPreviewTextMode;
  defaultTextMode?: ContentPreviewTextMode;
  onTextModeChange?: (mode: ContentPreviewTextMode) => void;
  showInlineTextModeToolbar?: boolean;
  contentResetKey?: string;
  errorMessage?: string;
  loadingMessage?: string;
  emptyHint?: string;
  className?: string;
}

/** 通用文本编辑视图（加载 / 错误 / CodeMirror 编辑）。 */
export function TextEditorView({
  status,
  text,
  onTextChange,
  editable = false,
  language,
  textMode,
  defaultTextMode = "code",
  onTextModeChange,
  showInlineTextModeToolbar = true,
  contentResetKey,
  errorMessage,
  loadingMessage,
  emptyHint,
  className,
}: TextEditorViewProps) {
  const { t } = useI18n();

  if (status === "loading") {
    return (
      <ContentPreviewView
        status="loading"
        loadingMessage={loadingMessage ?? t("files.preview.loading")}
        showTextModeToolbar={false}
        className={className}
      />
    );
  }

  if (status === "error") {
    return (
      <ContentPreviewView
        status="error"
        errorMessage={errorMessage ?? t("files.preview.error", { message: "" })}
        emptyHint={emptyHint}
        showTextModeToolbar={false}
        className={className}
      />
    );
  }

  return (
    <ContentPreviewView
      status="ready"
      content={{ kind: "text", text }}
      codeLanguage={language}
      defaultTextMode={defaultTextMode}
      textMode={textMode}
      onTextModeChange={onTextModeChange}
      showTextModeToolbar={showInlineTextModeToolbar}
      contentResetKey={contentResetKey}
      editable={editable}
      onTextChange={onTextChange}
      className={className}
    />
  );
}
