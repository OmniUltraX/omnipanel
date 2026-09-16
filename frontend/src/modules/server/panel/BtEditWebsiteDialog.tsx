import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { Select } from "@/components/ui/form/Select";
import { TextInput } from "@/components/ui/form/TextInput";
import type { TextEditorHandle } from "@/components/textEditor";
import { createBtPanelClient, type BtPhpVersion } from "@/lib/btpanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";
import { WebsiteConfigEditorPane } from "./WebsiteConfigEditorPane";

type Props = {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName: string | null;
  onClose: () => void;
  onUpdated?: () => void;
};

type EditSection = "settings" | "config";

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
  const configRef = useRef<TextEditorHandle>(null);

  const [section, setSection] = useState<EditSection>("settings");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  const [remark, setRemark] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [phpVersions, setPhpVersions] = useState<BtPhpVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setSection("settings");
    setConfigDirty(false);
    setConfigSaving(false);
    setRemark("");
    setPhpVersion("");
    setError(null);
    setBusy(false);
    setLoading(false);
  }, []);

  const handleClose = () => {
    if (busy || configSaving) return;
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
        const versions = await client.getPhpVersions().catch(() => [] as BtPhpVersion[]);
        const phpInfo = await client
          .getSitePhpVersion(siteName)
          .catch(() => ({}) as Record<string, unknown>);
        const sites = await client
          .getWebsiteList({ limit: 200 })
          .catch(() => ({ data: [] as { id?: number; ps?: string }[] }));
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

  const phpOptions = useMemo(() => {
    const options = [
      {
        value: "00",
        label: t("server.create.website.btTypeStatic"),
      },
      ...phpVersions
        .filter((v) => v.version !== "00")
        .map((v) => ({
          value: v.version,
          label: v.name || `PHP ${v.version}`,
        })),
    ];
    if (phpVersion && !options.some((opt) => opt.value === phpVersion)) {
      options.push({ value: phpVersion, label: phpVersion });
    }
    return options;
  }, [phpVersion, phpVersions, t]);

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

  const handleSaveConfig = async () => {
    const editor = configRef.current;
    if (!editor?.canSave()) return;
    setConfigSaving(true);
    setError(null);
    try {
      await editor.save();
      showToast(t("server.websites.configSaveSuccess"));
      setConfigDirty(false);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setConfigSaving(false);
    }
  };

  const primaryAction =
    section === "config"
      ? {
          label: configSaving ? t("common.saving") : t("common.save"),
          disabled: configSaving || busy || !configDirty,
          onClick: () => void handleSaveConfig(),
        }
      : {
          label: busy ? t("common.saving") : t("common.confirm"),
          disabled: busy || configSaving || loading || !canSubmit,
          onClick: () => void handleSubmit(),
        };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.websites.editTitle")}
      size="xl"
      bodyClassName="server-create-split"
      cancelDisabled={busy || configSaving}
      closeDisabled={busy || configSaving}
      primaryAction={primaryAction}
      status={error ? { kind: "error", message: error } : null}
    >
      <nav className="server-create-split__nav" aria-label={t("server.websites.editTitle")}>
        <button
          type="button"
          role="tab"
          aria-selected={section === "settings"}
          className={`server-create-split__nav-item${section === "settings" ? " is-active" : ""}`}
          disabled={busy || configSaving}
          onClick={() => setSection("settings")}
        >
          {t("server.websites.editSettings")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "config"}
          className={`server-create-split__nav-item${section === "config" ? " is-active" : ""}`}
          disabled={busy || configSaving}
          onClick={() => setSection("config")}
        >
          {t("server.websites.config")}
        </button>
      </nav>

      <div className="server-create-split__main" role="tabpanel">
        {section === "settings" ? (
          loading ? (
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
                <Select
                  value={phpVersion || "00"}
                  onChange={setPhpVersion}
                  options={phpOptions}
                  searchable={phpOptions.length >= 8}
                  disabled={busy}
                  placeholder={t("server.create.website.phpVersion")}
                  style={{ width: "100%" }}
                  aria-label={t("server.create.website.phpVersion")}
                />
              </FormField>
            </>
          )
        ) : (
          <WebsiteConfigEditorPane
            ref={configRef}
            open={open}
            enabled={open && section === "config"}
            server={server}
            websiteId={websiteId}
            siteName={siteName}
            onDirtyChange={setConfigDirty}
          />
        )}
      </div>
    </FormDialog>
  );
}
