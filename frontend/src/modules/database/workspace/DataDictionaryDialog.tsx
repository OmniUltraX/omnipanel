import { useState, useCallback, useEffect } from "react";
import { FormDialog, FormField } from "../../../components/ui/FormDialog";
import { TextInput } from "../../../components/ui/TextInput";
import { CodeEditor } from "../../../components/ui/CodeEditor";
import { useI18n } from "../../../i18n";
import type { DataDictionaryEntry } from "../../../stores/dbDataDictionaryStore";

interface DataDictionaryDialogProps {
  open: boolean;
  entry?: DataDictionaryEntry | null;
  onCancel: () => void;
  onSubmit: (name: string, data: string) => void;
}

export function DataDictionaryDialog({ open, entry, onCancel, onSubmit }: DataDictionaryDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [data, setData] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (entry) {
        setName(entry.name);
        setData(entry.data);
      } else {
        setName("");
        setData("");
      }
      setError(null);
    }
  }, [open, entry]);

  const validateJson = (jsonStr: string): boolean => {
    if (!jsonStr.trim()) return true;
    try {
      JSON.parse(jsonStr);
      return true;
    } catch {
      return false;
    }
  };

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("database.dataDictionary.nameRequired"));
      return;
    }
    if (!validateJson(data)) {
      setError(t("database.dataDictionary.invalidJson"));
      return;
    }
    setError(null);
    onSubmit(trimmedName, data);
  }, [name, data, onSubmit, t]);

  const formatJson = useCallback(() => {
    if (!data.trim()) return;
    try {
      const parsed = JSON.parse(data);
      setData(JSON.stringify(parsed, null, 2));
    } catch {
      // invalid JSON, leave as is
    }
  }, [data]);

  return (
    <FormDialog
      open={open}
      onClose={onCancel}
      title={entry ? t("database.dataDictionary.editTitle") : t("database.dataDictionary.createTitle")}
      subtitle={entry ? t("database.dataDictionary.editSubtitle", { name: entry.name }) : undefined}
      size="lg"
      onCancel={onCancel}
      status={error ? { kind: "error" as const, message: error } : null}
      primaryAction={{
        label: entry ? t("database.dataDictionary.save") : t("database.dataDictionary.create"),
        onClick: handleSubmit,
      }}
      actions={[
        {
          label: t("database.dataDictionary.format"),
          onClick: formatJson,
        },
      ]}
      bodyClassName="flex flex-col h-full"
    >
      <FormField
        label={t("database.dataDictionary.nameLabel")}
        htmlFor="data-dict-name"
        description={t("database.dataDictionary.nameDescription")}
        className="flex-shrink-0"
      >
        <TextInput
          id="data-dict-name"
          className="input"
          autoFocus
          placeholder={t("database.dataDictionary.namePlaceholder")}
          value={name}
          onChange={(value) => {
            setName(value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
      </FormField>
      <FormField
        label={t("database.dataDictionary.dataLabel")}
        htmlFor="data-dict-data"
        description={t("database.dataDictionary.dataDescription")}
        className="flex-1 flex flex-col min-h-0"
      >
        <CodeEditor
          value={data}
          onChange={setData}
          language="json"
          height="100%"
        />
      </FormField>
    </FormDialog>
  );
}