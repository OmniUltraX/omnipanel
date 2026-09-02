import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { getPanelDriver, panelConnectionCtx } from "@/lib/panelDriverRegistry";
import { showToast } from "@/stores/toastStore";
import type { ServerEntry } from "./serverConnection";

type Props = {
  open: boolean;
  server: ServerEntry;
  onClose: () => void;
  onCreated?: () => void;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 面板数据库创建（走插件 L2 `createDatabase`）。 */
export function CreateDatabaseDialog({ open, server, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [dbUser, setDbUser] = useState("");
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState("127.0.0.1");
  const [codeing, setCodeing] = useState("utf8mb4");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName("");
    setDbUser("");
    setPassword("");
    setAddress("127.0.0.1");
    setCodeing("utf8mb4");
    setRemark("");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const canSubmit = useMemo(
    () => Boolean(name.trim() && (dbUser.trim() || name.trim()) && password.trim()),
    [name, dbUser, password],
  );

  const handleSubmit = async () => {
    const driver = getPanelDriver(server.serviceType);
    if (!driver?.createDatabase) {
      setError(t("server.create.panelOnly"));
      return;
    }
    if (!canSubmit) {
      setError(t("server.create.database.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await driver.createDatabase(panelConnectionCtx(server), {
        name: name.trim(),
        dbUser: dbUser.trim() || name.trim(),
        password,
        address: address.trim() || "127.0.0.1",
        charset: codeing,
        remark: remark.trim(),
      });
      showToast(t("server.create.database.success"));
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.create.database.title")}
      size="md"
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || !canSubmit,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      <FormField label={t("server.create.database.name")}>
        <TextInput value={name} onChange={setName} disabled={busy} />
      </FormField>
      <FormField label={t("server.create.database.user")}>
        <TextInput value={dbUser} onChange={setDbUser} disabled={busy} />
      </FormField>
      <FormField label={t("server.create.database.password")}>
        <TextInput value={password} onChange={setPassword} disabled={busy} />
      </FormField>
      <FormField label={t("server.create.database.address")}>
        <TextInput value={address} onChange={setAddress} disabled={busy} />
      </FormField>
      <FormField label={t("server.create.database.charset")}>
        <select
          className="input"
          value={codeing}
          disabled={busy}
          onChange={(e) => setCodeing(e.target.value)}
        >
          <option value="utf8mb4">utf8mb4</option>
          <option value="utf8">utf8</option>
          <option value="gbk">gbk</option>
        </select>
      </FormField>
      <FormField label={t("server.create.remark")}>
        <TextInput
          value={remark}
          onChange={setRemark}
          placeholder={t("server.create.remarkPlaceholder")}
          disabled={busy}
        />
      </FormField>
    </FormDialog>
  );
}
