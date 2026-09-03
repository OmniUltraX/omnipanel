import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { PasswordInput } from "../../../components/ui/form/PasswordInput";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useConnectionStore } from "../../../stores/connectionStore";
import { createBtPanelClient, BtPanelApiError, clearBtPanelLockout } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import { commands, type Connection } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import {
  buildPanelOnlyConnection,
  EMPTY_PANEL_FORM,
  panelConnectionToForm,
  type PanelFormData,
} from "./panelForm";
import { GlobalTagEditor } from "../../tags/GlobalTagEditor";
import { mergeConnectionTags, userConnectionTags } from "../../tags/tagKinds";
import onePanelIcon from "../../../assets/icons/1Panel.svg";
import baotaIcon from "../../../assets/icons/Baota.svg";
import { isBtPanelService, isOnePanelService } from "./panelPlugin";

interface ServerConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editPanelConnection?: Connection;
  /** 新建时预填（SSH 概览「一键管理」） */
  initialForm?: Partial<PanelFormData>;
  /** 新建时绑定到该 SSH 主机 */
  bindSshConnectionId?: string;
}

export function ServerConnectionDialog({
  open,
  onClose,
  onSaved,
  editPanelConnection,
  initialForm,
  bindSshConnectionId,
}: ServerConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const [form, setForm] = useState<PanelFormData>(EMPTY_PANEL_FORM);
  const [tags, setTags] = useState<string[]>([]);
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
    let cancelled = false;

    setForm(
      editPanelConnection
        ? panelConnectionToForm(editPanelConnection)
        : { ...EMPTY_PANEL_FORM, ...initialForm },
    );
    setTags(userConnectionTags(editPanelConnection?.tags));
    setError(null);
    setPanelStatus(null);
    setSaving(false);
    setTestingPanel(false);

    // 编辑：从 Vault 回显 API Key（config 永不存明文）
    if (editPanelConnection?.id) {
      void unwrapCommand(commands.panelResolveApiKey(editPanelConnection.id), {
        quiet: true,
      })
        .then((key) => {
          if (cancelled || !key.trim()) return;
          setForm((prev) =>
            prev.panelKey.trim() ? prev : { ...prev, panelKey: key.trim() },
          );
        })
        .catch(() => {
          /* Vault 无密钥：保持空，由用户填写；留空保存仍保留原密钥 */
        });
    }

    return () => {
      cancelled = true;
    };
  }, [open, editPanelConnection, initialForm]);

  const update = <K extends keyof PanelFormData>(key: K, value: PanelFormData[K]) => {
    setError(null);
    setPanelStatus(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("server.create.nameRequired");
    if (!form.panelAddress.trim()) return t("server.create.addressRequired");
    // 编辑时可留空密钥（保留 Vault）；新建必须填写
    if (!isEdit && !form.panelKey.trim()) return t("server.create.keyRequired");
    return null;
  };

  const handleTestPanel = async () => {
    if (!form.panelAddress.trim()) {
      setPanelStatus({
        kind: "error",
        message: t("server.create.addressRequired"),
      });
      return;
    }
    const inlineKey = form.panelKey.trim();
    if (!inlineKey && !editPanelConnection?.id) {
      setPanelStatus({
        kind: "error",
        message: t("server.create.keyRequired"),
      });
      return;
    }
    setTestingPanel(true);
    setPanelStatus({ kind: "info", message: t("server.create.testing") });
    try {
      // 编辑留空：走 connectionId → Vault；新建/改密钥：用表单明文
      const connectionId = inlineKey ? undefined : editPanelConnection?.id;
      const address = form.panelAddress.trim();
      clearBtPanelLockout(address);
      if (isOnePanelService(form.serviceType)) {
        const client = createOnePanelClient(
          address,
          inlineKey,
          connectionId,
          form.panelUser,
        );
        const info = await client.getDeviceBase();
        const hostname = info.hostname ?? address;
        setPanelStatus({
          kind: "success",
          message: t("server.create.testSuccess", { hostname }),
        });
      } else {
        const client = createBtPanelClient(address, inlineKey, connectionId);
        const info = await client.getSystemTotal();
        const hostname = info.system ?? info.version ?? address;
        setPanelStatus({
          kind: "success",
          message: t("server.create.testSuccess", { hostname }),
        });
      }
    } catch (err) {
      const detail =
        err instanceof BtPanelApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setPanelStatus({
        kind: "error",
        message: t("server.create.testFailed", { error: detail }),
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
      const draft = buildPanelOnlyConnection(
        form,
        editPanelConnection,
        mergeConnectionTags(tags, editPanelConnection?.tags),
        bindSshConnectionId,
      );
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
  const canTest =
    Boolean(form.panelAddress.trim()) &&
    (Boolean(form.panelKey.trim()) || Boolean(editPanelConnection?.id));

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
          disabled: saving || testingPanel || !canTest,
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
        {isOnePanelService(form.serviceType) ? (
          <p className="form-hint">{t("server.create.onePanelAddressHint")}</p>
        ) : null}
      </div>

      {isOnePanelService(form.serviceType) ? (
        <div className="form-field">
          <label className="form-label">{t("server.create.panelUser")}</label>
          <TextInput
            placeholder="admin"
            value={form.panelUser}
            onChange={(value) => update("panelUser", value)}
          />
          <p className="form-hint">{t("server.create.panelUserHint")}</p>
        </div>
      ) : null}

      <div className="form-field">
        <label className="form-label">{t("server.create.key")}</label>
        <PasswordInput
          copyable
          value={form.panelKey}
          onChange={(value) => update("panelKey", value)}
          placeholder={
            isEdit ? t("server.create.keyPlaceholderEdit") : "••••••••"
          }
        />
        {isEdit ? (
          <p className="form-hint">{t("server.create.keyEditHint")}</p>
        ) : null}
      </div>

      <div className="form-field">
        <label className="form-label">{t("server.create.serviceType")}</label>
        <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button
            type="button"
            className={`engine-chip${isBtPanelService(form.serviceType) ? " engine-chip--active" : ""}`}
            onClick={() => update("serviceType", "bt")}
          >
            <span className="engine-chip-icon">
              <img src={baotaIcon} alt="" className="engine-chip-logo" draggable={false} />
            </span>
            <span className="engine-chip-label">{t("server.serviceType.bt")}</span>
          </button>
          <button
            type="button"
            className={`engine-chip${isOnePanelService(form.serviceType) ? " engine-chip--active" : ""}`}
            onClick={() => update("serviceType", "1panel")}
          >
            <span className="engine-chip-icon">
              <img src={onePanelIcon} alt="" className="engine-chip-logo" draggable={false} />
            </span>
            <span className="engine-chip-label">{t("server.serviceType.1panel")}</span>
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

      <div className="form-section-title">{t("resourceTags.section")}</div>
      <GlobalTagEditor
        kind="connection"
        resourceId={editPanelConnection?.id ?? ""}
        tags={tags}
        onChange={setTags}
      />
    </FormDialog>
  );
}
