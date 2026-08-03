import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/Button";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { IconRefresh, IconSearch } from "../../../../components/ui/icons/Icons";
import { createBtPanelClient } from "../../../../lib/btpanel";
import {
  createOnePanelClient,
  type OnePanelApp,
  type OnePanelInstalledApp,
} from "../../../../lib/onepanel";
import { appConfirm } from "../../../../lib/appConfirm";
import { showToast } from "../../../../stores/toastStore";
import type { ServerEntry } from "../serverConnection";
import { useServerApps } from "../useServerApps";

interface Props {
  server: ServerEntry;
}

type MarketCard = OnePanelApp & {
  isInstalled: boolean;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function appDescription(app: OnePanelApp, locale: string): string {
  if (locale.startsWith("zh")) {
    return (
      app.shortDescZh ||
      app.description ||
      app.shortDescEn ||
      ""
    ).trim();
  }
  return (
    app.shortDescEn ||
    app.description ||
    app.shortDescZh ||
    ""
  ).trim();
}

function pickLatestVersion(versions: string[] | undefined): string | null {
  if (!versions || versions.length === 0) return null;
  return versions[0] ?? null;
}

/** 从详情 params.formFields 提取默认安装参数。 */
function defaultParamsFromDetail(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const obj = params as Record<string, unknown>;
  const fields = obj.formFields ?? obj.fields;
  if (!Array.isArray(fields)) return {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const f = field as Record<string, unknown>;
    const key = String(f.envKey ?? f.key ?? "").trim();
    if (!key) continue;
    if ("default" in f && f.default !== undefined) {
      out[key] = f.default;
    } else if ("value" in f && f.value !== undefined) {
      out[key] = f.value;
    }
  }
  return out;
}

function buildInstalledKeySet(installed: OnePanelInstalledApp[]): Set<string> {
  const keys = new Set<string>();
  for (const item of installed) {
    const appKey = (item.appKey ?? "").trim().toLowerCase();
    if (appKey) keys.add(appKey);
    const name = (item.name ?? "").trim().toLowerCase();
    if (name) keys.add(name);
  }
  return keys;
}

function resolveIconSrc(
  icon: string | undefined,
  iconCache: Record<string, string>,
  panelBaseUrl?: string,
): string | null {
  if (!icon) return null;
  if (icon.startsWith("data:") || icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("blob:")) {
    return icon;
  }
  if (icon.startsWith("/")) {
    if (!panelBaseUrl) return null;
    try {
      return new URL(icon, panelBaseUrl.endsWith("/") ? panelBaseUrl : `${panelBaseUrl}/`).toString();
    } catch {
      return null;
    }
  }
  // 宝塔软件商店：ico-redis.png → /static/img/soft_ico/...
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(icon) || icon.startsWith("ico-")) {
    if (!panelBaseUrl) return iconCache[icon] ?? null;
    try {
      const base = panelBaseUrl.replace(/\/$/, "");
      return `${base}/static/img/soft_ico/${icon.replace(/^\//, "")}`;
    } catch {
      return null;
    }
  }
  // 部分接口把 icon 直接返回为 base64
  if (/^[A-Za-z0-9+/=]+$/.test(icon) && icon.length > 64) {
    return `data:image/png;base64,${icon}`;
  }
  return iconCache[icon] ?? null;
}

