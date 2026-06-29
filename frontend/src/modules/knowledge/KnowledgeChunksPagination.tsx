import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";

interface KnowledgeChunksPaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function KnowledgeChunksPagination({
  page,
  total,
  pageSize,
  onPageChange,
}: KnowledgeChunksPaginationProps) {
  const { t } = useI18n();

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total, pageSize],
  );

  const safePage = Math.min(Math.max(1, page), totalPages);

  if (total <= pageSize) {
    return null;
  }

  return (
    <footer className="knowledge-chunks-pagination">
      <span className="knowledge-chunks-pagination__info">
        {t("knowledge.chunks.pageInfo", {
          page: safePage,
          pages: totalPages,
          total,
        })}
      </span>
      <div className="knowledge-chunks-pagination__controls">
        <Button
          variant="ghost"
          size="sm"
          disabled={safePage <= 1}
          title={t("database.results.paginationFirst")}
          aria-label={t("database.results.paginationFirst")}
          onClick={() => onPageChange(1)}
        >
          «
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={safePage <= 1}
          title={t("database.results.paginationPrev")}
          aria-label={t("database.results.paginationPrev")}
          onClick={() => onPageChange(safePage - 1)}
        >
          ‹
        </Button>
        <span className="knowledge-chunks-pagination__pages">
          {safePage} / {totalPages}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={safePage >= totalPages}
          title={t("database.results.paginationNext")}
          aria-label={t("database.results.paginationNext")}
          onClick={() => onPageChange(safePage + 1)}
        >
          ›
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={safePage >= totalPages}
          title={t("database.results.paginationLast")}
          aria-label={t("database.results.paginationLast")}
          onClick={() => onPageChange(totalPages)}
        >
          »
        </Button>
      </div>
    </footer>
  );
}
