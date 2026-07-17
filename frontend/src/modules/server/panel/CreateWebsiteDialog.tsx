import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import { Button } from "@/components/ui/primitives/Button";
import {
  createOnePanelClient,
  type OnePanelGroup,
  type OnePanelInstalledApp,
  type OnePanelRuntime,
  type OnePanelWebsiteCreate,
  type OnePanelWebsiteType,
} from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import { certificateRowLabel } from "./serverResourceLabels";
import type { ServerEntry } from "./serverConnection";

const WEBSITE_TYPES: OnePanelWebsiteType[] = [
  "static",
  "runtime",
  "deployment",
  "proxy",
  "stream",
  "subsite",
];

const RUNTIME_LANGS = ["php", "node", "java", "go", "python", "dotnet"] as const;

type ExtraDomainRow = { id: string; domain: string; port: string };
type UpstreamRow = { id: string; server: string };

type CreateWebsiteDialogProps = {
  open: boolean;
  server: ServerEntry;
  onClose: () => void;
  onCreated?: () => void;
};

function formatCreateError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function aliasFromDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .split(":")[0]
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\./g, "_")
    .slice(0, 64);
}

function newRowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePositiveInt(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function CreateWebsiteDialog({
  open,
  server,
  onClose,
  onCreated,
}: CreateWebsiteDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const [type, setType] = useState<OnePanelWebsiteType>("static");
  const [groupId, setGroupId] = useState(1);
  const [domain, setDomain] = useState("");
  const [port, setPort] = useState("80");
  const [extraDomains, setExtraDomains] = useState<ExtraDomainRow[]>([]);
  const [ipv6, setIpv6] = useState(false);
  const [alias, setAlias] = useState("");
  const [remark, setRemark] = useState("");
  const [enableSsl, setEnableSsl] = useState(false);
  const [sslId, setSslId] = useState(0);

  const [proxyProtocol, setProxyProtocol] = useState("http://");
  const [proxyAddress, setProxyAddress] = useState("");

  const [runtimeLang, setRuntimeLang] = useState<string>("php");
  const [runtimeId, setRuntimeId] = useState(0);
  const [phpProxyType, setPhpProxyType] = useState<"unix" | "tcp">("unix");
  const [runtimePort, setRuntimePort] = useState("9000");

  const [appInstallId, setAppInstallId] = useState(0);

  const [streamPorts, setStreamPorts] = useState("");
  const [udp, setUdp] = useState(false);
  const [upstreams, setUpstreams] = useState<UpstreamRow[]>([
    { id: newRowId(), server: "" },
  ]);

  const [parentWebsiteId, setParentWebsiteId] = useState(0);
  const [siteDir, setSiteDir] = useState("");

  const [groups, setGroups] = useState<OnePanelGroup[]>([]);
  const [runtimes, setRuntimes] = useState<OnePanelRuntime[]>([]);
  const [apps, setApps] = useState<OnePanelInstalledApp[]>([]);
  const [certificates, setCertificates] = useState<
    Array<{ id: number; label: string }>
  >([]);
  const [parentSites, setParentSites] = useState<
    Array<{ id: number; label: string }>
  >([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setType("static");
    setGroupId(1);
    setDomain("");
    setPort("80");
    setExtraDomains([]);
    setIpv6(false);
    setAlias("");
    setRemark("");
    setEnableSsl(false);
    setSslId(0);
    setProxyProtocol("http://");
    setProxyAddress("");
    setRuntimeLang("php");
    setRuntimeId(0);
    setPhpProxyType("unix");
    setRuntimePort("9000");
    setAppInstallId(0);
    setStreamPorts("");
    setUdp(false);
    setUpstreams([{ id: newRowId(), server: "" }]);
    setParentWebsiteId(0);
    setSiteDir("");
    setError(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleDomainChange = (value: string) => {
    setDomain(value);
    if (!alias.trim() || alias === aliasFromDomain(domain)) {
      setAlias(aliasFromDomain(value));
    }
  };

  const showDomains = type !== "stream";

  // 打开时加载分组 / 证书 / 父站；类型切换时加载 runtime / app
  useEffect(() => {
    if (!open || server.serviceType !== "1panel") return;
    let cancelled = false;
    setOptionsLoading(true);
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const [groupList, certList, siteList] = await Promise.all([
          client.searchGroups("website").catch(() => [] as OnePanelGroup[]),
          client.searchCertificates().catch(() => [] as unknown[]),
          client.searchWebsites({ pageSize: 200 }).catch(() => [] as unknown[]),
        ]);
        if (cancelled) return;

        setGroups(groupList);
        if (groupList.length > 0) {
          const preferred =
            groupList.find((g) => g.isDefault) ?? groupList[0];
          setGroupId(preferred.id);
        }

        const certs = certList
          .filter(
            (row): row is Record<string, unknown> =>
              Boolean(row) && typeof row === "object",
          )
          .map((row) => ({
            id: Number(row.id ?? 0),
            label: certificateRowLabel(row),
          }))
          .filter((row) => row.id > 0);
        setCertificates(certs);
        if (certs.length > 0) setSslId(certs[0].id);

        const parents = siteList
          .filter(
            (row): row is Record<string, unknown> =>
              Boolean(row) && typeof row === "object",
          )
          .map((row) => ({
            id: Number(row.id ?? 0),
            label: String(
              row.primaryDomain ?? row.alias ?? row.name ?? row.id ?? "",
            ),
          }))
          .filter((row) => row.id > 0 && row.label);
        setParentSites(parents);
        if (parents.length > 0) setParentWebsiteId(parents[0].id);
      } catch (err) {
        if (!cancelled) setError(formatCreateError(err));
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server]);

  useEffect(() => {
    if (!open || server.serviceType !== "1panel") return;
    if (type !== "runtime") return;
    let cancelled = false;
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const status = runtimeLang === "php" ? "normal" : "running";
        const list = await client.searchRuntimes({
          type: runtimeLang,
          status,
          pageSize: 100,
        });
        if (cancelled) return;
        setRuntimes(list);
        setRuntimeId(list[0]?.id ?? 0);
      } catch {
        if (!cancelled) {
          setRuntimes([]);
          setRuntimeId(0);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, type, runtimeLang]);

  useEffect(() => {
    if (!open || server.serviceType !== "1panel") return;
    if (type !== "deployment") return;
    let cancelled = false;
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const result = await client.searchInstalledApps({
          type: "website",
          unused: true,
          all: true,
          pageSize: 100,
        });
        if (cancelled) return;
        setApps(result.items);
        setAppInstallId(result.items[0]?.id ?? 0);
      } catch {
        if (!cancelled) {
          setApps([]);
          setAppInstallId(0);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, type]);

  const selectedRuntime = useMemo(
    () => runtimes.find((r) => r.id === runtimeId) ?? null,
    [runtimes, runtimeId],
  );

  const canSubmit = useMemo(() => {
    if (type === "stream") {
      return (
        streamPorts.trim().length > 0 &&
        upstreams.some((u) => u.server.trim().length > 0)
      );
    }
    if (!domain.trim()) return false;
    if (type === "proxy" && !proxyAddress.trim()) return false;
    if (type === "runtime" && !runtimeId) return false;
    if (type === "deployment" && !appInstallId) return false;
    if (type === "subsite" && (!parentWebsiteId || !siteDir.trim())) return false;
    if (enableSsl && !sslId) return false;
    return true;
  }, [
    type,
    streamPorts,
    upstreams,
    domain,
    proxyAddress,
    runtimeId,
    appInstallId,
    parentWebsiteId,
    siteDir,
    enableSsl,
    sslId,
  ]);

  const handleSubmit = async () => {
    // 别名非必填：优先用用户输入，否则由主域名推导；stream 无域名时用端口生成
    const siteAlias = (
      alias.trim() ||
      aliasFromDomain(domain) ||
      (type === "stream" ? aliasFromDomain(`stream-${streamPorts}`) : "")
    ).trim();
    if (!siteAlias) {
      setError(t("server.create.website.required"));
      return;
    }
    if (server.serviceType !== "1panel") {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    if (!canSubmit) {
      setError(t("server.create.website.required"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      const body: OnePanelWebsiteCreate = {
        type,
        alias: siteAlias,
        remark: remark.trim(),
        webSiteGroupId: groupId || 1,
        IPV6: ipv6,
        enableSSL: enableSsl,
        websiteSSLID: enableSsl ? sslId : 0,
        appType: "installed",
        appInstallId: type === "deployment" ? appInstallId : 0,
        proxy: "",
        proxyType: "",
        ftpUser: "",
        ftpPassword: "",
        taskID: crypto.randomUUID(),
      };

      if (showDomains) {
        const primaryPort = parsePositiveInt(port, 80);
        body.domains = [
          {
            domain: domain.trim(),
            port: primaryPort,
            ssl: enableSsl,
          },
          ...extraDomains
            .filter((row) => row.domain.trim())
            .map((row) => ({
              domain: row.domain.trim(),
              port: parsePositiveInt(row.port, primaryPort),
              ssl: enableSsl,
            })),
        ];
      }

      if (type === "proxy") {
        body.proxy = `${proxyProtocol}${proxyAddress.trim()}`;
      }

      if (type === "runtime") {
        body.runtimeID = runtimeId;
        if (runtimeLang === "php") {
          body.proxyType = phpProxyType;
          if (phpProxyType === "tcp") {
            body.port = parsePositiveInt(runtimePort, 9000);
          }
        }
      }

      if (type === "stream") {
        body.streamPorts = streamPorts.trim();
        body.udp = udp;
        body.servers = upstreams
          .map((row) => row.server.trim())
          .filter(Boolean)
          .map((serverAddr) => ({ server: serverAddr, weight: 1 }));
      }

      if (type === "subsite") {
        body.parentWebsiteID = parentWebsiteId;
        body.siteDir = siteDir.trim();
      }

      await client.createWebsite(body);
      await refreshServer(server);
      showToast(t("server.create.website.success"));
      reset();
      onClose();
      onCreated?.();
    } catch (err) {
      setError(formatCreateError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.create.website.title")}
      size="xl"
      clipboardAssist={false}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || !canSubmit || optionsLoading,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
      bodyClassName="server-create-split"
    >
      <nav className="server-create-split__nav" aria-label={t("server.create.website.type")}>
        {WEBSITE_TYPES.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={type === key}
            className={`server-create-split__nav-item${type === key ? " is-active" : ""}`}
            disabled={busy}
            onClick={() => setType(key)}
          >
            {t(`server.websites.types.${key}` as "server.websites.types.static")}
          </button>
        ))}
      </nav>

      <div className="server-create-split__main" role="tabpanel">
      <FormField label={t("server.create.website.group")}>
        <select
          className="input"
          value={groupId}
          disabled={busy || optionsLoading}
          onChange={(e) => setGroupId(Number(e.target.value) || 1)}
        >
          {groups.length === 0 ? (
            <option value={1}>{t("server.create.website.groupDefault")}</option>
          ) : (
            groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))
          )}
        </select>
      </FormField>

      {showDomains ? (
        <>
          <div className="server-create-website-domain-row">
            <FormField label={t("server.create.website.domain")}>
              <TextInput
                value={domain}
                onChange={handleDomainChange}
                placeholder="example.com"
                disabled={busy}
              />
            </FormField>
            <FormField label={t("server.create.website.port")}>
              <TextInput value={port} onChange={setPort} placeholder="80" disabled={busy} />
            </FormField>
          </div>

          <FormField
            label={t("server.create.website.otherDomains")}
            hint={t("server.create.website.otherDomainsHint")}
          >
            <div className="server-create-website-extra-list">
              {extraDomains.map((row) => (
                <div key={row.id} className="server-create-website-domain-row">
                  <TextInput
                    value={row.domain}
                    onChange={(value) =>
                      setExtraDomains((prev) =>
                        prev.map((item) =>
                          item.id === row.id ? { ...item, domain: value } : item,
                        ),
                      )
                    }
                    placeholder="www.example.com"
                    disabled={busy}
                  />
                  <TextInput
                    value={row.port}
                    onChange={(value) =>
                      setExtraDomains((prev) =>
                        prev.map((item) =>
                          item.id === row.id ? { ...item, port: value } : item,
                        ),
                      )
                    }
                    placeholder="80"
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setExtraDomains((prev) => prev.filter((item) => item.id !== row.id))
                    }
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setExtraDomains((prev) => [
                    ...prev,
                    { id: newRowId(), domain: "", port: port || "80" },
                  ])
                }
              >
                {t("server.create.website.addDomain")}
              </Button>
            </div>
          </FormField>

          <label className="server-create-website-check">
            <input
              type="checkbox"
              checked={ipv6}
              disabled={busy}
              onChange={(e) => setIpv6(e.target.checked)}
            />
            <span>{t("server.create.website.ipv6")}</span>
          </label>
        </>
      ) : null}

      <FormField label={t("server.create.website.alias")} hint={t("server.create.website.aliasHint")}>
        <TextInput value={alias} onChange={setAlias} disabled={busy} />
      </FormField>

      <FormField label={t("server.create.remark")}>
        <TextInput
          value={remark}
          onChange={setRemark}
          placeholder={t("server.create.remarkPlaceholder")}
          disabled={busy}
        />
      </FormField>

      {type === "proxy" ? (
        <FormField label={t("server.create.website.proxyAddress")}>
          <div className="server-create-website-proxy-row">
            <select
              className="input"
              value={proxyProtocol}
              disabled={busy}
              onChange={(e) => setProxyProtocol(e.target.value)}
            >
              <option value="http://">http://</option>
              <option value="https://">https://</option>
            </select>
            <TextInput
              value={proxyAddress}
              onChange={setProxyAddress}
              placeholder="127.0.0.1:8080"
              disabled={busy}
            />
          </div>
        </FormField>
      ) : null}

      {type === "runtime" ? (
        <>
          <FormField label={t("server.create.website.runtimeLang")}>
            <select
              className="input"
              value={runtimeLang}
              disabled={busy}
              onChange={(e) => setRuntimeLang(e.target.value)}
            >
              {RUNTIME_LANGS.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={t("server.create.website.runtime")}>
            <select
              className="input"
              value={runtimeId}
              disabled={busy || runtimes.length === 0}
              onChange={(e) => setRuntimeId(Number(e.target.value) || 0)}
            >
              {runtimes.length === 0 ? (
                <option value={0}>{t("server.create.website.runtimeEmpty")}</option>
              ) : (
                runtimes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.name}
                    {rt.version ? ` (${rt.version})` : ""}
                  </option>
                ))
              )}
            </select>
          </FormField>
          {runtimeLang === "php" ? (
            <>
              <FormField label={t("server.create.website.phpProxyType")}>
                <select
                  className="input"
                  value={phpProxyType}
                  disabled={busy}
                  onChange={(e) =>
                    setPhpProxyType(e.target.value === "tcp" ? "tcp" : "unix")
                  }
                >
                  <option value="unix">unix</option>
                  <option value="tcp">tcp</option>
                </select>
              </FormField>
              {phpProxyType === "tcp" ? (
                <FormField label={t("server.create.website.runtimePort")}>
                  <TextInput
                    value={runtimePort}
                    onChange={setRuntimePort}
                    placeholder="9000"
                    disabled={busy}
                  />
                </FormField>
              ) : null}
            </>
          ) : null}
          {selectedRuntime?.resource ? (
            <p className="form-hint">
              {t("server.create.website.runtimeResource")}: {selectedRuntime.resource}
            </p>
          ) : null}
        </>
      ) : null}

      {type === "deployment" ? (
        <FormField label={t("server.create.website.appInstalled")}>
          <select
            className="input"
            value={appInstallId}
            disabled={busy || apps.length === 0}
            onChange={(e) => setAppInstallId(Number(e.target.value) || 0)}
          >
            {apps.length === 0 ? (
              <option value={0}>{t("server.create.website.appEmpty")}</option>
            ) : (
              apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                  {app.version ? ` (${app.version})` : ""}
                </option>
              ))
            )}
          </select>
        </FormField>
      ) : null}

      {type === "stream" ? (
        <>
          <FormField
            label={t("server.create.website.streamPorts")}
            hint={t("server.create.website.streamPortsHint")}
          >
            <TextInput
              value={streamPorts}
              onChange={setStreamPorts}
              placeholder="3306,6379"
              disabled={busy}
            />
          </FormField>
          <label className="server-create-website-check">
            <input
              type="checkbox"
              checked={udp}
              disabled={busy}
              onChange={(e) => setUdp(e.target.checked)}
            />
            <span>{t("server.create.website.udp")}</span>
          </label>
          <FormField label={t("server.create.website.upstreams")}>
            <div className="server-create-website-extra-list">
              {upstreams.map((row) => (
                <div key={row.id} className="server-create-website-domain-row">
                  <TextInput
                    value={row.server}
                    onChange={(value) =>
                      setUpstreams((prev) =>
                        prev.map((item) =>
                          item.id === row.id ? { ...item, server: value } : item,
                        ),
                      )
                    }
                    placeholder="127.0.0.1:3306"
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || upstreams.length <= 1}
                    onClick={() =>
                      setUpstreams((prev) => prev.filter((item) => item.id !== row.id))
                    }
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setUpstreams((prev) => [...prev, { id: newRowId(), server: "" }])
                }
              >
                {t("server.create.website.addUpstream")}
              </Button>
            </div>
          </FormField>
        </>
      ) : null}

      {type === "subsite" ? (
        <>
          <FormField label={t("server.create.website.parentWebsite")}>
            <select
              className="input"
              value={parentWebsiteId}
              disabled={busy || parentSites.length === 0}
              onChange={(e) => setParentWebsiteId(Number(e.target.value) || 0)}
            >
              {parentSites.length === 0 ? (
                <option value={0}>{t("server.create.website.parentEmpty")}</option>
              ) : (
                parentSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.label}
                  </option>
                ))
              )}
            </select>
          </FormField>
          <FormField
            label={t("server.create.website.siteDir")}
            hint={t("server.create.website.siteDirHint")}
          >
            <TextInput
              value={siteDir}
              onChange={setSiteDir}
              placeholder="/blog"
              disabled={busy}
            />
          </FormField>
        </>
      ) : null}

      {showDomains ? (
        <>
          <label className="server-create-website-check">
            <input
              type="checkbox"
              checked={enableSsl}
              disabled={busy}
              onChange={(e) => setEnableSsl(e.target.checked)}
            />
            <span>{t("server.create.website.enableSsl")}</span>
          </label>
          {enableSsl ? (
            <FormField label={t("server.create.website.certificate")}>
              <select
                className="input"
                value={sslId}
                disabled={busy || certificates.length === 0}
                onChange={(e) => setSslId(Number(e.target.value) || 0)}
              >
                {certificates.length === 0 ? (
                  <option value={0}>{t("server.create.website.certificateEmpty")}</option>
                ) : (
                  certificates.map((cert) => (
                    <option key={cert.id} value={cert.id}>
                      {cert.label}
                    </option>
                  ))
                )}
              </select>
            </FormField>
          ) : null}
        </>
      ) : null}
      </div>
    </FormDialog>
  );
}
