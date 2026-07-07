import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { Button } from "../../components/ui/primitives/Button";
import { TextInput } from "../../components/ui/form/TextInput";
import { appConfirm } from "../../lib/appConfirm";
import { useI18n } from "../../i18n";
import type { HttpEnvironment } from "../../ipc/bindings";
import { normalizeBaseUrl } from "./httpEnvironment";

interface Props {
  open: boolean;
  onClose: () => void;
  environments: HttpEnvironment[];
  onSave: (env: HttpEnvironment) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function HttpEnvironmentManageDialog({
  open,
  onClose,
  environments,
  onSave,
  onDelete,
}: Props) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setName("");
    setBaseUrl("");
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open, resetForm]);

  const startCreate = () => {
    resetForm();
  };

  const startEdit = (env: HttpEnvironment) => {
    setEditingId(env.id);
    setName(env.name);
    setBaseUrl(env.baseUrl);
    setError(null);
  };

  const validate = (): string | null => {
    if (!name.trim()) {
      return t("protocol.environment.nameRequired");
    }
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) {
      return t("protocol.environment.baseUrlRequired");
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
      return t("protocol.environment.baseUrlInvalid");
    }
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const now = Date.now();
      const existing = editingId ? environments.find((item) => item.id === editingId) : null;
      await onSave({
        id: existing?.id ?? generateId(),
        name: name.trim(),
        baseUrl: normalizeBaseUrl(baseUrl),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      resetForm();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (env: HttpEnvironment) => {
    const ok = await appConfirm(
      t("protocol.environment.deleteConfirm", { name: env.name }),
      t("protocol.environment.deleteTitle"),
    );
    if (!ok) return;
    await onDelete(env.id);
    if (editingId === env.id) {
      resetForm();
    }
  };

  const dialogTitle = useMemo(
    () =>
      editingId
        ? t("protocol.environment.editTitle")
        : t("protocol.environment.manageTitle"),
    [editingId, t],
  );

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={dialogTitle}
      size="md"
      clipboardAssist={false}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: editingId ? t("common.save") : t("protocol.environment.add"),
        disabled: saving,
        onClick: () => void handleSubmit(),
      }}
      actions={[
        {
          label: t("protocol.environment.new"),
          disabled: saving,
          onClick: startCreate,
        },
      ]}
    >
      <div className="http-env-manage">
        <div className="http-env-manage__list">
          {environments.length === 0 ? (
            <div className="http-env-manage__empty">{t("protocol.environment.empty")}</div>
          ) : (
            environments.map((env) => (
              <div
                key={env.id}
                className={`http-env-manage__row${editingId === env.id ? " http-env-manage__row--active" : ""}`}
              >
                <div className="http-env-manage__row-main">
                  <div className="http-env-manage__name">{env.name}</div>
                  <div className="http-env-manage__base">{env.baseUrl}</div>
                </div>
                <div className="http-env-manage__row-actions">
                  <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(env)}>
                    {t("common.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete(env)}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="http-env-manage__form">
          <FormField label={t("protocol.environment.name")} required>
            <TextInput
              value={name}
              onChange={setName}
              placeholder={t("protocol.environment.namePlaceholder")}
            />
          </FormField>
          <FormField label={t("protocol.environment.baseUrl")} required>
            <TextInput
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder={t("protocol.environment.baseUrlPlaceholder")}
            />
          </FormField>
        </div>
      </div>
    </FormDialog>
  );
}
