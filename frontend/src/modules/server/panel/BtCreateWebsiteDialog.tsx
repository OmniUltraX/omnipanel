import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { createBtPanelClient, type BtPhpVersion, type BtSiteType } from "@/lib/btpanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
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

export function BtCreateWebsiteDialog({ open, server, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const [domain, setDomain] = useState("");
  const [port, setPort] = useState("80");
  const [path, setPath] = useState("");
  const [siteKind, setSiteKind] = useState<"php" | "static">("php");
  const [phpVersion, setPhpVersion] = useState("00");
  const [typeId, setTypeId] = useState(0);
  const [remark, setRemark] = useState("");
  const [createDb, setCreateDb] = useState(false);
  const [dbUser, setDbUser] = useState("");
  const [dbPassword, setDbPassword] = useState("");

  const [phpVersions, setPhpVersions] = useState<BtPhpVersion[]>([]);
  const [siteTypes, setSiteTypes] = useState<BtSiteType[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDomain("");
    setPort("80");
    setPath("");
    setSiteKind("php");
    setPhpVersion("00");
    setTypeId(0);
    setRemark("");
    setCreateDb(false);
    setDbUser("");
    setDbPassword("");
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
        const client = createBtPanelClient(server.address, server.key);
        const [versions, types] = await Promise.all([
          client.getPhpVersions().catch(() => [] as BtPhpVersion[]),
          client.getSiteTypes().catch(() => [] as BtSiteType[]),
        ]);
        if (cancelled) return;
        setPhpVersions(versions);
        setSiteTypes(types);
        const preferred =
          versions.find((v) => v.version !== "00") ?? versions[0];
        if (preferred) setPhpVersion(preferred.version);
        if (types[0]) setTypeId(types[0].id);
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

  useEffect(() => {
    const d = domain.trim().toLowerCase();
    if (!d) return;
    setPath((prev) => {
      if (prev && !prev.endsWith(d) && prev !== `/www/wwwroot/${d}`) return prev;
      return `/www/wwwroot/${d}`;
    });
  }, [domain]);

  const canSubmit = useMemo(() => {
    if (!domain.trim() || !path.trim()) return false;
    if (siteKind === "php" && (!phpVersion || phpVersion === "00")) return false;
    if (createDb && (!dbUser.trim() || !dbPassword.trim())) return false;
    return true;
  }, [domain, path, siteKind, phpVersion, createDb, dbUser, dbPassword]);

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(t("server.create.website.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createBtPanelClient(server.address, server.key);
      const version = siteKind === "static" ? "00" : phpVersion;
      await client.addSite({
        domain: domain.trim(),
        path: path.trim(),
        type: siteKind === "static" ? "" : "PHP",
        version,
        port: port.trim() || "80",
        typeId,
        ps: remark.trim(),
        sql: createDb,
        datauser: createDb ? dbUser.trim() : undefined,
        datapassword: createDb ? dbPassword : undefined,
      });
      showToast(t("server.create.website.success"));
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
      title={t("server.create.website.title")}
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
      {optionsLoading ? <p className="form-hint">{t("common.loading")}</p> : null}

      <FormField label={t("server.create.website.domain")}>
        <TextInput
          value={domain}
          onChange={setDomain}
          placeholder="example.com"
          disabled={busy}
        />
      </FormField>

      <div className="server-create-website-domain-row">
        <FormField label={t("server.create.website.port")}>
          <TextInput value={port} onChange={setPort} placeholder="80" disabled={busy} />
        </FormField>
        <FormField label={t("server.create.website.btType")}>
          <select
            className="input"
            value={siteKind}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value === "static" ? "static" : "php";
              setSiteKind(next);
              if (next === "static") setPhpVersion("00");
            }}
          >
            <option value="php">{t("server.create.website.btTypePhp")}</option>
            <option value="static">{t("server.create.website.btTypeStatic")}</option>
          </select>
        </FormField>
      </div>

      {siteKind === "php" ? (
        <FormField label={t("server.create.website.phpVersion")}>
          <select
            className="input"
            value={phpVersion}
            disabled={busy || phpVersions.length === 0}
            onChange={(e) => setPhpVersion(e.target.value)}
          >
            {phpVersions.length === 0 ? (
              <option value="00">{t("server.create.website.phpEmpty")}</option>
            ) : (
              phpVersions
                .filter((v) => v.version !== "00")
                .map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.name || `PHP ${v.version}`}
                  </option>
                ))
            )}
          </select>
        </FormField>
      ) : null}

      <FormField label={t("server.create.website.path")}>
        <TextInput
          value={path}
          onChange={setPath}
          placeholder="/www/wwwroot/example.com"
          disabled={busy}
        />
      </FormField>

      <FormField label={t("server.create.website.group")}>
        <select
          className="input"
          value={typeId}
          disabled={busy}
          onChange={(e) => setTypeId(Number(e.target.value))}
        >
          <option value={0}>{t("server.create.website.groupDefault")}</option>
          {siteTypes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
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

      <label className="server-create-website-check">
        <input
          type="checkbox"
          checked={createDb}
          disabled={busy}
          onChange={(e) => setCreateDb(e.target.checked)}
        />
        <span>{t("server.create.website.createDb")}</span>
      </label>

      {createDb ? (
        <div className="server-create-website-domain-row">
          <FormField label={t("server.create.database.user")}>
            <TextInput value={dbUser} onChange={setDbUser} disabled={busy} />
          </FormField>
          <FormField label={t("server.create.database.password")}>
            <TextInput
              value={dbPassword}
              onChange={setDbPassword}
              disabled={busy}
            />
          </FormField>
        </div>
      ) : null}
    </FormDialog>
  );
}
