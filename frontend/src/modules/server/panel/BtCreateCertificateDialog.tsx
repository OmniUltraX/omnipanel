import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { Select } from "@/components/ui/form/Select";
import { createBtPanelClient } from "@/lib/btpanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";
import { websiteRowLabel } from "./serverResourceLabels";

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

/** 宝塔：上传 PEM 并部署到指定站点。 */
export function BtCreateCertificateDialog({ open, server, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const [siteName, setSiteName] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [certificate, setCertificate] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setSiteName("");
    setCertificate("");
    setPrivateKey("");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOptionsLoading(true);
    void (async () => {
      try {
        const client = createBtPanelClient(server.address, server.key, server.id);
        const result = await client.getWebsiteList({ limit: 200 });
        if (cancelled) return;
        const names = result.data
          .map((row) => websiteRowLabel(row as unknown as Record<string, unknown>))
          .filter((name) => name && name !== "—");
        setSites(names);
        if (names[0]) setSiteName(names[0]);
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server.address, server.key]);

  const siteOptions = useMemo(() => {
    if (sites.length === 0) {
      return [{ value: "", label: t("server.create.certificate.btSiteEmpty"), disabled: true }];
    }
    return sites.map((name) => ({ value: name, label: name }));
  }, [sites, t]);

  const canSubmit = useMemo(
    () => Boolean(siteName.trim() && certificate.trim() && privateKey.trim()),
    [siteName, certificate, privateKey],
  );

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(t("server.create.certificate.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createBtPanelClient(server.address, server.key, server.id);
      await client.setSiteSsl(siteName.trim(), privateKey.trim(), certificate.trim());
      showToast(t("server.create.certificate.uploadSuccess"));
      await refreshServer(server);
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
      title={t("server.create.certificate.title")}
      size="lg"
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || optionsLoading || !canSubmit,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      <FormField label={t("server.create.certificate.btSite")}>
        <Select
          value={siteName}
          onChange={setSiteName}
          options={siteOptions}
          searchable={sites.length >= 8}
          disabled={busy || sites.length === 0}
          placeholder={t("server.create.certificate.btSite")}
          emptyText={t("server.create.certificate.btSiteEmpty")}
          style={{ width: "100%" }}
          aria-label={t("server.create.certificate.btSite")}
        />
      </FormField>
      <FormField label={t("server.create.certificate.certPem")}>
        <textarea
          className="input"
          rows={8}
          value={certificate}
          disabled={busy}
          placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(e) => setCertificate(e.target.value)}
        />
      </FormField>
      <FormField label={t("server.create.certificate.keyPem")}>
        <textarea
          className="input"
          rows={8}
          value={privateKey}
          disabled={busy}
          placeholder="-----BEGIN PRIVATE KEY-----"
          onChange={(e) => setPrivateKey(e.target.value)}
        />
      </FormField>
    </FormDialog>
  );
}
