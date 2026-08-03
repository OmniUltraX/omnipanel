import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/Button";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { IconRefresh, IconSearch } from "../../../../components/ui/icons/Icons";
import {
  createBtPanelClient,
  defaultBtCreateAppExtras,
  pickBtAppVersion,
} from "../../../../lib/btpanel";
import {
  createOnePanelClient,
  type OnePanelApp,
  type OnePanelInstalledApp,
} from "../../../../lib/onepanel";
import { appConfirm } from "../../../../lib/appConfirm";
import { showToast } from "../../../../stores/toastStore";
import type { ServerEntry } from "../serverConnection";
import {
  markServerAppIconsBroken,
  peekServerAppIconCache,
  setServerAppIcons,
} from "../serverAppIconCache";
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

/** 仅 data/blob/内嵌 base64 可直接显示；http(s)/相对路径需走后端代理。 */
function resolveIconSrc(icon: string | undefined, iconCache: Record<string, string>): string | null {
  if (!icon) return null;
  if (icon.startsWith("data:") || icon.startsWith("blob:")) {
    return icon;
  }
  // 部分接口把 icon 直接返回为 base64
  if (!icon.startsWith("/") && !icon.startsWith("http") && /^[A-Za-z0-9+/=]+$/.test(icon) && icon.length > 64) {
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
  const marketSupported = isOnePanel || isBt;

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
  const [installedOnly, setInstalledOnly] = useState(false);
  const [iconCache, setIconCache] = useState<Record<string, string>>(() =>
    peekServerAppIconCache(server.id).icons,
  );
  const [brokenIconKeys, setBrokenIconKeys] = useState<ReadonlySet<string>>(
    () => peekServerAppIconCache(server.id).broken,
  );
  /** 分批拉取图标：每批完成后自增以继续下一批 */
  const [iconLoadTick, setIconLoadTick] = useState(0);
  const iconCacheRef = useRef(iconCache);
  const brokenIconKeysRef = useRef(brokenIconKeys);
  const iconInflightRef = useRef<Set<string>>(new Set());
  iconCacheRef.current = iconCache;
  brokenIconKeysRef.current = brokenIconKeys;
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const error = !marketSupported
    ? t("server.appMarket.unsupported")
    : actionError ?? cacheError;

  /** 同步/刷新应用商店后写入本地缓存。 */
  const handleSyncRemote = useCallback(async () => {
    if (!marketSupported || syncing || refreshing) return;
    setSyncing(true);
    setActionError(null);
    try {
      if (isOnePanel) {
        const client = createOnePanelClient(server.address, server.key, server.id);
        await client.syncAppsRemote();
        showToast(t("server.appMarket.syncSuccess"));
      }
      // 宝塔：force=1 由 refresh → getApps(force) 完成；此处直接刷新缓存
      if (isBt) {
        const client = createBtPanelClient(server.address, server.key, server.id);
        await client.getApps({ p: 1, row: 200, query: "", force: 1, appType: "all" });
        showToast(t("server.appMarket.syncSuccess"));
      }
      await refresh();
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setSyncing(false);
    }
  }, [
    isBt,
    isOnePanel,
    marketSupported,
    refresh,
    refreshing,
    server.address,
    server.id,
    server.key,
    syncing,
    t,
  ]);

  const installedKeys = useMemo(() => buildInstalledKeySet(installedApps), [installedApps]);

  const cards = useMemo<MarketCard[]>(() => {
    return apps
      .filter((app) => appMatchesQuery(app, query))
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
  }, [apps, installedKeys, installedOnly, query]);

  // 切换面板：从会话缓存回填（同面板再进页可瞬时恢复图标）
  useEffect(() => {
    const cached = peekServerAppIconCache(server.id);
    setIconCache(cached.icons);
    setBrokenIconKeys(cached.broken);
    iconInflightRef.current.clear();
    setIconLoadTick(0);
  }, [server.id]);

  // 懒加载缺失图标（1Panel / 宝塔均走后端代理为 data URL）
  useEffect(() => {
    if (!marketSupported || cards.length === 0) return;
    let cancelled = false;

    const missing = cards
      .map((app) => app.key?.trim())
      .filter((key): key is string => Boolean(key))
      .filter((key) => {
        if (brokenIconKeysRef.current.has(key)) return false;
        if (iconCacheRef.current[key]) return false;
        if (iconInflightRef.current.has(key)) return false;
        const app = cards.find((item) => item.key === key);
        if (!app) return false;
        // data:/blob: 可直接显示；相对路径 / http(s) 需代理
        return !resolveIconSrc(app.icon, iconCacheRef.current);
      })
      .slice(0, 16);

    if (missing.length === 0) return;
    for (const key of missing) iconInflightRef.current.add(key);

    void (async () => {
      const next: Record<string, string> = {};
      const failed: string[] = [];
      await Promise.all(
        missing.map(async (key) => {
          try {
            const url = isBt
              ? await createBtPanelClient(server.address, server.key, server.id).getAppIconDataUrl(
                  key,
                )
              : await createOnePanelClient(server.address, server.key, server.id).getAppIconDataUrl(
                  key,
                );
            if (url?.startsWith("data:") || url?.startsWith("blob:")) {
              next[key] = url;
            } else {
              // 非 data URL 在 WebView 中不可靠，视为失败走占位
              failed.push(key);
            }
          } catch {
            failed.push(key);
          } finally {
            iconInflightRef.current.delete(key);
          }
        }),
      );
      if (cancelled) return;
      if (Object.keys(next).length > 0) {
        setServerAppIcons(server.id, next);
        setIconCache((prev) => ({ ...prev, ...next }));
      }
      if (failed.length > 0) {
        markServerAppIconsBroken(server.id, failed);
        setBrokenIconKeys((prev) => {
          const merged = new Set(prev);
          for (const key of failed) merged.add(key);
          return merged;
        });
      }
      // 继续拉取下一批
      setIconLoadTick((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [cards, iconLoadTick, isBt, marketSupported, server.address, server.id, server.key]);

  const handleSearch = () => {
    setQuery(search.trim());
  };

  const handleInstall = useCallback(
    async (app: MarketCard) => {
      if (!marketSupported || installingKey || app.isInstalled) return;
      const label = app.name || app.key;
      const confirmed = await appConfirm(
        t("server.appMarket.installConfirm", { name: label }),
        t("server.appMarket.install"),
      );
      if (!confirmed) return;

      setInstallingKey(app.key);
      setActionError(null);
      try {
        if (isBt) {
          const client = createBtPanelClient(server.address, server.key, server.id);
          const market = await client.getApps({
            p: 1,
            row: 200,
            query: app.key,
            force: 0,
            appType: "all",
          });
          const btApp =
            market.items.find((item) => item.appname === app.key) ??
            market.items.find(
              (item) => item.appname?.toLowerCase() === app.key.toLowerCase(),
            );
          if (!btApp) {
            throw new Error(t("server.appMarket.installNoDetail"));
          }
          const version = pickBtAppVersion(btApp);
          if (!version) {
            throw new Error(t("server.appMarket.installNoVersion"));
          }
          const serviceName = `docker_${btApp.appname}`.replace(/[^a-zA-Z0-9_-]/g, "_");
          await client.createApp({
            appName: btApp.appname,
            serviceName,
            mVersion: version.mVersion,
            sVersion: version.sVersion,
            allowAccess: true,
            disableDomain: true,
            extras: defaultBtCreateAppExtras(btApp),
          });
        } else {
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

          const instanceName = app.key || app.name;
          await client.installApp({
            appDetailId: appDetail.id,
            name: instanceName,
            params: defaultParamsFromDetail(appDetail.params),
            pullImage: true,
            allowPort: true,
          });
        }
        showToast(t("server.appMarket.installSuccess", { name: label }));
        await refresh();
      } catch (err) {
        setActionError(formatError(err));
      } finally {
        setInstallingKey(null);
      }
    },
    [
      installingKey,
      isBt,
      marketSupported,
      refresh,
      server.address,
      server.id,
      server.key,
      t,
    ],
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
            disabled={!marketSupported || busyMeta}
            title={
              syncing || refreshing
                ? t("server.appMarket.syncing")
                : isBt
                  ? t("server.appMarket.refresh")
                  : t("server.appMarket.sync")
            }
            aria-label={
              syncing || refreshing
                ? t("server.appMarket.syncing")
                : isBt
                  ? t("server.appMarket.refresh")
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
              const iconKey = app.key || app.name || String(index);
              const iconSrc =
                brokenIconKeys.has(iconKey)
                  ? null
                  : resolveIconSrc(app.icon, iconCache) ||
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
                          onError={() => {
                            setBrokenIconKeys((prev) => {
                              if (prev.has(iconKey)) return prev;
                              const next = new Set(prev);
                              next.add(iconKey);
                              return next;
                            });
                          }}
                        />
                      ) : (
                        <div className="server-app-card__icon server-app-card__icon--placeholder">
                          {(app.name || app.key || "?").slice(0, 1).toUpperCase()}
                        </div>
                      )}
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
                        disabled={!marketSupported || busy || installingKey != null}
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
