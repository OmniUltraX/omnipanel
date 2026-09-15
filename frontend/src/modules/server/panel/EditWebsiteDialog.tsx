import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { Select } from "@/components/ui/form/Select";
import { TextInput } from "@/components/ui/form/TextInput";
import type { TextEditorHandle } from "@/components/textEditor";
import {
  createOnePanelClient,
  type OnePanelGroup,
  type OnePanelWebsiteProxyConfig,
  type OnePanelWebsiteUpdate,
} from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";
import { BtEditWebsiteDialog } from "./BtEditWebsiteDialog";
import { isBtPanelService, isOnePanelService } from "./panelPlugin";
import { WebsiteConfigEditorPane } from "./WebsiteConfigEditorPane";

type EditWebsiteDialogProps = {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  onClose: () => void;
  onUpdated?: () => void;
};

const PROXY_PROTOCOLS = [
  { value: "http://", label: "http://" },
  { value: "https://", label: "https://" },
] as const;

function formatEditError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function splitProxyPass(proxyPass: string): { protocol: string; address: string } {
  const raw = proxyPass.trim();
  if (/^https:\/\//i.test(raw)) {
    return { protocol: "https://", address: raw.replace(/^https:\/\//i, "") };
  }
  if (/^http:\/\//i.test(raw)) {
    return { protocol: "http://", address: raw.replace(/^http:\/\//i, "") };
  }
  return { protocol: "http://", address: raw };
}

function pickPrimaryProxy(
  proxies: OnePanelWebsiteProxyConfig[],
): OnePanelWebsiteProxyConfig | null {
  if (proxies.length === 0) return null;
  const root =
    proxies.find((item) => item.match === "/" || item.match === "") ??
    proxies.find((item) => item.enable !== false) ??
    proxies[0];
  return root ?? null;
}

export function EditWebsiteDialog({
  open,
  server,
  websiteId,
  siteName = null,
  onClose,
  onUpdated,
}: EditWebsiteDialogProps) {
  if (isBtPanelService(server.serviceType)) {
    return (
      <BtEditWebsiteDialog
        open={open}
        server={server}
        websiteId={websiteId}
        siteName={siteName}
        onClose={onClose}
        onUpdated={onUpdated}
      />
    );
  }
  return (
    <OnePanelEditWebsiteDialog
      open={open}
      server={server}
      websiteId={websiteId}
      siteName={siteName}
      onClose={onClose}
      onUpdated={onUpdated}
    />
  );
}

type EditSection = "settings" | "config";

function OnePanelEditWebsiteDialog({
  open,
  server,
  websiteId,
  siteName = null,
  onClose,
  onUpdated,
}: EditWebsiteDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);
  const configRef = useRef<TextEditorHandle>(null);

  const [section, setSection] = useState<EditSection>("settings");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  const [primaryDomain, setPrimaryDomain] = useState("");
  const [remark, setRemark] = useState("");
  const [groupId, setGroupId] = useState(0);
  const [ipv6, setIpv6] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [expireDate, setExpireDate] = useState("");
  const [websiteType, setWebsiteType] = useState("");
  const [proxyProtocol, setProxyProtocol] = useState("http://");
  const [proxyAddress, setProxyAddress] = useState("");
  const [proxyConfig, setProxyConfig] = useState<OnePanelWebsiteProxyConfig | null>(null);

  const [groups, setGroups] = useState<OnePanelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isProxySite = websiteType === "proxy";

  const reset = useCallback(() => {
    setSection("settings");
    setConfigDirty(false);
    setConfigSaving(false);
    setPrimaryDomain("");
    setRemark("");
    setGroupId(0);
    setIpv6(false);
    setFavorite(false);
    setExpireDate("");
    setWebsiteType("");
    setProxyProtocol("http://");
    setProxyAddress("");
    setProxyConfig(null);
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
        const [detail, groupList] = await Promise.all([
          client.getWebsite(websiteId),
          client.searchGroups("website").catch(() => [] as OnePanelGroup[]),
        ]);
        if (cancelled) return;
        setGroups(groupList);
        setPrimaryDomain(
          asString(detail.primaryDomain ?? detail.primary_domain ?? detail.alias),
        );
        setRemark(asString(detail.remark));
        const loadedGroupId = asNumber(
          detail.webSiteGroupId ??
            detail.websiteGroupId ??
            detail.webSiteGroupID ??
            detail.websiteGroupID ??
            detail.groupID ??
            detail.groupId,
        );
        const fallbackGroup =
          groupList.find((g) => g.isDefault)?.id ?? groupList[0]?.id ?? 1;
        setGroupId(loadedGroupId > 0 ? loadedGroupId : fallbackGroup);
        setIpv6(asBool(detail.IPV6 ?? detail.ipv6));
        setFavorite(asBool(detail.favorite));
        const expire = asString(detail.expireDate ?? detail.expire_date);
        setExpireDate(expire.slice(0, 10));

        const type = asString(detail.type).toLowerCase();
        setWebsiteType(type);

        if (type === "proxy") {
          const proxies = await client.getWebsiteProxies(websiteId).catch(() => []);
          if (cancelled) return;
          const primary = pickPrimaryProxy(proxies);
          const fromDetail = asString(detail.proxy);
          const proxyPass = primary?.proxyPass?.trim() || fromDetail;
          const split = splitProxyPass(proxyPass);
          setProxyProtocol(split.protocol);
          setProxyAddress(split.address);
          setProxyConfig(primary);
        } else {
          setProxyProtocol("http://");
          setProxyAddress("");
          setProxyConfig(null);
        }
      } catch (err) {
        if (!cancelled) setError(formatEditError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, websiteId]);

  const groupOptions = useMemo(() => {
    if (groups.length === 0) {
      return [
        {
          value: "0",
          label: t("server.create.website.groupDefault"),
          disabled: true,
        },
      ];
    }
    return groups.map((group) => ({
      value: String(group.id),
      label:
        group.name === "Default" ? t("server.create.website.groupDefault") : group.name,
    }));
  }, [groups, t]);

  const canSubmit = useMemo(() => {
    if (!(websiteId != null && primaryDomain.trim() && groupId > 0)) return false;
    if (isProxySite && !proxyAddress.trim()) return false;
    return true;
  }, [websiteId, primaryDomain, groupId, isProxySite, proxyAddress]);

  const handleSubmit = async () => {
    if (!isOnePanelService(server.serviceType) || websiteId == null) {
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
      const client = createOnePanelClient(
        server.address,
        server.key,
        server.id,
        server.panelUser,
      );
      const body: OnePanelWebsiteUpdate = {
        id: websiteId,
        primaryDomain: primaryDomain.trim(),
        remark: remark.trim(),
        webSiteGroupId: groupId,
        IPV6: ipv6,
        favorite,
      };
      if (expireDate.trim()) {
        body.expireDate = expireDate.trim();
      }
      await client.updateWebsite(body);

      if (isProxySite) {
        const nextPass = `${proxyProtocol}${proxyAddress.trim()}`;
        if (proxyConfig) {
          await client.updateWebsiteProxy({
            ...proxyConfig,
            id: websiteId,
            operate: "edit",
            proxyPass: nextPass,
            replaces: proxyConfig.replaces ?? {},
          });
        } else {
          // 无现成代理条目时按官方面板默认值新建一条根路径反代
          const alias = asString(primaryDomain).replace(/[^a-zA-Z0-9._-]+/g, "_") || "proxy";
          await client.updateWebsiteProxy({
            id: websiteId,
            operate: "create",
            enable: true,
            cache: false,
            cacheTime: 1,
            cacheUnit: "m",
            name: alias.slice(0, 64),
            modifier: "^~",
            match: "/",
            proxyPass: nextPass,
            proxyHost: "$host",
            replaces: {},
            sni: false,
            proxySSLName: "",
          });
        }
      }

      showToast(t("server.websites.editSuccess"));
      await refreshServer(server);
      reset();
      onClose();
      onUpdated?.();
    } catch (err) {
      setError(formatEditError(err));
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
      setError(formatEditError(err));
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
                <TextInput
                  value={primaryDomain}
                  onChange={setPrimaryDomain}
                  placeholder="example.com"
                  disabled={busy}
                />
              </FormField>

              <FormField label={t("server.create.website.group")}>
                <Select
                  value={groupId > 0 ? String(groupId) : ""}
                  onChange={(value) => setGroupId(Number(value) || 0)}
                  options={groupOptions}
                  searchable={groups.length >= 8}
                  disabled={busy || groups.length === 0}
                  placeholder={t("server.create.website.group")}
                  emptyText={t("server.create.website.groupDefault")}
                  style={{ width: "100%" }}
                  aria-label={t("server.create.website.group")}
                />
              </FormField>

              {isProxySite ? (
                <FormField label={t("server.create.website.proxyAddress")}>
                  <div className="server-create-website-proxy-row">
                    <Select
                      value={proxyProtocol}
                      onChange={setProxyProtocol}
                      options={[...PROXY_PROTOCOLS]}
                      searchable={false}
                      disabled={busy}
                      style={{ width: "100%" }}
                      aria-label={t("server.create.website.proxyAddress")}
                    />
                    <TextInput
                      value={proxyAddress}
                      onChange={setProxyAddress}
                      placeholder="127.0.0.1:8080"
                      disabled={busy}
                    />
                  </div>
                </FormField>
              ) : null}

              <FormField
                label={t("server.websites.expireDate")}
                hint={t("server.websites.expireDateHint")}
              >
                <TextInput
                  value={expireDate}
                  onChange={setExpireDate}
                  placeholder="2099-12-31"
                  disabled={busy}
                />
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

              <label className="server-create-website-check">
                <input
                  type="checkbox"
                  checked={favorite}
                  disabled={busy}
                  onChange={(e) => setFavorite(e.target.checked)}
                />
                <span>{t("server.websites.favorite")}</span>
              </label>

              <FormField label={t("server.create.remark")}>
                <TextInput
                  value={remark}
                  onChange={setRemark}
                  placeholder={t("server.create.remarkPlaceholder")}
                  disabled={busy}
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
