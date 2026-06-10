import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import { FormDialog } from "../../../components/ui/FormDialog";
import { SecretInput } from "../../../components/ui/SecretInput";
import { useConnectionStore } from "../../../stores/connectionStore";
import { collectSshGroupSuggestions, sanitizeSshGroupInput } from "../../../lib/sshGroups";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { Connection } from "../../../ipc/bindings";
import {
  buildPanelConnection,
  buildSshConnection,
  connectionsToForm,
  EMPTY_SERVER_FORM,
  findSshForPanel,
  parseSshConfig,
  type UnifiedServerFormData,
} from "./serverConnection";

interface ServerConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editSshConnection?: Connection;
  editPanelConnection?: Connection;
  /** 从面板侧栏新建/编辑时要求填写面板配置 */
  requirePanel?: boolean;
  /** 新建面板服务器时的默认分组 */
  defaultGroup?: string;
}

export function ServerConnectionDialog({
  open,
  onClose,
  onSaved,
  editSshConnection,
  editPanelConnection,
  requirePanel = false,
  defaultGroup,
}: ServerConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const removeConn = useConnectionStore((s) => s.remove);
  const connections = useConnectionStore((s) => s.connections);
  const [form, setForm] = useState<UnifiedServerFormData>(EMPTY_SERVER_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [testingPanel, setTestingPanel] = useState(false);

  const isEdit = !!(editSshConnection?.id || editPanelConnection?.id);
  const groupSuggestions = useMemo(
    () => collectSshGroupSuggestions(connections, form.group),
    [connections, form.group],
  );

  useEffect(() => {
    if (!open) return;
    const sshConn =
      editSshConnection ??
      (editPanelConnection ? findSshForPanel(connections, editPanelConnection.id) : undefined);
    const panelConn = editPanelConnection ?? undefined;
    const next = connectionsToForm(sshConn, panelConn);
    if (!isEdit && defaultGroup) {
      next.group = defaultGroup;
    }
    setForm(next);
    setError(null);
    setPanelStatus(null);
    setSaving(false);
    setTestingPanel(false);
  }, [open, editSshConnection, editPanelConnection, connections, defaultGroup, isEdit]);

  const update = <K extends keyof UnifiedServerFormData>(
    key: K,
    value: UnifiedServerFormData[K],
  ) => {
    setError(null);
    setPanelStatus(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("ssh.dialog.nameRequired");
    if (!form.host.trim()) return t("ssh.dialog.hostRequired");
    if (!form.user.trim()) return t("ssh.dialog.userRequired");
    if (form.authType === "password" && !form.password.trim()) {
      return t("ssh.dialog.passwordRequired");
    }
    if (form.authType === "privateKey" && !form.pem.trim()) {
      return t("ssh.dialog.keyRequired");
    }
    if (requirePanel || form.panelAddress.trim() || form.panelKey.trim()) {
      if (!form.panelAddress.trim()) return t("server.create.addressRequired");
      if (!form.panelKey.trim()) return t("server.create.keyRequired");
    }
    return null;
  };

  const shouldSavePanel = () =>
    requirePanel || (form.panelAddress.trim() !== "" && form.panelKey.trim() !== "");

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
      const existingSsh =
        editSshConnection ??
        (editPanelConnection ? findSshForPanel(connections, editPanelConnection.id) : undefined);
      const existingPanel = editPanelConnection;
      const savePanel = shouldSavePanel();
      const panelGroup = existingPanel?.group ?? defaultGroup ?? sanitizeSshGroupInput(form.group);

      let savedPanelId = existingPanel?.id;
      let savedSshId = existingSsh?.id;

      if (savePanel) {
        const sshDraft = buildSshConnection(form, savedSshId, savedPanelId);
        const savedSsh = await saveConn(sshDraft);
        if (!savedSsh) throw new Error("SSH save failed");
        savedSshId = savedSsh.id;

        const panelDraft = buildPanelConnection(
          form,
          panelGroup,
          savedSsh.id,
          savedPanelId,
          existingPanel?.createdAt ?? undefined,
        );
        const savedPanel = await saveConn(panelDraft);
        if (!savedPanel) throw new Error("Panel save failed");
        savedPanelId = savedPanel.id;

        const sshCfg = parseSshConfig(savedSsh);
        if (sshCfg && sshCfg.panelConnectionId !== savedPanel.id) {
          await saveConn(
            buildSshConnection(form, savedSsh.id, savedPanel.id),
          );
        }
      } else {
        const sshDraft = buildSshConnection(form, savedSshId);
        const savedSsh = await saveConn(sshDraft);
        if (!savedSsh) throw new Error("SSH save failed");
        savedSshId = savedSsh.id;

        if (existingPanel?.id) {
          await removeConn(existingPanel.id);
        }
      }

      if (!savePanel && existingSsh?.id) {
        const linkedPanel = connections.find((c) => {
          if (c.kind !== "panel") return false;
          try {
            const cfg = JSON.parse(c.config || "{}") as { sshConnectionId?: string };
            return cfg.sshConnectionId === existingSsh.id;
          } catch {
            return false;
          }
        });
        if (linkedPanel) {
          await removeConn(linkedPanel.id);
        }
      }

      void savedSshId;
      void savedPanelId;
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit
    ? editPanelConnection
      ? t("server.edit.title")
      : t("ssh.dialog.editTitle")
    : requirePanel
      ? t("server.create.title")
      : t("ssh.dialog.addTitle");

  const footerStatus = error
    ? { kind: "error" as const, message: error }
    : panelStatus;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      onCancel={onClose}
      cancelDisabled={saving || testingPanel}
      status={footerStatus}
      actions={[
        {
          label: testingPanel ? t("server.create.testing") : t("server.create.test"),
          variant: "ghost",
          disabled:
            saving ||
            testingPanel ||
            !form.panelAddress.trim() ||
            !form.panelKey.trim(),
          onClick: () => void handleTestPanel(),
        },
      ]}
      primaryAction={{
        label: saving ? t("ssh.dialog.saving") : isEdit ? t("common.save") : t("ssh.dialog.save"),
        disabled: saving || testingPanel,
        onClick: () => void handleSave(),
      }}
    >
          <div className="form-section-title">{t("server.dialog.sshSection")}</div>

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.name")}</label>
            <input
              className="input"
              placeholder={t("ssh.dialog.namePlaceholder")}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          <div className="form-row">
            <div className="form-field" style={{ flex: 2 }}>
              <label className="form-label">{t("ssh.dialog.host")}</label>
              <input
                className="input"
                placeholder="example.com"
                value={form.host}
                onChange={(e) => update("host", e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("ssh.dialog.port")}</label>
              <input
                className="input"
                placeholder="22"
                value={form.port}
                onChange={(e) => update("port", e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
          </div>

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.user")}</label>
            <input
              className="input"
              placeholder="root"
              value={form.user}
              onChange={(e) => update("user", e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.authType")}</label>
            <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <button
                type="button"
                className={`engine-chip${form.authType === "password" ? " engine-chip--active" : ""}`}
                onClick={() => update("authType", "password")}
              >
                <span>{t("ssh.dialog.passwordAuth")}</span>
              </button>
              <button
                type="button"
                className={`engine-chip${form.authType === "privateKey" ? " engine-chip--active" : ""}`}
                onClick={() => update("authType", "privateKey")}
              >
                <span>{t("ssh.dialog.keyAuth")}</span>
              </button>
            </div>
          </div>

          {form.authType === "password" ? (
            <div className="form-field">
              <label className="form-label">{t("ssh.dialog.password")}</label>
              <SecretInput
                value={form.password}
                onChange={(value) => update("password", value)}
                placeholder="••••••"
              />
            </div>
          ) : (
            <>
              <div className="form-field">
                <label className="form-label">{t("ssh.dialog.pem")}</label>
                <SecretInput
                  multiline
                  rows={4}
                  value={form.pem}
                  onChange={(value) => update("pem", value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                />
              </div>
              <div className="form-field">
                <label className="form-label">{t("ssh.dialog.passphrase")}</label>
                <SecretInput
                  value={form.passphrase}
                  onChange={(value) => update("passphrase", value)}
                  placeholder={t("ssh.dialog.passphrasePlaceholder")}
                />
              </div>
            </>
          )}

          <div className="form-field">
            <label className="form-label">{t("ssh.dialog.group")}</label>
            <input
              className="input"
              list="server-ssh-group-suggestions"
              placeholder={t("ssh.dialog.groupPlaceholder")}
              value={form.group}
              onChange={(e) => update("group", e.target.value)}
              style={{ width: "100%" }}
            />
            <datalist id="server-ssh-group-suggestions">
              {groupSuggestions.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <p className="form-hint">{t("ssh.dialog.groupHint")}</p>
          </div>

          <div className="form-section-divider" />
          <div className="form-section-title">{t("server.dialog.panelSection")}</div>

          <div className="form-field">
            <label className="form-label">{t("server.create.address")}</label>
            <input
              className="input"
              placeholder="192.168.1.100:8888"
              value={form.panelAddress}
              onChange={(e) => update("panelAddress", e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          <div className="form-field">
            <label className="form-label">{t("server.create.key")}</label>
            <SecretInput
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
    </FormDialog>
  );
}

