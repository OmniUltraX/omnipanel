import { forwardRef, useEffect, useImperativeHandle } from "react";
import type { TextEditorHandle, TextEditorIO } from "./types";
import { TextEditorView, type TextEditorViewProps } from "./TextEditorView";
import { useTextEditorDocument } from "./useTextEditorDocument";

export type TextEditorPanelProps = Omit<
  TextEditorViewProps,
  "status" | "text" | "onTextChange" | "errorMessage" | "loadingMessage"
> & {
  io: TextEditorIO | null;
  enabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveSuccess?: () => void;
  contentResetKey?: string;
};

/** 带 IO 自加载 / 保存的文本编辑面板。 */
export const TextEditorPanel = forwardRef<TextEditorHandle, TextEditorPanelProps>(
  function TextEditorPanel(
    {
      io,
      enabled = true,
      editable = true,
      onDirtyChange,
      onSaveSuccess,
      contentResetKey,
      ...viewProps
    },
    ref,
  ) {
    const doc = useTextEditorDocument(io, enabled);

    useEffect(() => {
      onDirtyChange?.(doc.dirty);
    }, [doc.dirty, onDirtyChange]);

    useImperativeHandle(
      ref,
      () => ({
        canSave: () => doc.canSave && editable,
        save: async () => {
          await doc.save();
          onSaveSuccess?.();
          onDirtyChange?.(false);
        },
      }),
      [doc, editable, onDirtyChange, onSaveSuccess],
    );

    return (
      <TextEditorView
        {...viewProps}
        status={doc.loading ? "loading" : doc.error ? "error" : "ready"}
        text={doc.text}
        onTextChange={doc.setText}
        editable={editable}
        errorMessage={doc.error ?? undefined}
        contentResetKey={contentResetKey ?? (io ? "io" : "none")}
      />
    );
  },
);
