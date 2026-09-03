import { useEffect, useRef, useState } from "react";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useI18n } from "../../../i18n";

export type PluginFormField = { key: string; label?: string };

type Props = {
  open: boolean;
  title: string;
  fields: PluginFormField[];
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
};

function emptyDraft(fields: PluginFormField[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of fields) next[field.key] = "";
  return next;
}

/** Host 通用创建表单：按清单 formFields 渲染，不克隆第一方 Dialog。 */
export function PluginFormDialog({ open, title, fields, onClose, onSubmit }: Props) {
  const { t } = useI18n();
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const [draft, setDraft] = useState<Record<string, string>>(() => emptyDraft(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft(fieldsRef.current));
    setError(null);
    setBusy(false);
  }, [open]);

  return (
    <FormDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.save"),
        disabled: busy || fields.length === 0,
        onClick: () => {
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              await onSubmit(draft);
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          })();
        },
      }}
      cancelDisabled={busy}
      status={error ? { kind: "error", message: error } : null}
    >
      {fields.map((field) => (
        <label key={field.key} className="module-host-field">
          <span>{field.label?.trim() || field.key}</span>
          <TextInput
            value={draft[field.key] ?? ""}
            onChange={(value) => setDraft((cur) => ({ ...cur, [field.key]: value }))}
            disabled={busy}
          />
        </label>
      ))}
    </FormDialog>
  );
}
