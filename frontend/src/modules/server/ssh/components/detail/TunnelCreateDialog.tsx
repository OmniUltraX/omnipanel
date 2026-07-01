import { useEffect, useState } from "react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import { useI18n } from "@/i18n";
import { commands } from "@/ipc/bindings";

export type TunnelDraft = {
  remotePort: number;
  localPort: string;
  remoteHost: string;
  tunnelType: "local" | "remote" | "dynamic";
};

type Props = {
  open: boolean;
  resourceId: string | null;
  draft: TunnelDraft | null;
  onClose: () => void;
  onCreated?: () => void;
};

export function TunnelCreateDialog({
  open,
  resourceId,
  draft,
  onClose,
  onCreated,
}: Props) {
  const { t } = useI18n();
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("");
  const [tunnelType, setTunnelType] = useState<"local" | "remote" | "dynamic">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!open || !draft) return;
    setLocalPort(draft.localPort);
    setRemoteHost(draft.remoteHost);
    setRemotePort(String(draft.remotePort));
    setTunnelType(draft.tunnelType);
    setError(null);
    setSuccess(false);
    setBusy(false);
  }, [open, draft]);

  async function handleCreate() {
    if (!resourceId) return;
    const lp = parseInt(localPort, 10);
    const rp = parseInt(remotePort, 10);
    if (!Number.isFinite(lp) || lp <= 0 || !Number.isFinite(rp) || rp <= 0) {
      setError(t("ssh.tunnels.formRequired"));
      return;
    }
    if (!remoteHost.trim()) {
      setError(t("ssh.tunnels.formRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await commands.sshCreateTunnel(
        resourceId,
        tunnelType,
        lp,
        remoteHost.trim(),
        rp,
      );
      if (res.status === "ok") {
        setSuccess(true);
        onCreated?.();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open && draft != null}
      onClose={onClose}
      title={t("ssh.processList.createTunnel")}
      subtitle={
        draft
          ? t("ssh.processList.createTunnelHint", {
              localPort: localPort || draft.localPort,
              remotePort: remotePort || draft.remotePort,
            })
          : undefined
      }
      size="sm"
      status={
        error
          ? { kind: "error", message: error }
          : success
            ? { kind: "success", message: t("ssh.processList.tunnelCreated") }
            : null
      }
      primaryAction={
        success
          ? undefined
          : {
              label: busy ? t("ssh.processList.tunnelCreating") : t("ssh.tunnels.create"),
              disabled: busy || !resourceId,
              onClick: () => void handleCreate(),
            }
      }
      cancelLabel={success ? t("common.close") : undefined}
    >
      <div className="ssh-tunnel-dialog-form">
        <label className="ssh-tunnel-dialog-field">
          <span>{t("ssh.tunnels.type")}</span>
          <Select
            className="input input-sm"
            size="sm"
            value={tunnelType}
            onChange={(v) => setTunnelType(v as typeof tunnelType)}
            searchable={false}
            options={[
              { value: "local", label: t("ssh.tunnels.typeLocal") },
              { value: "remote", label: t("ssh.tunnels.typeRemote") },
              { value: "dynamic", label: t("ssh.tunnels.typeDynamic") },
            ]}
          />
        </label>
        <div className="ssh-tunnel-dialog-row">
          <label className="ssh-tunnel-dialog-field">
            <span>{t("ssh.tunnels.localPort")}</span>
            <TextInput
              size="sm"
              value={localPort}
              onChange={setLocalPort}
              disabled={busy || success}
            />
          </label>
          <label className="ssh-tunnel-dialog-field">
            <span>{t("ssh.tunnels.remoteHost")}</span>
            <TextInput
              size="sm"
              value={remoteHost}
              onChange={setRemoteHost}
              disabled={busy || success}
            />
          </label>
          <label className="ssh-tunnel-dialog-field">
            <span>{t("ssh.tunnels.remotePort")}</span>
            <TextInput
              size="sm"
              value={remotePort}
              onChange={setRemotePort}
              disabled={busy || success}
            />
          </label>
        </div>
      </div>
    </FormDialog>
  );
}
