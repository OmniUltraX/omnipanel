import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { PasswordInput } from "../../../components/ui/form/PasswordInput";
import { Select } from "../../../components/ui/form/Select";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useConnectionStore } from "../../../stores/connectionStore";
import { collectSshGroupSuggestions, sanitizeSshGroupInput } from "../../../lib/sshGroups";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { Connection } from "../../../ipc/bindings";
import { parseSshConfig } from "./serverConnection";
import {
  buildPanelOnlyConnection,
  EMPTY_PANEL_FORM,
  panelConnectionToForm,
  type PanelFormData,
} from "./panelForm";
import {
  detectPanelSshConnection,
  parsePanelAddressHost,
  probePanelSshLinkStatus,
  type PanelSshLinkStatus,
} from "./panelSshDetect";

interface ServerConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editPanelConnection?: Connection;
  defaultGroup?: string;
}

const ENV_OPTIONS = [
  { value: "local", label: "本地" },
  { value: "dev", label: "开发" },
  { value: "staging", label: "预发" },
  { value: "prod", label: "生产" },
  { value: "unknown", label: "未标记" },
];

function sshOptionLabel(conn: Connection): string {
  const cfg = parseSshConfig(conn);
  if (!cfg) return conn.name;
  return `${conn.name} (${cfg.user}@${cfg.host}:${cfg.port})`;
}

async function linkSshConnectionToPanel(
  sshConnectionId: string,
  panelId: string,
  connections: Connection[],
  saveConn: (conn: Connection) => Promise<Connection | null | undefined>,
): Promise<void> {
  const ssh = connections.find((item) => item.id === sshConnectionId && item.kind === "ssh");
  if (!ssh) return;
  const cfg = parseSshConfig(ssh);
  if (!cfg || cfg.panelConnectionId === panelId) return;
  await saveConn({
    ...ssh,
    config: JSON.stringify({ ...cfg, panelConnectionId: panelId }),
  });
}

function PanelSshLinkStatusHint({
  status,
  manual,
}: {
  status: PanelSshLinkStatus;
  manual: boolean;
}) {
  const { t } = useI18n();

  if (manual) {
    if (status.connected && status.hostMatch) {
      return (
        <p className="form-field-hint">
          {t("server.create.sshStatus.manualConnected")}
        </p>
      );
    }
    if (status.connected && !status.hostMatch) {
      return (
        <p className="form-field-hint form-field-hint-warn">
          {t("server.create.sshStatus.hostMismatch")}
        </p>
      );
    }
    return (
      <p className="form-field-hint form-field-hint-warn">
        {t("server.create.sshStatus.notConnected")}
      </p>
    );
  }

  if (status.connected && status.hostMatch) {
    return (
      <p className="form-field-hint">
        {t("server.create.sshStatus.autoConnected")}
      </p>
    );
  }
  if (status.hostMatch) {
    return (
      <p className="form-field-hint form-field-hint-warn">
        {t("server.create.sshStatus.autoNotConnected")}
      </p>
    );
  }
  return (
    <p className="form-field-hint form-field-hint-warn">
      {t("server.create.sshStatus.hostMismatch")}
    </p>
  );
}

