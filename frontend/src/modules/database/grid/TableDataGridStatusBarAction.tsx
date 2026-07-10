import { useI18n } from "../../../i18n";
import type { DelimitedTextFormat } from "../shared/delimitedText";

export interface TableDataGridStatusBarActionProps {
  format: DelimitedTextFormat;
  onFormatChange: (format: DelimitedTextFormat) => void;
}

const FORMAT_OPTIONS: DelimitedTextFormat[] = ["csv", "tsv"];

export function TableDataGridStatusBarAction({
  format,
  onFormatChange,
}: TableDataGridStatusBarActionProps) {
  const { t } = useI18n();
  const groupLabel = t("database.grid.clipboardFormat");

  return (
    <div className="statusbar-action-bar__control">
      <span className="statusbar-action-bar__label">{groupLabel}</span>
      <div className="statusbar-action-bar__segment" role="group" aria-label={groupLabel}>
        {FORMAT_OPTIONS.map((option) => {
          const active = format === option;
          const label =
            option === "csv"
              ? t("database.grid.clipboardFormatCsv")
              : t("database.grid.clipboardFormatTsv");
          return (
            <button
              key={option}
              type="button"
              className={`statusbar-action-bar__segment-btn${active ? " is-active" : ""}`}
              aria-pressed={active}
              title={label}
              onClick={() => onFormatChange(option)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
