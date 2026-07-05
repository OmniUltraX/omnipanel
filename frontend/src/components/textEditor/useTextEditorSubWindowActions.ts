import { useCallback, useEffect, useState, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { fmtError } from "../../modules/files/utils";
import type { TextEditorHandle } from "./types";

export function useTextEditorSubWindowActions(
  contentRef: RefObject<TextEditorHandle | null>,
  options: {
    open: boolean;
    canSave?: boolean;
    onSaved?: () => void;
  },
) {
  const { t } = useI18n();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const handle = contentRef.current;
    const saveAllowed = options.canSave ?? handle?.canSave();
    if (!saveAllowed || saving) return;
    setSaving(true);
    setSaveNotice(null);
    try {
      if (handle) {
        await handle.save();
      }
      options.onSaved?.();
      setSaveNotice(t("files.preview.saveSuccess"));
    } catch (e) {
      setSaveNotice(t("files.preview.saveFailed", { message: fmtError(e) }));
    } finally {
      setSaving(false);
    }
  }, [contentRef, options, saving, t]);

  useEffect(() => {
    if (!options.open) {
      setDirty(false);
      setSaveNotice(null);
    }
  }, [options.open]);

  useEffect(() => {
    if (!options.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      void handleSave();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handleSave, options.open]);

  useEffect(() => {
    if (!saveNotice) return;
    const timer = window.setTimeout(() => setSaveNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [saveNotice]);

  return {
    dirty,
    setDirty,
    saving,
    saveNotice,
    handleSave,
  };
}
