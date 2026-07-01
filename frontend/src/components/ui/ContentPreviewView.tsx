import { useEffect, useMemo, useState } from "react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { lightTheme } from "@uiw/react-json-view/light";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeEditor, type CodeEditorLanguage } from "./CodeEditor";
import { ModuleEmptyState } from "./ModuleEmptyState";
import { VirtualJsonView } from "./VirtualJsonView";
import { useI18n } from "../../i18n";
import {
  isPreviewWebUrl,
  normalizePreviewWebUrl,
  type ContentPreviewPayload,
  type ContentPreviewStatus,
  type ContentPreviewTextMode,
} from "../../lib/contentPreview";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";

export type {
  ContentPreviewPayload,
  ContentPreviewStatus,
  ContentPreviewTextMode,
} from "../../lib/contentPreview";

export interface ContentPreviewTextModeToolbarProps {
  mode: ContentPreviewTextMode;
  onModeChange: (mode: ContentPreviewTextMode) => void;
  showCodeMode?: boolean;
  showWebMode?: boolean;
  className?: string;
}

export function ContentPreviewTextModeToolbar({
  mode,
  onModeChange,
  showCodeMode = false,
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
      <button
        type="button"
        className={cn("content-preview-text-mode-btn", mode === "markdown" && "is-active")}
        aria-pressed={mode === "markdown"}
        onClick={() => onModeChange("markdown")}
      >
        {t("contentPreview.modeMarkdown")}
      </button>
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

function resolveDefaultTextMode(
  codeLanguage: CodeEditorLanguage | undefined,
  preferred: ContentPreviewTextMode | undefined,
): ContentPreviewTextMode {
  if (preferred) return preferred;
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
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const [internalTextMode, setInternalTextMode] = useState<ContentPreviewTextMode>(() =>
    resolveDefaultTextMode(codeLanguage, defaultTextMode),
  );

  const textMode = controlledTextMode ?? internalTextMode;
  const setTextMode = onTextModeChange ?? setInternalTextMode;

  useEffect(() => {
    setInternalTextMode(resolveDefaultTextMode(codeLanguage, defaultTextMode));
  }, [contentResetKey, codeLanguage, defaultTextMode]);

  const webPreviewUrl =
    content?.kind === "text" && isPreviewWebUrl(content.text)
      ? normalizePreviewWebUrl(content.text)
      : null;

  useEffect(() => {
    if (textMode === "web" && !webPreviewUrl) {
      setTextMode("plain");
    }
  }, [textMode, webPreviewUrl, setTextMode]);

  const jsonTheme = resolvedTheme === "dark" ? darkTheme : lightTheme;
  const showToolbar = showTextModeToolbar && status === "ready" && content?.kind === "text";

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

  return (
    <div className={bodyClassName}>
      {showToolbar ? (
        <div className="content-preview-view-toolbar-slot">
          <ContentPreviewTextModeToolbar
            mode={textMode}
            onModeChange={setTextMode}
            showCodeMode={Boolean(codeLanguage)}
            showWebMode={webPreviewUrl != null}
          />
        </div>
      ) : null}
      {content.kind === "json" ? (
        <div
          className={cn(
            "content-preview-json",
            content.virtual && "content-preview-json--virtual",
          )}
        >
          {content.virtual ? (
            <VirtualJsonView value={content.value} />
          ) : (
            <JsonView
              value={content.value}
              style={{
                ...jsonTheme,
                backgroundColor: "transparent",
                fontSize: 12,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
              }}
              displayObjectSize={false}
              displayDataTypes={false}
              shortenTextAfterLength={0}
            />
          )}
        </div>
      ) : content.kind === "image" ? (
        <div className="content-preview-image-wrap">
          <img
            className="content-preview-image"
            src={content.url}
            alt={content.alt ?? ""}
            decoding="async"
          />
        </div>
      ) : textMode === "web" && webPreviewUrl ? (
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
      ) : textMode === "markdown" ? (
        <div className="content-preview-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.text}</ReactMarkdown>
        </div>
      ) : textMode === "code" && codeLanguage ? (
        <div className="content-preview-code">
          <CodeEditor
            value={content.text}
            onChange={(next) => onTextChange?.(next)}
            readOnly={!editable}
            language={codeLanguage}
            height="100%"
            className="content-preview-code-editor"
          />
        </div>
      ) : editable && textMode === "plain" ? (
        <textarea
          className="content-preview-text content-preview-text--editable"
          value={content.text}
          onChange={(e) => onTextChange?.(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <pre className="content-preview-text">{content.text}</pre>
      )}
    </div>
  );
}

/** 根据文本内容与可选语言推导工具栏选项（供外部浮层标题栏复用） */
export function useContentPreviewTextModes(
  text: string | undefined,
  codeLanguage?: CodeEditorLanguage,
): { webPreviewUrl: string | null; showCodeMode: boolean; showWebMode: boolean } {
  return useMemo(() => {
    const webPreviewUrl =
      text && isPreviewWebUrl(text) ? normalizePreviewWebUrl(text) : null;
    return {
      webPreviewUrl,
      showCodeMode: Boolean(codeLanguage),
      showWebMode: webPreviewUrl != null,
    };
  }, [text, codeLanguage]);
}
