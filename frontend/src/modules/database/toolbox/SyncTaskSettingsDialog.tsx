import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FormDialog, FormField } from "../../../components/ui/form/FormDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useI18n } from "../../../i18n";
import { formatIgnoredFieldsForInput, parseIgnoredFieldsInput } from "./ignoredFields";
import type { SchemaTableNameCase, ToolboxTabId } from "./types";

export interface SyncTaskSettings {
  taskName: string;
  schemaCaseSensitive: boolean;
  schemaTableNameCase: SchemaTableNameCase;
  schemaCreateMissingTables: boolean;
  ignoredFieldsText?: string;
}

interface SyncTaskSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  tab: ToolboxTabId;
  taskName: string;
  schemaCaseSensitive: boolean;
  schemaTableNameCase: SchemaTableNameCase;
  schemaCreateMissingTables: boolean;
  ignoredFields?: string[];
  onApply: (settings: SyncTaskSettings) => void;
}

export function SyncTaskSettingsDialog({
  open,
  onClose,
  tab,
  taskName,
  schemaCaseSensitive,
  schemaTableNameCase,
  schemaCreateMissingTables,
  ignoredFields = [],
  onApply,
}: SyncTaskSettingsDialogProps) {
  const { t } = useI18n();
  const [draftName, setDraftName] = useState(taskName);
  const [draftCaseSensitive, setDraftCaseSensitive] = useState(schemaCaseSensitive);
  const [draftTableNameCase, setDraftTableNameCase] = useState(schemaTableNameCase);
  const [draftCreateMissingTables, setDraftCreateMissingTables] = useState(schemaCreateMissingTables);
  const [draftIgnoredFieldsText, setDraftIgnoredFieldsText] = useState(formatIgnoredFieldsForInput(ignoredFields));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraftName(taskName);
    setDraftCaseSensitive(schemaCaseSensitive);
    setDraftTableNameCase(schemaTableNameCase);
    setDraftCreateMissingTables(schemaCreateMissingTables);
    setDraftIgnoredFieldsText(formatIgnoredFieldsForInput(ignoredFields));
    setError(null);
  }, [
    open,
    taskName,
    schemaCaseSensitive,
    schemaTableNameCase,
    schemaCreateMissingTables,
    ignoredFields,
  ]);

  const handleApply = () => {
    const name = draftName.trim();
    if (!name) {
      setError(t("database.syncTasks.nameRequired"));
      return;
    }
    if (tab === "dataSync") {
      const lines = draftIgnoredFieldsText.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (!trimmed.includes(".") || trimmed.startsWith(".") || trimmed.endsWith(".")) {
          setError(t("database.toolbox.settingsIgnoredFieldsInvalid"));
          return;
        }
      }
    }
    onApply({
      taskName: name,
      schemaCaseSensitive: draftCaseSensitive,
      schemaTableNameCase: draftTableNameCase,
      schemaCreateMissingTables: draftCreateMissingTables,
      ignoredFieldsText: tab === "dataSync" ? draftIgnoredFieldsText : undefined,
    });
    onClose();
  };

  if (!open) {
    return null;
  }

  return createPortal(
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.toolbox.settingsTitle")}
      size="sm"
      bodyClassName="db-sync-task-settings-form"
      onCancel={onClose}
      clipboardAssist={false}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: t("common.save"),
        onClick: handleApply,
      }}
    >
      <FormField
        layout="horizontal"
        label={t("database.syncTasks.namePlaceholder")}
        htmlFor="sync-settings-name"
      >
        <TextInput
          id="sync-settings-name"
          className="input"
          autoFocus
          value={draftName}
          placeholder={t("database.syncTasks.namePlaceholder")}
          onChange={(value) => {
            setDraftName(value);
            if (error) setError(null);
          }}
        />
      </FormField>
      {tab === "dataSync" ? (
        <FormField
          layout="horizontal"
          label={t("database.toolbox.settingsIgnoredFields")}
          description={t("database.toolbox.settingsIgnoredFieldsHint")}
          htmlFor="sync-settings-ignored-fields"
        >
          <textarea
            id="sync-settings-ignored-fields"
            className="input db-sync-task-settings-ignored-fields"
            rows={6}
            spellCheck={false}
            placeholder={t("database.toolbox.settingsIgnoredFieldsPlaceholder")}
            value={draftIgnoredFieldsText}
            onChange={(event) => {
              setDraftIgnoredFieldsText(event.target.value);
              if (error) setError(null);
            }}
          />
        </FormField>
      ) : null}
      {tab === "schemaSync" ? (
        <>
          <FormField
            layout="horizontal"
            label={t("database.toolbox.settingsSchemaTableNameCase")}
            description={t("database.toolbox.settingsSchemaTableNameCaseHint")}
          >
            <div className="form-radio-group" role="radiogroup" aria-label={t("database.toolbox.settingsSchemaTableNameCase")}>
              <label className="form-radio-option">
                <input
                  type="radio"
                  name="schema-table-name-case"
                  checked={draftTableNameCase === "upper"}
                  onChange={() => setDraftTableNameCase("upper")}
                />
                <span>{t("database.toolbox.settingsSchemaTableNameCaseUpper")}</span>
              </label>
              <label className="form-radio-option">
                <input
                  type="radio"
                  name="schema-table-name-case"
                  checked={draftTableNameCase === "lower"}
                  onChange={() => setDraftTableNameCase("lower")}
                />
                <span>{t("database.toolbox.settingsSchemaTableNameCaseLower")}</span>
              </label>
            </div>
          </FormField>
          <FormField
            layout="horizontal"
            label={t("database.toolbox.settingsSchemaCreateMissingTables")}
            description={t("database.toolbox.settingsSchemaCreateMissingTablesHint")}
          >
            <label
              className="form-toggle-control"
              onClick={(event) => {
                event.preventDefault();
                setDraftCreateMissingTables((prev) => !prev);
              }}
            >
              <div
                className={`toggle${draftCreateMissingTables ? " on" : ""}`}
                role="switch"
                aria-checked={draftCreateMissingTables}
                aria-label={t("database.toolbox.settingsSchemaCreateMissingTables")}
              />
            </label>
          </FormField>
          <FormField
            layout="horizontal"
            label={t("database.toolbox.settingsSchemaCaseSensitive")}
            description={t("database.toolbox.settingsSchemaCaseSensitiveHint")}
          >
            <label
              className="form-toggle-control"
              onClick={(event) => {
                event.preventDefault();
                setDraftCaseSensitive((prev) => !prev);
              }}
            >
              <div
                className={`toggle${draftCaseSensitive ? " on" : ""}`}
                role="switch"
                aria-checked={draftCaseSensitive}
                aria-label={t("database.toolbox.settingsSchemaCaseSensitive")}
              />
            </label>
          </FormField>
        </>
      ) : null}
    </FormDialog>,
    document.body,
  );
}
