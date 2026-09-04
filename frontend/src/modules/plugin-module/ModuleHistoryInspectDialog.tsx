import { CodeEditor, type CodeEditorLanguage } from "../../components/ui/content/CodeEditor";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { useI18n } from "../../i18n";
import { diffTextLines } from "./moduleHostHistory";

export type HistoryInspectMode = "preview" | "compare";

export function ModuleHistoryInspectDialog({
  open,
  mode,
  title,
  subtitle,
  language,
  preview,
  leftLabel,
  rightLabel,
  left,
  right,
  onClose,
}: {
  open: boolean;
  mode: HistoryInspectMode;
  title: string;
  subtitle?: string;
  language: CodeEditorLanguage;
  preview: string;
  leftLabel: string;
  rightLabel: string;
  left: string;
  right: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const lines = mode === "compare" ? diffTextLines(left, right) : [];
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="xl"
      className="module-host-inspect-dialog"
      bodyClassName="module-host-inspect-body"
      cancelLabel={t("common.cancel")}
    >
      {mode === "preview" ? (
        <CodeEditor value={preview} onChange={() => undefined} language={language} readOnly height="100%" />
      ) : (
        <div className="module-host-diff">
          <div className="module-host-diff__legend">
            <span className="module-host-diff__tag module-host-diff__tag--del">{leftLabel}</span>
            <span className="module-host-diff__tag module-host-diff__tag--add">{rightLabel}</span>
          </div>
          <pre className="module-host-diff__lines">
            {lines.map((line, index) => (
              <div key={`${line.kind}:${index}`} className={`module-host-diff__line module-host-diff__line--${line.kind}`}>
                <span className="module-host-diff__mark">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                <span className="module-host-diff__text">{line.text || " "}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </FormDialog>
  );
}
