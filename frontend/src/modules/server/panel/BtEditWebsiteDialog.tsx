import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { createBtPanelClient, type BtPhpVersion } from "@/lib/btpanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";

type Props = {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName: string | null;
  onClose: () => void;
  onUpdated?: () => void;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function BtEditWebsiteDialog({
  open,
  server,
  websiteId,
  siteName,
  onClose,
  onUpdated,
}: Props) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const [remark, setRemark] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [phpVersions, setPhpVersions] = useState<BtPhpVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setRemark("");
    setPhpVersion("");
    setError(null);
    setBusy(false);
    setLoading(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  useEffect(() => {
    if (!open || websiteId == null || !siteName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createBtPanelClient(server.address, server.key, server.id);
        const [versions, phpInfo, sites] = await Promise.all([
          client.getPhpVersions().catch(() => [] as BtPhpVersion[]),
          client.getSitePhpVersion(siteName).catch(() => ({}) as Record<string, unknown>),
          client.getWebsiteList({ limit: 200 }).catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        setPhpVersions(versions);
        const current =
          String(
            (phpInfo as Record<string, unknown>).phpversion ??
              (phpInfo as Record<string, unknown>).version ??
              (phpInfo as Record<string, unknown>).php ??
              "",
          ).trim() || "00";
        setPhpVersion(current);
        const site = sites.data.find((row) => row.id === websiteId);
        setRemark(String(site?.ps ?? ""));
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server.address, server.key, siteName, websiteId]);

  const canSubmit = useMemo(
    () => Boolean(websiteId != null && siteName),
    [websiteId, siteName],
  );

  const handleSubmit = async () => {
    if (websiteId == null || !siteName) {
      setError(t("server.websites.missingSiteName"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createBtPanelClient(server.address, server.key, server.id);
      await client.setSiteRemark(websiteId, remark.trim());
      if (phpVersion && phpVersion !== "00") {
        await client.setSitePhpVersion(siteName, phpVersion);
      }
      showToast(t("server.websites.editSuccess"));
      await refreshServer(server);
      reset();
      onClose();
      onUpdated?.();
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
      title={t("server.websites.editTitle")}
      size="md"
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || loading || !canSubmit,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      {loading ? (
        <p className="form-hint">{t("common.loading")}</p>
      ) : (
        <>
          <FormField label={t("server.create.website.domain")}>
            <TextInput value={siteName ?? ""} onChange={() => {}} disabled />
          </FormField>
          <FormField label={t("server.create.remark")}>
            <TextInput
              value={remark}
              onChange={setRemark}
              placeholder={t("server.create.remarkPlaceholder")}
              disabled={busy}
            />
          </FormField>
          <FormField label={t("server.create.website.phpVersion")}>
            <select
              className="input"
              value={phpVersion}
              disabled={busy}
              onChange={(e) => setPhpVersion(e.target.value)}
            >
              <option value="00">{t("server.create.website.btTypeStatic")}</option>
              {phpVersions
                .filter((v) => v.version !== "00")
                .map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.name || `PHP ${v.version}`}
                  </option>
                ))}
            </select>
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
