import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { Select } from "@/components/ui/form/Select";
import { createOnePanelClient } from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";
import { isOnePanelService } from "./panelPlugin";
import { certificateRowLabel } from "./serverResourceLabels";

type BindWebsiteCertificateDialogProps = {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  onClose: () => void;
  onBound?: () => void;
};

function formatBindError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function BindWebsiteCertificateDialog({
  open,
  server,
  websiteId,
  siteName = null,
  onClose,
  onBound,
}: BindWebsiteCertificateDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const [sslId, setSslId] = useState("");
  const [certificates, setCertificates] = useState<Array<{ id: number; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setSslId("");
    setCertificates([]);
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
    if (!open || websiteId == null || !isOnePanelService(server.serviceType)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createOnePanelClient(
          server.address,
          server.key,
          server.id,
          server.panelUser,
        );
        const certList = await client.searchCertificates().catch(() => [] as unknown[]);
        if (cancelled) return;
        const certs = certList
          .filter(
            (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
          )
          .map((row) => ({
            id: Number(row.id ?? 0),
            label: certificateRowLabel(row),
          }))
          .filter((row) => row.id > 0);
        setCertificates(certs);
        setSslId(certs[0] ? String(certs[0].id) : "");
      } catch (err) {
        if (!cancelled) setError(formatBindError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, websiteId]);

  const certOptions = useMemo(() => {
    if (certificates.length === 0) {
      return [{ value: "", label: t("server.create.website.certificateEmpty"), disabled: true }];
    }
    return certificates.map((cert) => ({
      value: String(cert.id),
      label: cert.label,
    }));
  }, [certificates, t]);

  const selectedSslId = Number(sslId) || 0;
  const canSubmit = useMemo(
    () => Boolean(websiteId != null && selectedSslId > 0 && !loading),
    [websiteId, selectedSslId, loading],
  );

  const handleSubmit = async () => {
    if (!isOnePanelService(server.serviceType) || websiteId == null) {
      setError(t("server.websites.onePanelOnly"));
      return;
    }
    if (!canSubmit) {
      setError(t("server.websites.certSelectRequired"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(
        server.address,
        server.key,
        server.id,
        server.panelUser,
      );
      await client.updateWebsiteHttps({
        websiteId,
        enable: true,
        type: "existed",
        websiteSSLId: selectedSslId,
        httpConfig: "HTTPToHTTPS",
        httpsPorts: [443],
      });
      showToast(t("server.websites.certBindSuccess"));
      await refreshServer(server);
      reset();
      onClose();
      onBound?.();
    } catch (err) {
      setError(formatBindError(err));
    } finally {
      setBusy(false);
    }
  };

  const titleName = siteName?.trim() || String(websiteId ?? "");

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.websites.certBindTitle", { name: titleName })}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("server.websites.certBind"),
        disabled: busy || loading || !canSubmit,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      {loading ? (
        <p className="form-hint">{t("common.loading")}</p>
      ) : (
        <FormField label={t("server.websites.certSelect")}>
          <Select
            value={sslId}
            onChange={setSslId}
            options={certOptions}
            searchable={certificates.length >= 8}
            disabled={busy || certificates.length === 0}
            placeholder={t("server.websites.certSelect")}
            emptyText={t("server.create.website.certificateEmpty")}
            style={{ width: "100%" }}
            aria-label={t("server.websites.certSelect")}
          />
        </FormField>
      )}
    </FormDialog>
  );
}
