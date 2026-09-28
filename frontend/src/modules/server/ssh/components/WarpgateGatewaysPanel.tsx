import { useCallback, useEffect, useRef, useState } from "react";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { FormField } from "../../../../components/ui/form/FormField";
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

type PanelProps = {
  /** 嵌入设置 SubWindow 时为 true */
  embedded?: boolean;
  onChanged?: () => void;
  /** 嵌入时把保存/取消报到外层底栏 */
  onActionsChange?: (
    actions: {
      primaryLabel: string;
      onPrimary: () => void;
      busy?: boolean;
      disabled?: boolean;
      secondaryLabel?: string;
      onSecondary?: () => void;
    } | null,
  ) => void;
};

export function WarpgateGatewaysPanel({
  embedded = false,
  onChanged,
  onActionsChange,
}: PanelProps) {
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
    setError(null);
    setDraft(EMPTY);
    void refresh().catch((err) => setError(formatIpcError(err)));
  }, [refresh]);

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

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const handleSave = useCallback(async () => {
    const current = draftRef.current;
    if (!current.baseUrl.trim()) {
      setError(t("ssh.warpgate.baseUrlRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await upsertWarpgateGateway(current);
      setDraft(EMPTY);
      await refresh();
      onChanged?.();
      if (embedded) {
        showToast(t("ssh.warpgate.saved"));
      }
    } catch (err) {
      setError(formatIpcError(err));
    } finally {
      setBusy(false);
    }
  }, [embedded, onChanged, refresh, t]);

  const cancelEdit = useCallback(() => {
    setDraft(EMPTY);
    setError(null);
  }, []);

  const liftActions = Boolean(embedded && onActionsChange);

  useEffect(() => {
    if (!liftActions || !onActionsChange) return;
    onActionsChange({
      primaryLabel: draft.id ? t("common.save") : t("ssh.warpgate.addGateway"),
      onPrimary: () => {
        void handleSave();
      },
      busy,
      secondaryLabel: draft.id ? t("ssh.warpgate.cancelEdit") : undefined,
      onSecondary: draft.id ? cancelEdit : undefined,
    });
    return () => onActionsChange(null);
  }, [liftActions, onActionsChange, busy, draft.id, handleSave, cancelEdit, t]);

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

  const body = (
    <>
      <p className="form-hint">{t("ssh.warpgate.manageHint")}</p>
      {error ? (
        <p className="form-hint" style={{ color: "var(--danger, #c44)" }}>
          {error}
        </p>
      ) : null}

      <div className="form-section-title">{t("ssh.warpgate.gatewayList")}</div>
      {gateways.length === 0 ? (
        <p className="form-hint">{t("ssh.warpgate.emptyGateways")}</p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
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

      <div className="plugin-settings-form">
        <FormField layout="horizontal" label={t("ssh.warpgate.name")}>
          <TextInput
            value={draft.name}
            onChange={(value) => setDraft((p) => ({ ...p, name: value }))}
            placeholder={t("ssh.warpgate.namePlaceholder")}
          />
        </FormField>
        <FormField layout="horizontal" label={t("ssh.warpgate.baseUrl")}>
          <TextInput
            value={draft.baseUrl}
            onChange={(value) => setDraft((p) => ({ ...p, baseUrl: value }))}
            placeholder="https://warpgate.example.com"
          />
        </FormField>
        <FormField layout="horizontal" label={t("ssh.warpgate.token")}>
          <PasswordInput
            copyable
            value={draft.token}
            onChange={(value) => setDraft((p) => ({ ...p, token: value }))}
            placeholder={draft.id ? t("ssh.warpgate.secretKeepHint") : "••••••"}
          />
        </FormField>
        <FormField layout="horizontal" label={t("ssh.warpgate.loginUser")}>
          <TextInput
            value={draft.loginUser}
            onChange={(value) => setDraft((p) => ({ ...p, loginUser: value }))}
            placeholder="admin"
          />
        </FormField>
        <FormField layout="horizontal" label={t("ssh.warpgate.password")}>
          <PasswordInput
            copyable
            value={draft.password}
            onChange={(value) => setDraft((p) => ({ ...p, password: value }))}
            placeholder={draft.id ? t("ssh.warpgate.secretKeepHint") : "••••••"}
          />
        </FormField>
        <label className="plugin-settings-form__check plugin-settings-form__check--indent">
          <input
            type="checkbox"
            checked={draft.insecureTls}
            onChange={(e) => setDraft((p) => ({ ...p, insecureTls: e.target.checked }))}
          />
          <span>{t("ssh.warpgate.insecureTls")}</span>
        </label>
      </div>
      {!liftActions ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-start" }}>
          {draft.id ? (
            <WorkbenchActionButton disabled={busy} onClick={cancelEdit}>
              {t("ssh.warpgate.cancelEdit")}
            </WorkbenchActionButton>
          ) : null}
          <WorkbenchActionButton disabled={busy} onClick={() => void handleSave()}>
            {busy ? t("ssh.dialog.saving") : draft.id ? t("common.save") : t("ssh.warpgate.addGateway")}
          </WorkbenchActionButton>
        </div>
      ) : null}
    </>
  );

  if (embedded) {
    return <div className="plugin-settings-panel">{body}</div>;
  }

  return body;
}

type DialogProps = {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
};

/** SSH 备选连接里的「管理网关」对话框壳。 */
export function WarpgateGatewaysDialog({ open, onClose, onChanged }: DialogProps) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("ssh.warpgate.manageTitle")}
      size="md"
      onCancel={onClose}
      cancelLabel={t("common.close")}
    >
      <WarpgateGatewaysPanel onChanged={onChanged} />
    </FormDialog>
  );
}
