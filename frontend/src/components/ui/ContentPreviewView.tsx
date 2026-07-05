import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeEditor, type CodeEditorLanguage } from "./CodeEditor";
import { ModuleEmptyState } from "./ModuleEmptyState";
import { VirtualJsonView } from "./VirtualJsonView";
import { useI18n } from "../../i18n";
import {
  isPreviewWebUrl,
  normalizePreviewWebUrl,
  parsePreviewJsonText,
  type ContentPreviewPayload,
  type ContentPreviewStatus,
  type ContentPreviewTextMode,
} from "../../lib/contentPreview";
import { cn } from "../../lib/utils";

export type {
  ContentPreviewPayload,
  ContentPreviewStatus,
  ContentPreviewTextMode,
} from "../../lib/contentPreview";

export interface ContentPreviewTextModeToolbarProps {
  mode: ContentPreviewTextMode;
  onModeChange: (mode: ContentPreviewTextMode) => void;
  showCodeMode?: boolean;
  showJsonMode?: boolean;
  showMarkdownMode?: boolean;
  showWebMode?: boolean;
  className?: string;
}

export function ContentPreviewTextModeToolbar({
  mode,
  onModeChange,
  showCodeMode = false,
  showJsonMode = false,
  showMarkdownMode = true,
  showWebMode = false,
  className,
}: ContentPreviewTextModeToolbarProps) {
  const { t } = useI18n();
  return (
    <div
      className={cn("content-preview-text-toolbar", className)}
      role="group"
      aria-label={t("contentPreview.textMode")}
    >
      <button
        type="button"
        className={cn("content-preview-text-mode-btn", mode === "plain" && "is-active")}
        aria-pressed={mode === "plain"}
        onClick={() => onModeChange("plain")}
      >
        {t("contentPreview.modePlain")}
      </button>
      {showJsonMode ? (
        <button
          type="button"
          className={cn("content-preview-text-mode-btn", mode === "json" && "is-active")}
          aria-pressed={mode === "json"}
          onClick={() => onModeChange("json")}
        >
          {t("contentPreview.modeJson")}
        </button>
      ) : null}
      {showCodeMode ? (
        <button
          type="button"
          className={cn("content-preview-text-mode-btn", mode === "code" && "is-active")}
          aria-pressed={mode === "code"}
          onClick={() => onModeChange("code")}
        >
          {t("contentPreview.modeCode")}
        </button>
      ) : null}
      {showMarkdownMode ? (
        <button
          type="button"
          className={cn("content-preview-text-mode-btn", mode === "markdown" && "is-active")}
          aria-pressed={mode === "markdown"}
          onClick={() => onModeChange("markdown")}
        >
          {t("contentPreview.modeMarkdown")}
        </button>
      ) : null}
      {showWebMode ? (
        <button
          type="button"
          className={cn("content-preview-text-mode-btn", mode === "web" && "is-active")}
          aria-pressed={mode === "web"}
          onClick={() => onModeChange("web")}
        >
          {t("contentPreview.modeWeb")}
        </button>
      ) : null}
    </div>
  );
}

export interface ContentPreviewViewProps {
  status: ContentPreviewStatus;
  content?: ContentPreviewPayload;
  errorMessage?: string;
  emptyMessage?: string;
  emptyHint?: string;
  loadingMessage?: string;
  /** CodeEditor 语言；提供时工具栏显示「代码」模式 */
  codeLanguage?: CodeEditorLanguage;
  textMode?: ContentPreviewTextMode;
  defaultTextMode?: ContentPreviewTextMode;
  onTextModeChange?: (mode: ContentPreviewTextMode) => void;
  showTextModeToolbar?: boolean;
  /** 内容切换时重置文本模式 */
  contentResetKey?: string;
  className?: string;
  /** 允许编辑文本内容（代码/纯文本模式） */
  editable?: boolean;
  onTextChange?: (text: string) => void;
}

function jsonSourceText(value: object): string {
  return JSON.stringify(value, null, 2);
}

function resolveDefaultTextMode(
  codeLanguage: CodeEditorLanguage | undefined,
  preferred: ContentPreviewTextMode | undefined,
  content?: ContentPreviewPayload,
): ContentPreviewTextMode {
  if (preferred) return preferred;
  if (content?.kind === "json") return "json";
  if (content?.kind === "text" && parsePreviewJsonText(content.text)) return "json";
  if (codeLanguage === "json") return "json";
  return codeLanguage ? "code" : "plain";
}

