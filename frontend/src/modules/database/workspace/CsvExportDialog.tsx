import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { Select } from "../../../components/ui/form/Select";
import { Button } from "../../../components/ui/Button";
import { SubWindow } from "../../../components/ui/SubWindow";
import { useI18n } from "../../../i18n";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { showToast } from "../../../stores/toastStore";
import {
  buildTableExportCsv,
  takeExportPreviewLines,
} from "../shared/tableExportCsv";

export interface CsvExportDialogPayload {
  sourceLabel: string;
  baseName: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

interface CsvExportDialogProps {
  open: boolean;
  payload: CsvExportDialogPayload | null;
  onClose: () => void;
}

const PREVIEW_LINES = 10;

export function CsvExportDialog({ open, payload, onClose }: CsvExportDialogProps) {
  const { t } = useI18n();
  const [extractor, setExtractor] = useState("csv");
  const [transpose, setTranspose] = useState(false);
  const [includeColumnHeaders, setIncludeColumnHeaders] = useState(false);
  const [includeRowHeaders, setIncludeRowHeaders] = useState(false);
  const [outputPath, setOutputPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !payload) return;
    setExtractor("csv");
    setTranspose(false);
    setIncludeColumnHeaders(false);
    setIncludeRowHeaders(false);
    setOutputPath(`${payload.baseName}.csv`);
    setSaving(false);
  }, [open, payload]);

  const csvText = useMemo(() => {
    if (!payload) return "";
    return buildTableExportCsv(payload.columns, payload.rows, {
      transpose,
      includeColumnHeaders,
      includeRowHeaders,
      bom: true,
    });
  }, [includeColumnHeaders, includeRowHeaders, payload, transpose]);

  const previewText = useMemo(
    () => takeExportPreviewLines(csvText, PREVIEW_LINES),
    [csvText],
  );

  const extractorOptions = useMemo(
    () => [{ value: "csv", label: "CSV" }],
    [],
  );

  const handleBrowse = useCallback(async () => {
    if (!payload) return;
    const picked = await saveFileDialog({
      title: t("database.results.exportCsv"),
      defaultPath: outputPath.trim() || `${payload.baseName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (picked) {
      setOutputPath(picked);
    }
  }, [outputPath, payload, t]);

  const resolveOutputPath = useCallback(async (): Promise<string | null> => {
    const trimmed = outputPath.trim();
    // 相对文件名（无路径分隔符）时仍弹出保存对话框确认位置
    const needsPicker = !trimmed || !/[\\/]/.test(trimmed);
    if (!needsPicker) {
      return trimmed;
    }
    if (!payload) return null;
    const picked = await saveFileDialog({
      title: t("database.results.exportCsv"),
      defaultPath: trimmed || `${payload.baseName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (picked) {
      setOutputPath(picked);
    }
    return picked ?? null;
  }, [outputPath, payload, t]);

  const handleExportToFile = useCallback(async () => {
    if (!payload || saving) return;
    setSaving(true);
    try {
      const path = await resolveOutputPath();
      if (!path) return;
      await unwrapCommand(commands.writeTextFile(path, csvText));
      showToast(t("database.results.exportSaved"));
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t("database.results.exportFailed"));
    } finally {
      setSaving(false);
    }
  }, [csvText, onClose, payload, resolveOutputPath, saving, t]);

  const handleCopy = useCallback(async () => {
    if (!csvText) {
      showToast(t("database.results.exportEmpty"));
      return;
    }
    try {
      await navigator.clipboard.writeText(csvText.replace(/^\uFEFF/, ""));
      showToast(t("common.copied"));
    } catch {
      showToast(t("database.results.exportFailed"));
    }
  }, [csvText, t]);

  return (
    <SubWindow
      open={open}
      title={t("database.results.exportDialog.title")}
      onClose={onClose}
      className="db-csv-export-subwindow"
      widthRatio={0.72}
      heightRatio={0.62}
    >
      <div className="db-csv-export-dialog">
        <div className="db-csv-export-dialog__layout">
          <div className="db-csv-export-dialog__config">
            <label className="db-csv-export-dialog__field">
              <span className="db-csv-export-dialog__label">
                {t("database.results.exportDialog.source")}
              </span>
              <TextInput
                value={payload?.sourceLabel ?? ""}
                onChange={() => undefined}
                disabled
                clearable={false}
                copyable
                size="sm"
              />
            </label>

            <label className="db-csv-export-dialog__field">
              <span className="db-csv-export-dialog__label">
                {t("database.results.exportDialog.extractor")}
              </span>
              <Select
                value={extractor}
                onChange={setExtractor}
                options={extractorOptions}
                searchable={false}
                size="sm"
              />
            </label>

            <div className="db-csv-export-dialog__checks">
              <label className="db-csv-export-dialog__check">
                <input
                  type="checkbox"
                  checked={transpose}
                  onChange={(e) => setTranspose(e.target.checked)}
                />
                <span>{t("database.results.exportDialog.transpose")}</span>
              </label>
              <label className="db-csv-export-dialog__check">
                <input
                  type="checkbox"
                  checked={includeColumnHeaders}
                  onChange={(e) => setIncludeColumnHeaders(e.target.checked)}
                />
                <span>{t("database.results.exportDialog.columnHeaders")}</span>
              </label>
              <label className="db-csv-export-dialog__check">
                <input
                  type="checkbox"
                  checked={includeRowHeaders}
                  onChange={(e) => setIncludeRowHeaders(e.target.checked)}
                />
                <span>{t("database.results.exportDialog.rowHeaders")}</span>
              </label>
            </div>

            <div className="db-csv-export-dialog__field">
              <span className="db-csv-export-dialog__label">
                {t("database.results.exportDialog.outputFile")}
              </span>
              <div className="db-csv-export-dialog__path-row">
                <TextInput
                  value={outputPath}
                  onChange={setOutputPath}
                  clearable={false}
                  copyable={false}
                  size="sm"
                  placeholder={payload ? `${payload.baseName}.csv` : ""}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  title={t("database.results.exportDialog.browse")}
                  aria-label={t("database.results.exportDialog.browse")}
                  onClick={() => void handleBrowse()}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                    <path d="M2 4.5h4l1.2 1.5H14v7H2z" strokeLinejoin="round" />
                  </svg>
                </Button>
              </div>
            </div>
          </div>

          <div className="db-csv-export-dialog__preview">
            <div className="db-csv-export-dialog__preview-title">
              {t("database.results.exportDialog.preview", { count: PREVIEW_LINES })}
            </div>
            <pre className="db-csv-export-dialog__preview-body" aria-live="polite">
              {previewText || t("database.results.exportEmpty")}
            </pre>
          </div>
        </div>

        <div className="db-csv-export-dialog__footer">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy()}>
            {t("database.results.exportToClipboard")}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={!payload || saving}
            onClick={() => void handleExportToFile()}
          >
            {saving
              ? t("database.results.exportDialog.exporting")
              : t("database.results.exportDialog.exportToFile")}
          </Button>
        </div>
      </div>
    </SubWindow>
  );
}
