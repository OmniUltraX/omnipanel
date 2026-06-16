import { useState } from "react";
import { useI18n } from "../../i18n";
import { ImagePreviewOverlay } from "./ImagePreviewOverlay";

export type ZoomableImageProps = {
  src: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
  /** 缩略图最大高度，默认 120px */
  maxHeight?: number | string;
  /** 是否支持点击放大，默认 true */
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
