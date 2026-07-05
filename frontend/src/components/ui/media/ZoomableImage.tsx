import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";

export type ImagePreviewOverlayProps = {
  open: boolean;
  src: string;
  alt?: string;
  onClose: () => void;
};

function ImagePreviewOverlay({ open, src, alt, onClose }: ImagePreviewOverlayProps) {
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

export type ZoomableImageProps = {
  src: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
  /** ?????????? 120px */
  maxHeight?: number | string;
  /** ??????????? true */
  zoomable?: boolean;
};

export function ZoomableImage({
  src,
  alt,
  className,
  imgClassName,
  maxHeight = 120,
  zoomable = true,
}: ZoomableImageProps) {
  const { t } = useI18n();
  const [previewOpen, setPreviewOpen] = useState(false);
  const rootClass = ["zoomable-image", zoomable ? "zoomable-image--interactive" : "", className]
    .filter(Boolean)
    .join(" ");

  const img = (
    <img
      className={["zoomable-image__img", imgClassName].filter(Boolean).join(" ")}
      src={src}
      alt={alt ?? t("ui.imagePreview.alt")}
      style={{ maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight }}
      draggable={false}
    />
  );

  return (
    <>
      {zoomable ? (
        <button
          type="button"
          className={rootClass}
          onClick={() => setPreviewOpen(true)}
          title={t("ui.imagePreview.zoomHint")}
        >
          {img}
        </button>
      ) : (
        <span className={rootClass}>{img}</span>
      )}
      <ImagePreviewOverlay
        open={previewOpen}
        src={src}
        alt={alt}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
}
