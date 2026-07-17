import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { PasswordInput } from "../../../components/ui/form/PasswordInput";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useConnectionStore } from "../../../stores/connectionStore";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { Connection } from "../../../ipc/bindings";
import {
  buildPanelOnlyConnection,
  EMPTY_PANEL_FORM,
  panelConnectionToForm,
  type PanelFormData,
} from "./panelForm";

interface ServerConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editPanelConnection?: Connection;
}

export function ServerConnectionDialog({
  open,
  onClose,
  onSaved,
  editPanelConnection,
}: ServerConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const [form, setForm] = useState<PanelFormData>(EMPTY_PANEL_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [testingPanel, setTestingPanel] = useState(false);

  const isEdit = !!editPanelConnection?.id;

  useEffect(() => {
    if (!open) return;

    setForm(editPanelConnection ? panelConnectionToForm(editPanelConnection) : EMPTY_PANEL_FORM);
    setError(null);
    setPanelStatus(null);
    setSaving(false);
    setTestingPanel(false);
  }, [open, editPanelConnection]);

  const update = <K extends keyof PanelFormData>(key: K, value: PanelFormData[K]) => {
    setError(null);
    setPanelStatus(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("server.create.nameRequired");
    if (!form.panelAddress.trim()) return t("server.create.addressRequired");
    if (!form.panelKey.trim()) return t("server.create.keyRequired");
    return null;
  };

  const handleTestPanel = async () => {
    if (!form.panelAddress.trim() || !form.panelKey.trim()) {
      setPanelStatus({
        kind: "error",
        message: !form.panelAddress.trim()
          ? t("server.create.addressRequired")
          : t("server.create.keyRequired"),
      });
      return;
    }
    setTestingPanel(true);
    setPanelStatus({ kind: "info", message: t("server.create.testing") });
    try {
      if (form.serviceType === "1panel") {
        const client = createOnePanelClient(form.panelAddress.trim(), form.panelKey.trim());
        const info = await client.getDeviceBase();
        const hostname = info.hostname ?? form.panelAddress.trim();
        setPanelStatus({
          kind: "success",
          message: t("server.create.testSuccess", { hostname }),
        });
      } else {
        const client = createBtPanelClient(form.panelAddress.trim(), form.panelKey.trim());
        const info = await client.getSystemTotal();
        const hostname = info.system ?? info.version ?? form.panelAddress.trim();
        setPanelStatus({
          kind: "success",
          message: t("server.create.testSuccess", { hostname }),
        });
      }
    } catch (err) {
      setPanelStatus({
        kind: "error",
        message: t("server.create.testFailed", { error: String(err) }),
      });
    } finally {
      setTestingPanel(false);
    }
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const draft = buildPanelOnlyConnection(form, editPanelConnection);
      const saved = await saveConn(draft);
      if (!saved?.id) throw new Error("Panel save failed");

      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const footerStatus = error ? { kind: "error" as const, message: error } : panelStatus;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? t("server.edit.title") : t("server.create.title")}
      size="md"
      onCancel={onClose}
      cancelDisabled={saving || testingPanel}
      status={footerStatus}
      actions={[
        {
          label: testingPanel ? t("server.create.testing") : t("server.create.test"),
          variant: "ghost",
          disabled: saving || testingPanel || !form.panelAddress.trim() || !form.panelKey.trim(),
          onClick: () => void handleTestPanel(),
        },
      ]}
      primaryAction={{
        label: saving ? t("ssh.dialog.saving") : isEdit ? t("common.save") : t("ssh.dialog.save"),
        disabled: saving || testingPanel,
        onClick: () => void handleSave(),
      }}
    >
      <div className="form-field">
        <label className="form-label">{t("server.create.name")}</label>
        <TextInput
          placeholder={t("server.create.namePlaceholder")}
          value={form.name}
          onChange={(value) => update("name", value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.create.address")}</label>
        <TextInput
          placeholder="192.168.1.100:8888"
          value={form.panelAddress}
          onChange={(value) => update("panelAddress", value)}
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.create.key")}</label>
        <PasswordInput
          copyable
          value={form.panelKey}
          onChange={(value) => update("panelKey", value)}
          placeholder="••••••••"
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.create.serviceType")}</label>
        <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button
            type="button"
            className={`engine-chip${form.serviceType === "bt" ? " engine-chip--active" : ""}`}
            onClick={() => update("serviceType", "bt")}
          >
            <span>{t("server.serviceType.bt")}</span>
          </button>
          <button
            type="button"
            className={`engine-chip${form.serviceType === "1panel" ? " engine-chip--active" : ""}`}
            onClick={() => update("serviceType", "1panel")}
          >
            <span>{t("server.serviceType.1panel")}</span>
          </button>
        </div>
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.create.remark")}</label>
        <TextInput
          placeholder={t("server.create.remarkPlaceholder")}
          value={form.remark}
          onChange={(value) => update("remark", value)}
        />
      </div>
    </FormDialog>
  );
}
