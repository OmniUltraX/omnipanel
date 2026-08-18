import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedModuleTab } from "../../../../hooks/usePersistedModuleTab";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/Button";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import { IconRefresh, IconSearch } from "../../../../components/ui/icons/Icons";
import { createBtPanelClient, isBtPanelAuthFailureMessage } from "../../../../lib/btpanel";
import {
  createOnePanelClient,
  type OnePanelApp,
  type OnePanelInstalledApp,
} from "../../../../lib/onepanel";
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

  const hasInstallingApps = useMemo(
    () =>
      isOnePanel &&
      installedApps.some((item) => isAppInstallInProgress(readInstalledAppStatus(item))),
    [installedApps, isOnePanel],
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

  // 懒加载缺失图标（1Panel / 宝塔均走后端代理为 data URL）
  useEffect(() => {
    if (!supportsApps || cards.length === 0) return;
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
      // 宝塔图标走鉴权下载：串行，避免一次挂载并发十几路把验证失败打满
      const loadOne = async (key: string) => {
        try {
          const app = cards.find((item) => item.key === key);
          const url = isBt
            ? await createBtPanelClient(server.address, server.key, server.id).getAppIconDataUrl(
                key,
                app?.icon,
              )
            : await createOnePanelClient(server.address, server.key, server.id).getAppIconDataUrl(
                key,
              );
          // 非 data URL 在 WebView 中不可靠，视为失败走占位
          if (url?.startsWith("data:") || url?.startsWith("blob:")) {
            next[key] = url;
            const iconKey = (app?.icon || "").trim();
            if (iconKey) next[iconKey] = url;
          } else {
            failed.push(key);
          }
        } catch (err) {
          failed.push(key);
          if (isBt && isBtPanelAuthFailureMessage(String(err))) {
            throw err;
          }
        } finally {
          iconInflightRef.current.delete(key);
        }
      };

      let stoppedByAuth = false;
      try {
        if (isBt) {
          for (const key of missing) {
            if (cancelled) break;
            await loadOne(key);
          }
        } else {
          await Promise.all(missing.map((key) => loadOne(key)));
        }
      } catch {
        // 宝塔鉴权/封禁：已熔断，剩余图标不再请求
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
      // 鉴权失败后不再拉下一批，避免空转刷熔断错误
      if (!stoppedByAuth) {
        setIconLoadTick((n) => n + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cards, iconLoadTick, isBt, server.address, server.id, server.key, supportsApps]);

  const handleSearch = () => {
    setQuery(search.trim());
  };

  const handleInstall = useCallback(
    async (app: MarketCard) => {
      if (!supportsApps || installingKey || app.installState !== "available") return;
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
        showToast(t("server.appMarket.installQueued", { name: label }));
        await refresh();
      } catch (err) {
        setActionError(formatError(err));
      } finally {
        setInstallingKey(null);
      }
    },
    [installingKey, isBt, refresh, server.address, server.id, server.key, supportsApps, t],
  );

  const handleManageInDatabase = useCallback(
    async (app: MarketCard) => {
      if (!isOnePanel || app.installState !== "installed" || app.installId == null) return;
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
        const config = await createOnePanelClient(
          server.address,
          server.key,
          server.id,
        ).getInstalledAppParams(app.installId);
        const result = await importPanelAppToDatabase({
          server,
          appLabel,
          appKey: app.key,
          appType: app.type,
          config,
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
    [isOnePanel, managingKey, server, t],
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
                isOnePanel && app.installState === "installed" && app.installId != null;
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
                          if (app.installId != null) {
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
                          if (app.installId != null) {
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
                        disabled={!supportsApps || busy || installingKey != null}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleInstall(app);
                        }}
                      >
                        {busy ? t("server.appMarket.installing") : t("server.appMarket.install")}
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
