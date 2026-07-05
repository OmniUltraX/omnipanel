import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FormDialog, FormField } from "../../../components/ui/form/FormDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { Select } from "../../../components/ui/form/Select";
import { useI18n } from "../../../i18n";
import type { SyncTask, SyncTaskConfig, ToolboxTabId } from "../toolbox/types";

const EMPTY_SYNC_TASK_CONFIG: SyncTaskConfig = {
  sourceConnId: "",
  sourceDb: "",
  targetConnId: "",
  targetDb: "",
  selectedTables: [],
};

interface CreateSyncTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (task: SyncTask) => void;
  createTask: (input: { name: string; kind: ToolboxTabId; config: SyncTaskConfig }) => SyncTask;
}

export function CreateSyncTaskDialog({
  open,
  onClose,
  onCreated,
  createTask,
}: CreateSyncTaskDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ToolboxTabId>("dataSync");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(t("database.syncTasks.defaultName"));
    setKind("dataSync");
    setError(null);
  }, [open, t]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("database.syncTasks.nameRequired"));
      return;
    }
    const task = createTask({
      name: trimmed,
      kind,
      config: EMPTY_SYNC_TASK_CONFIG,
    });
    onCreated(task);
    onClose();
  };

  if (!open) {
    return null;
  }

  return createPortal(
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.syncTasks.createTitle")}
      size="sm"
      onCancel={onClose}
      clipboardAssist={false}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: t("database.syncTasks.create"),
        onClick: handleSubmit,
      }}
    >
      <FormField label={t("database.syncTasks.namePlaceholder")} htmlFor="sync-task-name">
        <TextInput
          id="sync-task-name"
          className="input"
          autoFocus
          value={name}
          placeholder={t("database.syncTasks.namePlaceholder")}
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
      <FormField label={t("database.syncTasks.kindLabel")}>
        <Select
          className="db-select"
          value={kind}
          onChange={(value) => setKind(value as ToolboxTabId)}
          searchable={false}
          options={[
            { value: "dataSync", label: t("database.tabs.dataSync") },
            { value: "schemaSync", label: t("database.tabs.schemaSync") },
          ]}
        />
      </FormField>
    </FormDialog>,
    document.body,
  );
}
