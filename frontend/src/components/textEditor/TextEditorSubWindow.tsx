import { useRef, useState, type ReactNode } from "react";
import {
  ContentPreviewTextModeToolbar,
  type ContentPreviewTextMode,
} from "../ui/content/ContentPreviewView";
import { SubWindow } from "../ui/window/SubWindow";
import { useI18n } from "../../i18n";
import type { CodeEditorLanguage } from "../ui/content/CodeEditor";
import { TextEditorPanel } from "./TextEditorPanel";
import type { TextEditorHandle, TextEditorIO } from "./types";
import { useTextEditorSubWindowActions } from "./useTextEditorSubWindowActions";

export interface TextEditorSubWindowProps {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  io: TextEditorIO | null;
  language?: CodeEditorLanguage;
  editable?: boolean;
  onClose: () => void;
  onSaved?: () => void;
  headerExtra?: ReactNode;
  className?: string;
  widthRatio?: number;
  heightRatio?: number;
}

export function TextEditorSubWindow({
  open,
  title,
  subtitle,
  io,
  language,
  editable = true,
  onClose,
  onSaved,
  headerExtra,
  className = "file-preview-subwindow text-editor-subwindow",
  widthRatio = 0.82,
  heightRatio = 0.78,
}: TextEditorSubWindowProps) {
  const { t } = useI18n();
  const contentRef = useRef<TextEditorHandle>(null);
  const [textMode, setTextMode] = useState<ContentPreviewTextMode>("code");

  const { dirty, setDirty, saving, saveNotice, handleSave } = useTextEditorSubWindowActions(
    contentRef,
    { open, onSaved },
  );

  const windowTitle =
    typeof title === "string" ? (
      <h2 id="subwindow-title" className="subwindow-title file-preview-subwindow-title">
        <span className="file-preview-subwindow-name">
          {title}
          {dirty ? <span className="file-preview-subwindow-dirty">*</span> : null}
        </span>
        {subtitle ? <span className="file-preview-subwindow-meta">{subtitle}</span> : null}
        {saveNotice ? (
          <span className="file-preview-subwindow-save-notice">{saveNotice}</span>
        ) : null}
      </h2>
    ) : (
      title
    );

  const canSave = dirty && !saving && editable;

  const actions = (
    <div className="file-preview-subwindow-header-actions">
      <ContentPreviewTextModeToolbar
        mode={textMode}
        onModeChange={setTextMode}
        showCodeMode={Boolean(language)}
      />
      {canSave ? (
        <button
          type="button"
          className="file-preview-subwindow-save"
          onClick={() => void handleSave()}
          title={t("files.preview.saveShortcut")}
        >
          {saving ? t("files.preview.saving") : t("files.preview.save")}
        </button>
      ) : null}
      {headerExtra}
    </div>
  );

  return (
    <SubWindow
      open={open}
      title={windowTitle}
      onClose={onClose}
      className={className}
      widthRatio={widthRatio}
      heightRatio={heightRatio}
      headerExtra={open && io ? actions : null}
    >
      {open && io ? (
        <TextEditorPanel
          ref={contentRef}
          io={io}
          language={language}
          editable={editable}
          textMode={textMode}
          onTextModeChange={setTextMode}
          showInlineTextModeToolbar={false}
          onDirtyChange={setDirty}
          contentResetKey={typeof subtitle === "string" ? subtitle : "editor"}
        />
      ) : null}
    </SubWindow>
  );
}
