import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import {
  readLatestClipboard,
  revokeClipboardSnapshot,
  type ClipboardSnapshot,
} from "../../lib/readLatestClipboard";
import { Button } from "./Button";
import { ZoomableImage } from "./ZoomableImage";

export type FormDialogClipboardBarProps = {
  open: boolean;
  onRecognize?: (snapshot: ClipboardSnapshot | null) => void;
};

export function FormDialogClipboardBar({ open, onRecognize }: FormDialogClipboardBarProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRecognizeRef = useRef(onRecognize);
  onRecognizeRef.current = onRecognize;

  const replaceSnapshot = useCallback((next: ClipboardSnapshot | null) => {
    setSnapshot((prev) => {
      if (prev && prev !== next) revokeClipboardSnapshot(prev);
      return next;
    });
  }, []);

  const loadClipboard = useCallback(
    async (opts?: { showEmptyError?: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const data = await readLatestClipboard();
        replaceSnapshot(data);
        onRecognizeRef.current?.(data);
        if (!data && opts?.showEmptyError) {
          setError(t("formDialog.clipboard.emptyClipboard"));
        }
        return data;
      } catch (e) {
        const message = String(e);
        setError(
          message.includes("CLIPBOARD_UNAVAILABLE")
            ? t("formDialog.clipboard.unavailable")
            : t("formDialog.clipboard.readFailed"),
        );
        replaceSnapshot(null);
        onRecognizeRef.current?.(null);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [replaceSnapshot, t],
  );

  useEffect(() => {
    if (!open) {
      replaceSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await readLatestClipboard();
        if (cancelled) {
          revokeClipboardSnapshot(data);
          return;
        }
        replaceSnapshot(data);
        onRecognizeRef.current?.(data);
      } catch (e) {
        if (cancelled) return;
        const message = String(e);
        setError(
          message.includes("CLIPBOARD_UNAVAILABLE")
            ? t("formDialog.clipboard.unavailable")
            : t("formDialog.clipboard.readFailed"),
        );
        replaceSnapshot(null);
        onRecognizeRef.current?.(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, replaceSnapshot, t]);

  useEffect(
    () => () => {
      revokeClipboardSnapshot(snapshot);
    },
    [snapshot],
  );

  const handleRecognize = () => {
    void loadClipboard({ showEmptyError: true });
  };

  return (
    <div className="form-dialog-clipboard-bar">
      <div className="form-dialog-clipboard-bar__preview">
        {error ? (
          <span className="form-dialog-clipboard-bar__error">{error}</span>
        ) : loading && !snapshot ? (
          <span className="form-dialog-clipboard-bar__placeholder">{t("common.loading")}</span>
        ) : snapshot?.kind === "text" ? (
          <span className="form-dialog-clipboard-bar__text" title={snapshot.text}>
            {snapshot.text}
          </span>
        ) : snapshot?.kind === "image" ? (
          <ZoomableImage src={snapshot.src} maxHeight={100} />
        ) : (
          <span className="form-dialog-clipboard-bar__placeholder">
            {t("formDialog.clipboard.placeholder")}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="form-dialog-clipboard-bar__action"
        disabled={loading}
        onClick={handleRecognize}
      >
        {loading ? t("common.loading") : t("formDialog.clipboard.aiRecognize")}
      </Button>
    </div>
  );
}