export function ContentPreviewView({
  status,
  content,
  errorMessage,
  emptyMessage,
  emptyHint,
  loadingMessage,
  codeLanguage,
  textMode: controlledTextMode,
  defaultTextMode,
  onTextModeChange,
  showTextModeToolbar = true,
  contentResetKey,
  className,
  editable = false,
  onTextChange,
}: ContentPreviewViewProps) {
  const { t } = useI18n();
  const [internalTextMode, setInternalTextMode] = useState<ContentPreviewTextMode>(() =>
    resolveDefaultTextMode(codeLanguage, defaultTextMode, content),
  );

  const textMode = controlledTextMode ?? internalTextMode;
  const setTextMode = onTextModeChange ?? setInternalTextMode;

  useEffect(() => {
    setInternalTextMode(resolveDefaultTextMode(codeLanguage, defaultTextMode, content));
  }, [contentResetKey, codeLanguage, defaultTextMode, content]);

  const parsedJsonFromText = useMemo(
    () => (content?.kind === "text" ? parsePreviewJsonText(content.text) : null),
    [content],
  );

  const webPreviewUrl =
    content?.kind === "text" && isPreviewWebUrl(content.text)
      ? normalizePreviewWebUrl(content.text)
      : null;

  const showJsonMode = content?.kind === "json" || parsedJsonFromText != null;
  const showCodeMode =
    Boolean(codeLanguage) || content?.kind === "json" || parsedJsonFromText != null;
  const showMarkdownMode = content?.kind !== "json";
  const showToolbar =
    showTextModeToolbar &&
    status === "ready" &&
    (content?.kind === "text" || content?.kind === "json");

  useEffect(() => {
    if (textMode === "web" && !webPreviewUrl) {
      setTextMode("plain");
    }
  }, [textMode, webPreviewUrl, setTextMode]);

  useEffect(() => {
    if (textMode === "json" && content?.kind === "text" && !parsedJsonFromText) {
      setTextMode("plain");
    }
  }, [textMode, content, parsedJsonFromText, setTextMode]);

  useEffect(() => {
    if (textMode === "markdown" && content?.kind === "json") {
      setTextMode("json");
    }
  }, [textMode, content, setTextMode]);

  const bodyClassName = cn(
    "content-preview-view",
    textMode === "web" && webPreviewUrl && "content-preview-view--web",
    className,
  );

  if (status === "loading") {
    return (
      <div className={bodyClassName}>
        <ModuleEmptyState preset="folder" title={loadingMessage ?? t("contentPreview.loading")} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={bodyClassName}>
        <ModuleEmptyState
          preset="folder"
          title={errorMessage ?? t("contentPreview.error")}
          desc={emptyHint}
        />
      </div>
    );
  }

  if (status === "empty" || !content) {
    return (
      <div className={bodyClassName}>
        <ModuleEmptyState
          preset="folder"
          title={emptyMessage ?? t("contentPreview.empty")}
          desc={emptyHint}
        />
      </div>
    );
  }

  const jsonStructuredValue =
    content.kind === "json" && textMode === "json"
      ? content.value
      : content.kind === "text" && textMode === "json" && parsedJsonFromText
        ? parsedJsonFromText
        : null;

  const sourceText =
    content.kind === "json" ? jsonSourceText(content.value) : content.kind === "text" ? content.text : "";

  const editorLanguage: CodeEditorLanguage | undefined =
    content.kind === "json" || textMode === "json" ? "json" : codeLanguage;

  const renderTextBody = () => {
    if (textMode === "web" && webPreviewUrl) {
      return (
        <div className="content-preview-web">
          <iframe
            key={webPreviewUrl}
            className="content-preview-web-frame"
            src={webPreviewUrl}
            title={t("contentPreview.modeWeb")}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        </div>
      );
    }

    if (textMode === "markdown") {
      return (
        <div className="content-preview-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{sourceText}</ReactMarkdown>
        </div>
      );
    }

    if (textMode === "code" && editorLanguage) {
      return (
        <div className="content-preview-code">
          <CodeEditor
            value={sourceText}
            onChange={(next) => onTextChange?.(next)}
            readOnly={!editable}
            language={editorLanguage}
            height="100%"
            className="content-preview-code-editor"
          />
        </div>
      );
    }

    if (editable && textMode === "plain") {
      return (
        <textarea
          className="content-preview-text content-preview-text--editable"
          value={sourceText}
          onChange={(e) => onTextChange?.(e.target.value)}
          spellCheck={false}
        />
      );
    }

    return <pre className="content-preview-text">{sourceText}</pre>;
  };

  return (
    <div className={bodyClassName}>
      {showToolbar ? (
        <div className="content-preview-view-toolbar-slot">
          <ContentPreviewTextModeToolbar
            mode={textMode}
            onModeChange={setTextMode}
            showCodeMode={showCodeMode}
            showJsonMode={showJsonMode}
            showMarkdownMode={showMarkdownMode}
            showWebMode={webPreviewUrl != null}
          />
        </div>
      ) : null}
      {content.kind === "image" ? (
        <div className="content-preview-image-wrap">
          <img
            className="content-preview-image"
            src={content.url}
            alt={content.alt ?? ""}
            decoding="async"
          />
        </div>
      ) : jsonStructuredValue ? (
        <div className="content-preview-json content-preview-json--virtual">
          <VirtualJsonView value={jsonStructuredValue} />
        </div>
      ) : content.kind === "text" && textMode === "json" ? (
        <ModuleEmptyState preset="folder" title={t("contentPreview.empty")} desc={emptyHint} />
      ) : (
        renderTextBody()
      )}
    </div>
  );
}

/** 根据文本内容与可选语言推导工具栏选项（供外部浮层标题栏复用） */
export function useContentPreviewTextModes(
  text: string | undefined,
  codeLanguage?: CodeEditorLanguage,
  contentKind?: ContentPreviewPayload["kind"],
): {
  webPreviewUrl: string | null;
  showCodeMode: boolean;
  showJsonMode: boolean;
  showMarkdownMode: boolean;
  showWebMode: boolean;
} {
  return useMemo(() => {
    const webPreviewUrl =
      text && isPreviewWebUrl(text) ? normalizePreviewWebUrl(text) : null;
    const showJsonMode =
      contentKind === "json" || (text != null && parsePreviewJsonText(text) != null);
    return {
      webPreviewUrl,
      showCodeMode: Boolean(codeLanguage) || showJsonMode,
      showJsonMode,
      showMarkdownMode: contentKind !== "json",
      showWebMode: webPreviewUrl != null,
    };
  }, [text, codeLanguage, contentKind]);
}
