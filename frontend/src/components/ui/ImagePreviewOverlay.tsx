import { useEffect } from "react";
import { useI18n } from "../../i18n";

export type ImagePreviewOverlayProps = {
  open: boolean;
  src: string;
  alt?: string;
  onClose: () => void;
};

export function ImagePreviewOverlay({ open, src, alt, onClose }: ImagePreviewOverlayProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <button
        type="button"
        className="image-preview-overlay__close"
        aria-label={t("ui.imagePreview.close")}
        onClick={onClose}
      >
        ×
      </button>
      <img
        className="image-preview-overlay__img"
        src={src}
        alt={alt ?? ""}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
