import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedModuleTab } from "../../../../hooks/usePersistedModuleTab";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/Button";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { IconRefresh, IconSearch } from "../../../../components/ui/icons/Icons";
import { isBtPanelAuthFailureMessage } from "../../../../lib/btpanel";
import { panelHasCapability, isBtPanelService } from "../panelPlugin";
import {
  getPanelDriver,
  panelConnectionCtx,
} from "../../../../lib/panelDriverRegistry";
import type { OnePanelApp, OnePanelAppInstalledParams, OnePanelInstalledApp } from "../../../../lib/onepanel";
import { stripHtmlToPlainText } from "../../../../lib/stripHtmlToPlainText";
import { appConfirm } from "../../../../lib/appConfirm";
import { quickInput } from "../../../../lib/quickInput";
import { showToast } from "../../../../stores/toastStore";
import type { ServerEntry } from "../serverConnection";
import {
  markServerAppIconsBroken,
  peekServerAppIconCache,
  setServerAppIcons,
} from "../serverAppIconCache";
import { useServerApps } from "../useServerApps";
import { AppInstallLogDialog } from "../AppInstallLogDialog";
import { AppInstalledParamsDialog } from "../AppInstalledParamsDialog";
import {
  defaultPanelAppConnectionName,
  importPanelAppToDatabase,
  isPanelAppManagedByDatabase,
} from "../importPanelAppToDatabase";
import {
  findInstalledAppForMarket,
  isAppInstallInProgress,
  readInstalledAppStatus,
  resolveAppInstallDisplayState,
  type AppInstallDisplayState,
} from "../serverAppInstallStatus";

interface Props {
  server: ServerEntry;
}

const INSTALLED_FILTER_TABS = ["all", "installed"] as const;

