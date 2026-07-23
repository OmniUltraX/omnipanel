import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

interface KnowledgeHoverPreviewProps {
  x: number;
  y: number;
  title: string;
  preview: string;
  missing?: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function KnowledgeHoverPreview({
  x,
  y,
  title,
  preview,
  missing,
  onOpen,
  onClose,
}: KnowledgeHoverPreviewProps) {
  const { t } = useI18n();
  const left = Math.min(x + 12, window.innerWidth - 320);
  const top = Math.min(y + 12, window.innerHeight - 180);

  return createPortal(
    <div
      className={`knowledge-hover-preview${missing ? " knowledge-hover-preview--missing" : ""}`}
      style={{ left, top }}
      onMouseLeave={onClose}
    >
      <div className="knowledge-hover-preview__title">{title}</div>
      <div className="knowledge-hover-preview__body">
        {missing ? t("knowledge.hover.missing") : preview || t("knowledge.hover.empty")}
      </div>
      <button type="button" className="knowledge-hover-preview__open" onClick={onOpen}>
        {missing ? t("knowledge.hover.create") : t("knowledge.hover.open")}
      </button>
    </div>,
    document.body,
  );
}
