import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FormDialog } from "../ui/FormDialog";
import { useI18n } from "../../i18n";
import { useAcpServicesStore, type AcpService } from "../../stores/acpServicesStore";

interface AddAcpServiceDialogProps {
  open: boolean;
  onClose: () => void;
  /** 传入时为编辑模式 */
  editService?: AcpService | null;
  onSaved?: (serviceId: string) => void;
}

interface FormState {
  name: string;
  executablePath: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  executablePath: "",
  isActive: false,
};

export function AddAcpServiceDialog({
  open,
  onClose,
  editService,
  onSaved,
}: AddAcpServiceDialogProps) {
  const { t } = useI18n();
  const addService = useAcpServicesStore((s) => s.addService);
  const updateService = useAcpServicesStore((s) => s.updateService);

  const isEdit = Boolean(editService);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editService) {
      setForm({
        name: editService.name,
        executablePath: editService.executablePath,
        isActive: editService.isActive,
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
    setError(null);
    setPicking(false);
  }, [open, editService]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const handlePickExecutable = async () => {
    setPicking(true);
    setError(null);
    try {
      const selected = await openFileDialog({
        title: t("settings.acpServices.pickExecutable"),
        multiple: false,
        directory: false,
      });
      if (typeof selected === "string" && selected.length > 0) {
        setForm((prev) => ({ ...prev, executablePath: selected }));
      }
    } catch (e) {
      console.warn("[AddAcpServiceDialog] 文件选择失败:", e);
      setError(
        e instanceof Error
          ? e.message
          : t("settings.acpServices.errors.pickFailed"),
      );
    } finally {
      setPicking(false);
    }
  };

  const submit = () => {
    const name = form.name.trim();
    const executablePath = form.executablePath.trim();

    if (!name) {
      setError(t("settings.acpServices.errors.nameRequired"));
      return;
    }
    if (!executablePath) {
      setError(t("settings.acpServices.errors.pathRequired"));
      return;
    }

    if (isEdit && editService) {
      updateService(editService.id, {
        name,
        executablePath,
        isActive: form.isActive,
      });
      onSaved?.(editService.id);
      onClose();
      return;
    }

    const created = addService({
      name,
      executablePath,
      isActive: form.isActive,
    });
    onSaved?.(created.id);
    onClose();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("settings.acpServices.edit.title") : t("settings.acpServices.add.title")}
      subtitle={isEdit ? t("settings.acpServices.edit.subtitle") : t("settings.acpServices.add.subtitle")}
      titleId="add-acp-service-title"
      size="sm"
      bodyClassName="add-acp-service-body"
      cancelLabel={t("settings.acpServices.add.cancel")}
      cancelVariant="ghost"
      primaryAction={{
        label: isEdit
          ? t("settings.acpServices.edit.confirm")
          : t("settings.acpServices.add.confirm"),
        onClick: submit,
      }}
    >
      <div className="form-field">
        <label htmlFor="add-acp-name">{t("settings.acpServices.fields.name")}</label>
        <input
          id="add-acp-name"
          className="input"
          autoFocus
          value={form.name}
          onChange={(e) => updateField("name", e.target.value)}
          placeholder={t("settings.acpServices.fields.namePlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <div className="form-field">
        <label htmlFor="add-acp-path">{t("settings.acpServices.fields.executablePath")}</label>
        <div style={{ display: "flex", gap: "var(--sp-2)" }}>
          <input
            id="add-acp-path"
            className="input"
            value={form.executablePath}
            onChange={(e) => updateField("executablePath", e.target.value)}
            placeholder={t("settings.acpServices.fields.executablePathPlaceholder")}
            style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handlePickExecutable()}
            disabled={picking}
            title={t("settings.acpServices.pickExecutable")}
            aria-label={t("settings.acpServices.pickExecutable")}
          >
            {t("settings.acpServices.browse")}
          </button>
        </div>
        <div className="form-field-hint">
          {t("settings.acpServices.fields.executablePathHint")}
        </div>
      </div>

      <div className="form-field">
        <label
          className="form-radio-option"
          style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => updateField("isActive", e.target.checked)}
          />
          <span>{t("settings.acpServices.fields.isActive")}</span>
        </label>
        <div className="form-field-hint">
          {t("settings.acpServices.fields.isActiveHint")}
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
    </FormDialog>
  );
}
