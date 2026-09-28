import { useCallback, useEffect, useState } from "react";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { PasswordInput } from "../../../../components/ui/form/PasswordInput";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { WorkbenchActionButton } from "../../../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../../../i18n";
import { formatIpcError } from "../../../../ipc/result";
import {
  deleteWarpgateGateway,
  invokeWarpgateMethod,
  loadWarpgateGateways,
  type WarpgateGateway,
  upsertWarpgateGateway,
} from "../../../../lib/warpgateGateways";
import { showToast } from "../../../../stores/toastStore";

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
};

type Draft = {
  id?: string;
  name: string;
  baseUrl: string;
  loginUser: string;
  insecureTls: boolean;
  token: string;
  password: string;
};

const EMPTY: Draft = {
  name: "",
  baseUrl: "",
  loginUser: "",
  insecureTls: true,
  token: "",
  password: "",
};

export function WarpgateGatewaysDialog({ open, onClose, onChanged }: Props) {
  const { t } = useI18n();
  const [gateways, setGateways] = useState<WarpgateGateway[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await loadWarpgateGateways();
    setGateways(list);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(EMPTY);
    void refresh().catch((err) => setError(formatIpcError(err)));
  }, [open, refresh]);

  const startEdit = (g: WarpgateGateway) => {
    setDraft({
      id: g.id,
      name: g.name,
      baseUrl: g.baseUrl,
      loginUser: g.loginUser,
      insecureTls: g.insecureTls,
      token: "",
      password: "",
    });
    setError(null);
  };

  const handleSave = async () => {
    if (!draft.baseUrl.trim()) {
      setError(t("ssh.warpgate.baseUrlRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await upsertWarpgateGateway(draft);
      setDraft(EMPTY);
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteWarpgateGateway(id);
      if (draft.id === id) setDraft(EMPTY);
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (g: WarpgateGateway) => {
    setTestingId(g.id);
    setError(null);
    try {
      const result = await invokeWarpgateMethod<{ loginUser?: string; bastionHost?: string }>(
        "testGateway",
        g,
      );
      setError(null);
      const user = result.loginUser?.trim() || "—";
      const host = result.bastionHost?.trim() || g.baseUrl;
      showToast(t("ssh.warpgate.testOk", { user, host }));
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("ssh.warpgate.manageTitle")}
      size="md"
      onCancel={onClose}
      cancelDisabled={busy}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: busy ? t("ssh.dialog.saving") : draft.id ? t("common.save") : t("ssh.warpgate.addGateway"),
        disabled: busy,
        onClick: () => void handleSave(),
      }}
    >
      <p className="form-hint">{t("ssh.warpgate.manageHint")}</p>

      <div className="form-section-title">{t("ssh.warpgate.gatewayList")}</div>
      {gateways.length === 0 ? (
        <p className="form-hint">{t("ssh.warpgate.emptyGateways")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {gateways.map((g) => (
            <li
              key={g.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                border: "1px solid var(--border-subtle, #e5e7eb)",
                borderRadius: 4,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{g.name}</div>
                <div className="form-hint" style={{ margin: 0 }}>
                  {g.baseUrl}
                  {g.loginUser ? ` · ${g.loginUser}` : ""}
                </div>
              </div>
              <WorkbenchActionButton
                disabled={busy || testingId === g.id}
                onClick={() => void handleTest(g)}
              >
                {testingId === g.id ? t("ssh.warpgate.testing") : t("ssh.warpgate.test")}
              </WorkbenchActionButton>
              <WorkbenchActionButton disabled={busy} onClick={() => startEdit(g)}>
                {t("common.edit")}
              </WorkbenchActionButton>
              <WorkbenchActionButton danger disabled={busy} onClick={() => void handleDelete(g.id)}>
                {t("common.delete")}
              </WorkbenchActionButton>
            </li>
          ))}
        </ul>
      )}

      <div className="form-section-title" style={{ marginTop: 16 }}>
        {draft.id ? t("ssh.warpgate.editGateway") : t("ssh.warpgate.newGateway")}
      </div>

      <div className="form-field">
        <label className="form-label">{t("ssh.warpgate.name")}</label>
        <TextInput
          value={draft.name}
          onChange={(value) => setDraft((p) => ({ ...p, name: value }))}
          placeholder={t("ssh.warpgate.namePlaceholder")}
        />
      </div>
      <div className="form-field">
        <label className="form-label">{t("ssh.warpgate.baseUrl")}</label>
        <TextInput
          value={draft.baseUrl}
          onChange={(value) => setDraft((p) => ({ ...p, baseUrl: value }))}
          placeholder="https://warpgate.example.com"
        />
      </div>
      <div className="form-field">
        <label className="form-label">{t("ssh.warpgate.token")}</label>
        <PasswordInput
          copyable
          value={draft.token}
          onChange={(value) => setDraft((p) => ({ ...p, token: value }))}
          placeholder={draft.id ? t("ssh.warpgate.secretKeepHint") : "••••••"}
        />
      </div>
      <div className="form-row">
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("ssh.warpgate.loginUser")}</label>
          <TextInput
            value={draft.loginUser}
            onChange={(value) => setDraft((p) => ({ ...p, loginUser: value }))}
            placeholder="admin"
          />
        </div>
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("ssh.warpgate.password")}</label>
          <PasswordInput
            copyable
            value={draft.password}
            onChange={(value) => setDraft((p) => ({ ...p, password: value }))}
            placeholder={draft.id ? t("ssh.warpgate.secretKeepHint") : "••••••"}
          />
        </div>
      </div>
      <label className="form-field" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.insecureTls}
          onChange={(e) => setDraft((p) => ({ ...p, insecureTls: e.target.checked }))}
        />
        <span className="form-label" style={{ margin: 0 }}>
          {t("ssh.warpgate.insecureTls")}
        </span>
      </label>
      {draft.id ? (
        <WorkbenchActionButton
          disabled={busy}
          onClick={() => {
            setDraft(EMPTY);
            setError(null);
          }}
        >
          {t("ssh.warpgate.cancelEdit")}
        </WorkbenchActionButton>
      ) : null}
    </FormDialog>
  );
}