export function ServerConnectionDialog({
  open,
  onClose,
  onSaved,
  editPanelConnection,
  defaultGroup,
}: ServerConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const connections = useConnectionStore((s) => s.connections);
  const [form, setForm] = useState<PanelFormData>(EMPTY_PANEL_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [testingPanel, setTestingPanel] = useState(false);
  const [sshManualMode, setSshManualMode] = useState(false);
  const [sshDetecting, setSshDetecting] = useState(false);
  const [sshLinkStatus, setSshLinkStatus] = useState<PanelSshLinkStatus | null>(null);
  const sshProbeGenRef = useRef(0);
  const skipAutoDetectRef = useRef(false);

  const isEdit = !!editPanelConnection?.id;

  const sshConnections = useMemo(
    () => connections.filter((conn) => conn.kind === "ssh"),
    [connections],
  );

  const sshOptions = useMemo(
    () =>
      sshConnections.map((conn) => ({
        value: conn.id,
        label: sshOptionLabel(conn),
      })),
    [sshConnections],
  );

  const panelHost = useMemo(() => parsePanelAddressHost(form.panelAddress), [form.panelAddress]);

  const groupSuggestions = useMemo(
    () => collectSshGroupSuggestions(connections, form.group),
    [connections, form.group],
  );

  const refreshSshLinkStatus = useCallback(
    async (sshConnectionId: string, panelAddress: string) => {
      if (!sshConnectionId.trim()) {
        setSshLinkStatus(null);
        return;
      }
      const gen = ++sshProbeGenRef.current;
      const status = await probePanelSshLinkStatus(sshConnectionId, panelAddress, sshConnections);
      if (gen !== sshProbeGenRef.current) return;
      setSshLinkStatus(status);
    },
    [sshConnections],
  );

  useEffect(() => {
    if (!open) return;

    skipAutoDetectRef.current = true;
    const next = editPanelConnection
      ? panelConnectionToForm(editPanelConnection)
      : { ...EMPTY_PANEL_FORM, group: defaultGroup ?? EMPTY_PANEL_FORM.group };

    setForm(next);
    setError(null);
    setPanelStatus(null);
    setSaving(false);
    setTestingPanel(false);
    setSshDetecting(false);
    setSshLinkStatus(null);

    void (async () => {
      if (!next.panelAddress.trim()) {
        setSshManualMode(false);
        skipAutoDetectRef.current = false;
        return;
      }

      const matched = await detectPanelSshConnection(next.panelAddress, sshConnections);
      const manual =
        !matched || (next.sshConnectionId.trim() !== "" && matched.id !== next.sshConnectionId);
      setSshManualMode(manual);

      if (next.sshConnectionId.trim()) {
        await refreshSshLinkStatus(next.sshConnectionId, next.panelAddress);
      }

      skipAutoDetectRef.current = false;
    })();
  }, [open, editPanelConnection, defaultGroup, refreshSshLinkStatus, sshConnections]);

  useEffect(() => {
    if (!open || skipAutoDetectRef.current) return;

    const host = panelHost;
    if (!host) {
      setSshDetecting(false);
      setSshLinkStatus(null);
      setForm((prev) => (prev.sshConnectionId ? { ...prev, sshConnectionId: "" } : prev));
      setSshManualMode(false);
      return;
    }

    setSshDetecting(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const matched = await detectPanelSshConnection(form.panelAddress, sshConnections);
        if (matched) {
          setSshManualMode(false);
          setForm((prev) => ({ ...prev, sshConnectionId: matched.id }));
          await refreshSshLinkStatus(matched.id, form.panelAddress);
        } else {
          setSshManualMode(true);
          setForm((prev) => ({ ...prev, sshConnectionId: "" }));
          setSshLinkStatus(null);
        }
        setSshDetecting(false);
      })();
    }, 400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open, panelHost, form.panelAddress, sshConnections, refreshSshLinkStatus]);

  useEffect(() => {
    if (!open || !sshManualMode || !form.sshConnectionId.trim()) return;
    void refreshSshLinkStatus(form.sshConnectionId, form.panelAddress);
  }, [
    open,
    sshManualMode,
    form.sshConnectionId,
    form.panelAddress,
    refreshSshLinkStatus,
  ]);

  const update = <K extends keyof PanelFormData>(key: K, value: PanelFormData[K]) => {
    setError(null);
    setPanelStatus(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSshConnectionChange = (sshConnectionId: string) => {
    setSshManualMode(true);
    update("sshConnectionId", sshConnectionId);
    setSshLinkStatus(null);
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
      const draft = buildPanelOnlyConnection(
        { ...form, group: sanitizeSshGroupInput(form.group) },
        editPanelConnection,
      );
      const saved = await saveConn(draft);
      if (!saved?.id) throw new Error("Panel save failed");

      if (form.sshConnectionId.trim()) {
        await linkSshConnectionToPanel(
          form.sshConnectionId.trim(),
          saved.id,
          connections,
          saveConn,
        );
      }

      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const footerStatus = error ? { kind: "error" as const, message: error } : panelStatus;
  const sshSelectDisabled = sshDetecting || (!sshManualMode && Boolean(form.sshConnectionId));
  const selectedSshLabel = sshConnections.find((conn) => conn.id === form.sshConnectionId)?.name;

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
        <label className="form-label">{t("server.create.sshConnection")}</label>
        {!panelHost ? (
          <p className="form-field-hint">{t("server.create.sshConnectionNeedAddress")}</p>
        ) : (
          <>
            <Select
              className="input"
              value={form.sshConnectionId}
              onChange={handleSshConnectionChange}
              disabled={sshSelectDisabled || sshOptions.length === 0}
              searchable
              placeholder={
                sshDetecting
                  ? t("server.create.sshDetecting")
                  : t("server.create.sshConnectionPlaceholder")
              }
              options={[
                { value: "", label: t("server.create.sshConnectionNone") },
                ...sshOptions,
              ]}
              style={{ width: "100%" }}
            />
            {sshDetecting ? (
              <p className="form-field-hint">{t("server.create.sshDetecting")}</p>
            ) : null}
            {!sshDetecting && sshManualMode && !form.sshConnectionId && panelHost ? (
              <p className="form-field-hint form-field-hint-warn">
                {t("server.create.sshNoMatch", { host: panelHost })}
              </p>
            ) : null}
            {!sshDetecting && !sshManualMode && form.sshConnectionId && selectedSshLabel ? (
              <p className="form-field-hint">
                {t("server.create.sshAutoMatched", { name: selectedSshLabel, host: panelHost })}
              </p>
            ) : null}
            {!sshDetecting && sshLinkStatus ? (
              <PanelSshLinkStatusHint status={sshLinkStatus} manual={sshManualMode} />
            ) : null}
          </>
        )}
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

      <div className="form-row">
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("server.create.envTag")}</label>
          <Select
            className="input"
            value={form.envTag}
            onChange={(v) => update("envTag", v)}
            style={{ width: "100%" }}
            searchable={false}
            options={ENV_OPTIONS}
          />
        </div>
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("ssh.dialog.group")}</label>
          <TextInput
            list="server-panel-group-suggestions"
            placeholder={t("ssh.dialog.groupPlaceholder")}
            value={form.group}
            onChange={(value) => update("group", value)}
          />
          <datalist id="server-panel-group-suggestions">
            {groupSuggestions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
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