type MarketCard = OnePanelApp & {
  installState: AppInstallDisplayState;
  installId?: number;
  installMessage?: string;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function appDescription(app: OnePanelApp, locale: string): string {
  // 宝塔等面板描述可能带 HTML；展示与搜索都用纯文本（兼容旧缓存）
  if (locale.startsWith("zh")) {
    return stripHtmlToPlainText(
      app.shortDescZh || app.description || app.shortDescEn || "",
    );
  }
  return stripHtmlToPlainText(
    app.shortDescEn || app.description || app.shortDescZh || "",
  );
}

function pickLatestVersion(versions: string[] | undefined): string | null {
  if (!versions || versions.length === 0) return null;
  return versions[0] ?? null;
}

function resolveMarketCard(
  app: OnePanelApp,
  installedApps: OnePanelInstalledApp[],
): MarketCard {
  const installed = findInstalledAppForMarket(app, installedApps);
  if (installed) {
    const status = readInstalledAppStatus(installed);
    return {
      ...app,
      installState: resolveAppInstallDisplayState(status),
      installId: installed.id,
      installMessage: installed.message,
    };
  }
  return { ...app, installState: "available" };
}

/**
 * 仅 data/blob/内嵌 base64 可直接显示。
 * http(s)/相对路径在安全入口与 WebView 下不可靠，必须经后端代理成 data URL 后写入 iconCache。
 */
function resolveIconSrc(icon: string | undefined, iconCache: Record<string, string>): string | null {
  if (!icon) return null;
  if (icon.startsWith("data:") || icon.startsWith("blob:")) {
    return icon;
  }
  // 部分接口把 icon 直接返回为 base64
  if (
    !icon.startsWith("/") &&
    !icon.startsWith("http") &&
    /^[A-Za-z0-9+/=]+$/.test(icon) &&
    icon.length > 64
  ) {
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
    stripHtmlToPlainText(app.description),
    stripHtmlToPlainText(app.shortDescZh),
    stripHtmlToPlainText(app.shortDescEn),
    ...(app.tags ?? []).flatMap((tag) => [tag.name, tag.key]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function ServerAppsTab({ server }: Props) {
  const { t, locale } = useI18n();
  const driver = getPanelDriver(server.serviceType);
  const supportsApps = panelHasCapability(server.serviceType, "apps");
  const canInstall = supportsApps && typeof driver?.installApp === "function";
  const canUninstall = supportsApps && typeof driver?.uninstallApp === "function";
  const canFetchIcons = typeof driver?.getAppIconDataUrl === "function";
  const canOpenInstalledParams = typeof driver?.getInstalledAppParams === "function";

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
  const [installedFilter, setInstalledFilter] = usePersistedModuleTab(
    `server-apps-installed-filter-${server.id}`,
    "all",
    INSTALLED_FILTER_TABS,
  );
  const installedOnly = installedFilter === "installed";
  const [iconCache, setIconCache] = useState<Record<string, string>>(() =>
    peekServerAppIconCache(server.id).icons,
  );
  // 不回填 broken：旧会话里失败标记会挡住修复后的重试
  const [brokenIconKeys, setBrokenIconKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [iconLoadTick, setIconLoadTick] = useState(0);
  const iconCacheRef = useRef(iconCache);
  const brokenIconKeysRef = useRef(brokenIconKeys);
  const iconInflightRef = useRef<Set<string>>(new Set());
  iconCacheRef.current = iconCache;
  brokenIconKeysRef.current = brokenIconKeys;
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dockerHint, setDockerHint] = useState<string | null>(null);
  const [logTarget, setLogTarget] = useState<{ installId: number; label: string } | null>(null);
  const [paramsTarget, setParamsTarget] = useState<{
    installId: number;
    label: string;
    appKey?: string;
    appType?: string;
  } | null>(null);
  const [managingKey, setManagingKey] = useState<string | null>(null);

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
    const peeked = peekServerAppIconCache(server.id);
    setIconCache(peeked.icons);
    setBrokenIconKeys(new Set());
    iconInflightRef.current.clear();
    setIconLoadTick(0);
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

  const categoryOptions = useMemo(
    () => [
      { value: "", label: t("server.appMarket.allCategories") },
      ...categories.map((item) => ({ value: item, label: item })),
    ],
    [categories, t],
  );

  /** 同步远程应用商店后写入本地缓存（1Panel 有远端同步；宝塔直接刷新列表）。 */
  const handleSyncRemote = useCallback(async () => {
    if (!supportsApps || syncing || refreshing) return;
    setSyncing(true);
    setActionError(null);
    try {
      const next = getPanelDriver(server.serviceType);
      if (next?.syncApps) {
        const result = await next.syncApps(panelConnectionCtx(server));
        if (result && result.dockerAvailable === false) {
          setDockerHint(t("server.appMarket.dockerStoreHint"));
        } else {
          setDockerHint(null);
        }
      }
      showToast(t("server.appMarket.syncSuccess"));
      await refresh();
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setSyncing(false);
    }
  }, [refresh, refreshing, server, supportsApps, syncing, t]);

  const hasInstallingApps = useMemo(
    () => installedApps.some((item) => isAppInstallInProgress(readInstalledAppStatus(item))),
    [installedApps],
  );

  useEffect(() => {
    if (!hasInstallingApps) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasInstallingApps, refresh]);

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
      .map((app) => resolveMarketCard(app, installedApps))
      .filter((app) => !installedOnly || app.installState !== "available");
  }, [apps, category, installedApps, installedOnly, query]);

  // 懒加载缺失图标（有 getAppIconDataUrl 的 driver 走后端代理为 data URL）
  useEffect(() => {
    if (!supportsApps || !canFetchIcons || cards.length === 0) return;
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
        return !resolveIconSrc(app.icon, iconCacheRef.current);
      })
      .slice(0, 16);

    if (missing.length === 0) return;
    for (const key of missing) iconInflightRef.current.add(key);

    void (async () => {
      const next: Record<string, string> = {};
      const failed: string[] = [];
      const loadOne = async (key: string) => {
        try {
          const app = cards.find((item) => item.key === key);
          const panel = getPanelDriver(server.serviceType);
          const url = await panel?.getAppIconDataUrl?.(panelConnectionCtx(server), {
            key,
            icon: app?.icon,
          });
          if (url?.startsWith("data:") || url?.startsWith("blob:")) {
            next[key] = url;
            const iconKey = (app?.icon || "").trim();
            if (iconKey) next[iconKey] = url;
          } else {
            failed.push(key);
          }
        } catch (err) {
          failed.push(key);
          if (isBtPanelAuthFailureMessage(String(err))) {
            throw err;
          }
        } finally {
          iconInflightRef.current.delete(key);
        }
      };

      let stoppedByAuth = false;
      try {
        for (const key of missing) {
          if (cancelled) break;
          await loadOne(key);
        }
      } catch {
        stoppedByAuth = true;
        for (const key of missing) iconInflightRef.current.delete(key);
      }

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
      if (!stoppedByAuth) {
        setIconLoadTick((n) => n + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canFetchIcons, cards, iconLoadTick, server, supportsApps]);

  const handleSearch = () => {
    setQuery(search.trim());
  };

  const handleInstall = useCallback(
    async (app: MarketCard) => {
      if (!canInstall || installingKey || app.installState !== "available") return;
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
        const next = getPanelDriver(server.serviceType);
        if (!next?.installApp) throw new Error(t("server.appMarket.unsupported"));
        await next.installApp(panelConnectionCtx(server), {
          key: app.key,
          name: app.name,
          version: versionHint ?? undefined,
          id: app.id,
        });
        showToast(t("server.appMarket.installQueued", { name: label }));
        await refresh();
      } catch (err) {
        setActionError(formatError(err));
      } finally {
        setInstallingKey(null);
      }
    },
    [canInstall, installingKey, refresh, server, t],
  );

  const handleUninstall = useCallback(
    async (app: MarketCard) => {
      if (!canUninstall || installingKey || app.installState !== "installed") return;
      const label = app.name || app.key;
      const confirmed = await appConfirm(
        t("server.appMarket.uninstallConfirm", { name: label }),
        t("server.appMarket.uninstall"),
      );
      if (!confirmed) return;
      setInstallingKey(app.key);
      setActionError(null);
      try {
        const driver = getPanelDriver(server.serviceType);
        if (!driver?.uninstallApp) throw new Error(t("server.appMarket.unsupported"));
        await driver.uninstallApp(panelConnectionCtx(server), {
          key: app.key,
          name: app.name,
          id: app.id ?? app.installId ?? undefined,
        });
        showToast(t("server.appMarket.uninstallQueued", { name: label }));
        await refresh();
      } catch (err) {
        setActionError(formatError(err));
      } finally {
        setInstallingKey(null);
      }
    },
    [canUninstall, installingKey, refresh, server, t],
  );

  const handleManageInDatabase = useCallback(
    async (app: MarketCard) => {
      if (!canOpenInstalledParams || app.installState !== "installed" || app.installId == null) return;
      if (!isPanelAppManagedByDatabase(app) || managingKey) return;
      const appLabel = app.name || app.key || "—";
      const name = await quickInput({
        title: t("server.appMarket.manageInDatabaseNameTitle"),
        placeholder: t("server.appMarket.manageInDatabaseNamePlaceholder"),
        defaultValue: defaultPanelAppConnectionName(server.name, appLabel),
        validate: (value) =>
          value.trim() ? null : t("server.appMarket.manageInDatabaseNameRequired"),
      });
      if (!name) return;
      setManagingKey(app.key);
      setActionError(null);
      try {
        const config = await getPanelDriver(server.serviceType)?.getInstalledAppParams?.(
          panelConnectionCtx(server),
          { id: app.installId },
        );
        if (!config) throw new Error(t("server.appMarket.unsupported"));
        const result = await importPanelAppToDatabase({
          server,
          appLabel,
          appKey: app.key,
          appType: app.type,
          config: config as OnePanelAppInstalledParams,
          name: name.trim(),
        });
        showToast(
          result.created
            ? t("server.appMarket.manageInDatabaseDone", { name: result.connection.name })
            : t("server.appMarket.manageInDatabaseExists", { name: result.connection.name }),
        );
      } catch (err) {
        setActionError(formatError(err));
      } finally {
        setManagingKey(null);
      }
    },
    [canOpenInstalledParams, managingKey, server, t],
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
            <Select
              className="server-app-market__category"
              size="sm"
              value={category}
              onChange={setCategory}
              options={categoryOptions}
              disabled={busyMeta}
              searchable={categories.length > 8}
              aria-label={t("server.appMarket.allCategories")}
            />
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
              onChange={(event) =>
                setInstalledFilter(event.target.checked ? "installed" : "all")
              }
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
                (app.key ? iconCache[app.key] : null) ||
                resolveIconSrc(app.icon, iconCache);
              const desc = appDescription(app, locale);
              const busy = installingKey === app.key;
              const cardKey = `${app.id || "app"}:${app.key || app.name || index}`;
              const canOpenParams =
                canOpenInstalledParams &&
                app.installState === "installed" &&
                app.installId != null &&
                // 宝塔目前仅 MySQL/MariaDB 能拉安装参数；其它已装应用不开放参数入口
                (!isBtPanelService(server.serviceType) || isPanelAppManagedByDatabase(app));
              const canManageInDatabase = canOpenParams && isPanelAppManagedByDatabase(app);
              const openParams = () => {
                if (app.installId == null) return;
                setParamsTarget({
                  installId: app.installId,
                  label: app.name || app.key || "—",
                  appKey: app.key,
                  appType: app.type,
                });
              };
              return (
                <div
                  key={cardKey}
                  className={canOpenParams ? "server-app-card server-app-card--clickable" : "server-app-card"}
                  role={canOpenParams ? "button" : undefined}
                  tabIndex={canOpenParams ? 0 : undefined}
                  title={canOpenParams ? t("server.appMarket.paramsOpenHint") : undefined}
                  onClick={() => {
                    if (canOpenParams) openParams();
                  }}
                  onKeyDown={(event) => {
                    if (!canOpenParams) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openParams();
                    }
                  }}
                >
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
                    {app.installState === "installing" ? (
                      <button
                        type="button"
                        className="server-app-card__status server-app-card__status--warning server-app-card__status--action"
                        title={t("server.appMarket.viewInstallLog")}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (canOpenInstalledParams && app.installId != null) {
                            setLogTarget({
                              installId: app.installId,
                              label: app.name || app.key || "—",
                            });
                          }
                        }}
                      >
                        {t("server.appMarket.installing")}
                      </button>
                    ) : null}
                    {app.installState === "failed" ? (
                      <button
                        type="button"
                        className="server-app-card__status server-app-card__status--danger server-app-card__status--action"
                        title={t("server.appMarket.viewInstallLog")}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (canOpenInstalledParams && app.installId != null) {
                            setLogTarget({
                              installId: app.installId,
                              label: app.name || app.key || "—",
                            });
                          }
                        }}
                      >
                        {t("server.appMarket.installFailed")}
                      </button>
                    ) : null}
                    {app.installState === "installed" ? (
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

                  {app.installState === "available" ? (
                    <div className="server-app-card__footer">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!canInstall || busy || installingKey != null}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleInstall(app);
                        }}
                      >
                        {busy ? t("server.appMarket.installing") : t("server.appMarket.install")}
                      </Button>
                    </div>
                  ) : null}
                  {canUninstall && app.installState === "installed" ? (
                    <div className="server-app-card__footer">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busy || installingKey != null}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleUninstall(app);
                        }}
                      >
                        {t("server.appMarket.uninstall")}
                      </Button>
                    </div>
                  ) : null}
                  {canManageInDatabase ? (
                    <div className="server-app-card__footer">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={managingKey != null}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleManageInDatabase(app);
                        }}
                      >
                        {managingKey === app.key
                          ? t("server.appMarket.managingInDatabase")
                          : t("server.appMarket.manageInDatabase")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <AppInstallLogDialog
        open={logTarget != null}
        onOpenChange={(open) => {
          if (!open) setLogTarget(null);
        }}
        server={server}
        installId={logTarget?.installId ?? null}
        appLabel={logTarget?.label ?? ""}
      />
      <AppInstalledParamsDialog
        open={paramsTarget != null}
        onClose={() => setParamsTarget(null)}
        server={server}
        installId={paramsTarget?.installId ?? null}
        appLabel={paramsTarget?.label ?? ""}
        appKey={paramsTarget?.appKey}
        appType={paramsTarget?.appType}
      />
    </div>
  );
}