function appMatchesQuery(app: OnePanelApp, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [
    app.name,
    app.key,
    app.type,
    app.description,
    app.shortDescZh,
    app.shortDescEn,
    ...(app.tags ?? []).flatMap((tag) => [tag.name, tag.key]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function ServerAppsTab({ server }: Props) {
  const { t, locale } = useI18n();
  const isOnePanel = server.serviceType === "1panel";
  const isBt = server.serviceType === "bt";
  const supportsApps = isOnePanel || isBt;

  const {
    apps,
    installedApps,
    loading,
    refreshing,
    error: cacheError,
    refresh,
  } = useServerApps(server);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [iconCache, setIconCache] = useState<Record<string, string>>({});
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dockerHint, setDockerHint] = useState<string | null>(null);

  const error = !supportsApps
    ? t("server.appMarket.unsupported")
    : actionError ?? cacheError;

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setCategory("");
    setDockerHint(null);
    setActionError(null);
    setIconCache({});
  }, [server.id]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const app of apps) {
      const type = (app.type || "").trim();
      if (type) set.add(type);
      for (const tag of app.tags ?? []) {
        const name = (tag.name || tag.key || "").trim();
        if (name) set.add(name);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [apps]);

  /** 同步远程应用商店后写入本地缓存（1Panel 有远端同步；宝塔直接刷新列表）。 */
  const handleSyncRemote = useCallback(async () => {
    if (!supportsApps || syncing || refreshing) return;
    setSyncing(true);
    setActionError(null);
    try {
      if (isOnePanel) {
        const client = createOnePanelClient(server.address, server.key, server.id);
        await client.syncAppsRemote();
      } else if (isBt) {
        const client = createBtPanelClient(server.address, server.key, server.id);
        // force=1 触发软件商店远端刷新
        await client.getSoftList({ p: 1, type: 0, query: "", force: 1, row: 50 });
        try {
          await client.getDockerApps();
          setDockerHint(null);
        } catch {
          setDockerHint(t("server.appMarket.dockerStoreHint"));
        }
      }
      showToast(t("server.appMarket.syncSuccess"));
      await refresh();
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setSyncing(false);
    }
  }, [isBt, isOnePanel, refresh, refreshing, server.address, server.id, server.key, supportsApps, syncing, t]);

  const installedKeys = useMemo(() => buildInstalledKeySet(installedApps), [installedApps]);

  const cards = useMemo<MarketCard[]>(() => {
    return apps
      .filter((app) => appMatchesQuery(app, query))
      .filter((app) => {
        if (!category) return true;
        const type = (app.type || "").trim();
        if (type === category) return true;
        return (app.tags ?? []).some(
          (tag) => (tag.name || "").trim() === category || (tag.key || "").trim() === category,
        );
      })
      .map((app) => {
        const key = (app.key || "").trim().toLowerCase();
        const name = (app.name || "").trim().toLowerCase();
        const isInstalled =
          Boolean(app.installed) ||
          (key !== "" && installedKeys.has(key)) ||
          (name !== "" && installedKeys.has(name));
        return { ...app, isInstalled };
      })
      .filter((app) => !installedOnly || app.isInstalled);
  }, [apps, category, installedKeys, installedOnly, query]);

  // 懒加载缺失图标（仅 1Panel 有专用图标接口）
  useEffect(() => {
    if (!isOnePanel || cards.length === 0) return;
    let cancelled = false;
    const client = createOnePanelClient(server.address, server.key, server.id);
    const missing = cards
      .map((app) => app.key?.trim())
      .filter((key): key is string => Boolean(key))
      .filter((key) => {
        const app = cards.find((item) => item.key === key);
        if (!app) return false;
        if (resolveIconSrc(app.icon, iconCache, server.address)) return false;
        return !iconCache[key];
      })
      .slice(0, 24);

    if (missing.length === 0) return;

    void (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        missing.map(async (key) => {
          try {
            const url = await client.getAppIconDataUrl(key);
            if (url) next[key] = url;
          } catch {
            // 图标失败不影响列表
          }
        }),
      );
      if (cancelled || Object.keys(next).length === 0) return;
      setIconCache((prev) => ({ ...prev, ...next }));
    })();

    return () => {
      cancelled = true;
    };
  }, [cards, iconCache, isOnePanel, server.address, server.id, server.key]);

  const handleSearch = () => {
    setQuery(search.trim());
  };

  const handleInstall = useCallback(
    async (app: MarketCard) => {
      if (!supportsApps || installingKey || app.isInstalled) return;
      const label = app.name || app.key;
      const versionHint = pickLatestVersion(app.versions);
      const confirmed = await appConfirm(
        versionHint
          ? t("server.appMarket.installConfirmWithVersion", { name: label, version: versionHint })
          : t("server.appMarket.installConfirm", { name: label }),
        t("server.appMarket.install"),
      );
      if (!confirmed) return;

      setInstallingKey(app.key);
      setActionError(null);
      try {
        if (isBt) {
          const client = createBtPanelClient(server.address, server.key, server.id);
          const version = pickLatestVersion(app.versions) || "";
          // 优先走软件商店安装；找不到版本时再尝试 Docker 商店定义
          if (version) {
            const msg = await client.installSoft(app.key, version);
            showToast(msg || t("server.appMarket.btInstallQueued", { name: label }));
          } else {
            const market = await client.getDockerApps();
            const def = market.items.find(
              (item) =>
                (item.appname || "").trim().toLowerCase() === (app.key || "").trim().toLowerCase(),
            );
            if (!def) {
              throw new Error(t("server.appMarket.btNoAppDefinition"));
            }
            const msg = await client.installDockerAppFromDefinition(def);
            showToast(msg || t("server.appMarket.btInstallQueued", { name: label }));
          }
          try {
            const tasks = await client.getTaskCount();
            if (typeof tasks === "number" && tasks > 0) {
              showToast(t("server.appMarket.btInstallQueued", { name: label }));
            }
          } catch {
            // 任务计数失败不影响安装成功提示
          }
          await refresh();
          return;
        }

        const client = createOnePanelClient(server.address, server.key, server.id);
        let versions = app.versions ?? [];
        let appId = app.id;
        let appType = app.type || "runtime";

        if (versions.length === 0 || !appId) {
          const detail = await client.getApp(app.key);
          versions = detail.versions ?? versions;
          appId = detail.id || appId;
          appType = detail.type || appType;
        }

        const version = pickLatestVersion(versions);
        if (!version || !appId) {
          throw new Error(t("server.appMarket.installNoVersion"));
        }

        const appDetail = await client.getAppDetail(appId, version, appType);
        if (!appDetail.id) {
          throw new Error(t("server.appMarket.installNoDetail"));
        }

        const defaults = defaultParamsFromDetail(appDetail.params);
        const instanceName = app.key || app.name;
        await client.installApp({
          appDetailId: appDetail.id,
          name: instanceName,
          params: defaults,
          pullImage: true,
          allowPort: true,
        });
        showToast(t("server.appMarket.installSuccess", { name: label }));
        await refresh();
      } catch (err) {
        setActionError(formatError(err));
      } finally {
        setInstallingKey(null);
      }
    },
    [installingKey, isBt, refresh, server.address, server.id, server.key, supportsApps, t],
  );

  const busyMeta = loading || refreshing || syncing;

  return (
    <div className="server-panel-tab server-apps server-apps--embedded">
      <div className="server-apps-toolbar">
        <div className="server-apps-toolbar__left">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className="db-tables-panel-meta-refresh-btn"
            disabled={!supportsApps || busyMeta}
            title={
              syncing || refreshing
                ? t("server.appMarket.syncing")
                : t("server.appMarket.sync")
            }
            aria-label={
              syncing || refreshing
                ? t("server.appMarket.syncing")
                : t("server.appMarket.sync")
            }
            onClick={() => void handleSyncRemote()}
          >
            <IconRefresh size={14} />
          </Button>
          <span className="db-tables-panel-meta-text">
            {syncing
              ? t("server.appMarket.syncing")
              : loading || refreshing
                ? t("common.loading")
                : t("server.appMarket.count", { count: cards.length })}
          </span>
        </div>
        <div className="server-apps-toolbar__right">
          {categories.length > 0 ? (
            <select
              className="input server-app-market__category"
              value={category}
              disabled={busyMeta}
              onChange={(event) => setCategory(event.target.value)}
              aria-label={t("server.appMarket.allCategories")}
            >
              <option value="">{t("server.appMarket.allCategories")}</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : null}
          <div className="server-app-market__search">
            <TextInput
              className="input"
              value={search}
              onChange={setSearch}
              placeholder={t("server.appMarket.searchPlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSearch();
              }}
            />
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              title={t("server.appMarket.search")}
              aria-label={t("server.appMarket.search")}
              disabled={busyMeta}
              onClick={handleSearch}
            >
              <IconSearch size={14} />
            </Button>
          </div>
          <label className="form-check server-app-market__installed-filter">
            <input
              type="checkbox"
              checked={installedOnly}
              onChange={(event) => setInstalledOnly(event.target.checked)}
            />
            <span>{t("server.appMarket.installed")}</span>
          </label>
        </div>
      </div>

      {error ? <div className="server-apps-error">{error}</div> : null}
      {dockerHint && !error ? <div className="server-apps-hint">{dockerHint}</div> : null}

      <div className="server-apps-body">
        {loading && cards.length === 0 ? (
          <div className="server-apps-empty">{t("server.appMarket.loading")}</div>
        ) : null}
        {!loading && cards.length === 0 && !error ? (
          <div className="server-apps-empty">{t("server.appMarket.empty")}</div>
        ) : null}
        {cards.length > 0 ? (
          <div className="server-app-grid">
            {cards.map((app, index) => {
              const iconSrc =
                resolveIconSrc(app.icon, iconCache, server.address) ||
                (app.key ? iconCache[app.key] : null);
              const desc = appDescription(app, locale);
              const busy = installingKey === app.key;
              const cardKey = `${app.id || "app"}:${app.key || app.name || index}`;
              return (
                <div key={cardKey} className="server-app-card">
                  <div className="server-app-card__top">
                    <div className="server-app-card__head">
                      {iconSrc ? (
                        <img
                          className="server-app-card__icon"
                          src={iconSrc}
                          alt=""
                          draggable={false}
                          onError={(event) => {
                            (event.currentTarget as HTMLImageElement).style.display = "none";
                            const fallback = event.currentTarget.nextElementSibling;
                            if (fallback instanceof HTMLElement) fallback.style.display = "flex";
                          }}
                        />
                      ) : null}
                      <div
                        className="server-app-card__icon server-app-card__icon--placeholder"
                        style={iconSrc ? { display: "none" } : undefined}
                      >
                        {(app.name || app.key || "?").slice(0, 1).toUpperCase()}
                      </div>
                      <div className="server-app-card__titles">
                        <div className="server-app-card__name" title={app.name || app.key}>
                          {app.name || app.key || "—"}
                        </div>
                        {app.type ? (
                          <div className="server-app-card__instance">{app.type}</div>
                        ) : null}
                      </div>
                    </div>
                    {app.isInstalled ? (
                      <span className="server-app-card__status server-app-card__status--success">
                        {t("server.appMarket.installed")}
                      </span>
                    ) : null}
                  </div>

                  {app.tags && app.tags.length > 0 ? (
                    <div className="server-app-card__tags">
                      {app.tags.map((tag, tagIndex) => {
                        const label = (tag.name || tag.key || "").trim();
                        if (!label) return null;
                        return (
                          <span
                            key={`${cardKey}-tag-${tag.id ?? tag.key ?? label}-${tagIndex}`}
                            className="tag"
                            title={label}
                          >
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}

                  {desc ? <p className="server-app-card__message">{desc}</p> : null}

                  {!app.isInstalled ? (
                    <div className="server-app-card__footer">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!supportsApps || busy || installingKey != null}
                        onClick={() => void handleInstall(app)}
                      >
                        {busy ? t("server.appMarket.installing") : t("server.appMarket.install")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
