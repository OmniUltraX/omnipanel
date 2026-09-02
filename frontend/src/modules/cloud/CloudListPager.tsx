import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { Select } from "../../components/ui/form/Select";
import { CLOUD_DEFAULT_PAGE_SIZE, CLOUD_PAGE_SIZES } from "./cloudPaging";

export function CloudPager({
  page,
  pageSize,
  total,
  totalPages,
  from,
  to,
  disabled,
  always,
  pageSizes = CLOUD_PAGE_SIZES,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
  disabled?: boolean;
  always?: boolean;
  pageSizes?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const { t } = useI18n();
  if (total <= 0) return null;
  if (!always && total <= CLOUD_DEFAULT_PAGE_SIZE && totalPages <= 1) return null;

  return (
    <div className="cloud-pager">
      <span className="cloud-pager__range">
        {t("cloud.pager.range", { from: String(from), to: String(to), total: String(total) })}
      </span>
      <div className="cloud-pager__nav">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(1)}
          title={t("database.results.paginationFirst")}
          aria-label={t("database.results.paginationFirst")}
        >
          «
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
          title={t("database.results.paginationPrev")}
          aria-label={t("database.results.paginationPrev")}
        >
          ‹
        </Button>
        <span className="cloud-pager__page">{t("cloud.pager.page", { page: String(page), pages: String(totalPages) })}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          title={t("database.results.paginationNext")}
          aria-label={t("database.results.paginationNext")}
        >
          ›
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(totalPages)}
          title={t("database.results.paginationLast")}
          aria-label={t("database.results.paginationLast")}
        >
          »
        </Button>
      </div>
      {onPageSizeChange ? (
        <label className="cloud-pager__size">
          <Select
            size="sm"
            searchable={false}
            disabled={disabled}
            value={String(pageSize)}
            aria-label={t("database.results.pageSize")}
            title={t("database.results.pageSize")}
            panelMinWidth={108}
            options={pageSizes.map((size) => ({
              value: String(size),
              label: t("database.results.pageSizeOption", { count: size }),
            }))}
            onChange={(value) => onPageSizeChange(Number(value))}
          />
        </label>
      ) : null}
    </div>
  );
}
