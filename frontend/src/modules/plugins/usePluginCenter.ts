import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { parsePluginManifest, type PluginManifest } from "@omnipanel/plugin-sdk";
import { commands, type ExternalVerdictDto, type MarketplaceItem, type PluginListItem, type PluginUpdateInfo, type RegistrySourceDto, type ResolvePlan, type SourceTestResult } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { PLUGIN_OFFICIAL_CATALOG_UPDATED } from "../../ipc/events";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { useDbxCatalogStore } from "../../stores/dbxCatalogStore";
import { usePluginHomePinStore } from "../../stores/pluginHomePinStore";
import { usePluginMarketStatsStore } from "../../stores/pluginMarketStatsStore";
import { useI18n } from "../../i18n";
import { pluginDisplayName } from "./pluginDisplayName";
import { firstPartyIdSet, originForInstalled, type PluginOrigin } from "./pluginOrigin";
import { openPluginOverlay } from "../../lib/pluginHomeLaunch";
import {
  categorizeExternalPlugin,
  dbxToMarketItem,
  marketplaceToMarketItem,
  pluginMatchesQuery,
  sanitizeExternalId,
  shouldConfirmInstallPlan,
  withLocalStats,
  type ExternalCategory,
  type KindFilter,
  type MarketFilter,
  type MarketItem,
} from "./pluginCenterTypes";

export function usePluginCenter() {
  const { t } = useI18n();
  const [items, setItems] = useState<PluginListItem[]>([]);
  const [marketCatalog, setMarketCatalog] = useState<MarketplaceItem[]>([]);
  const [updates, setUpdates] = useState<PluginUpdateInfo[]>([]);
  const [sources, setSources] = useState<RegistrySourceDto[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceBusyId, setSourceBusyId] = useState<string | null>(null);
  const [sourceTest, setSourceTest] = useState<SourceTestResult | null>(null);
  const [pendingPlan, setPendingPlan] = useState<{
    targetId: string;
    plan: ResolvePlan;
  } | null>(null);
  const [pendingExternal, setPendingExternal] = useState<{
    item: MarketItem;
    verdict: ExternalVerdictDto;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<{
    path: string;
    fileName: string;
    manifest: PluginManifest;
  } | null>(null);
  const [installingMarketId, setInstallingMarketId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [search, setSearch] = useState("");
  const [npmSearch, setNpmSearch] = useState<{ query: string; items: MarketItem[] } | null>(null);
  const [npmSearching, setNpmSearching] = useState(false);
  const [extCategory, setExtCategory] = useState<ExternalCategory | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const catalog = useDbxCatalogStore((s) => s.drivers);
  const catalogRefreshing = useDbxCatalogStore((s) => s.refreshing);
  const refreshDbx = useDbxCatalogStore((s) => s.refresh);
  const syncRuntime = usePluginRuntimeStore((s) => s.reload);
  const homeHiddenIds = usePluginHomePinStore((s) => s.hiddenIds);
  const setHomePinned = usePluginHomePinStore((s) => s.setPinned);
  const statsById = usePluginMarketStatsStore((s) => s.byId);
  const recordInstall = usePluginMarketStatsStore((s) => s.recordInstall);

  const reloadInstalled = useCallback(async () => {
    try {
      const list = await unwrapCommand(commands.pluginList());
      setItems(list);
      await syncRuntime();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [syncRuntime]);

  const reloadOfficial = useCallback(async (force = false) => {
    try {
      const [list, nextUpdates, nextSources] = await Promise.all([
        unwrapCommand(commands.pluginMarketCatalog(force), { quiet: true }),
        unwrapCommand(commands.pluginCheckUpdates(), { quiet: true }),
        unwrapCommand(commands.pluginRegistrySourcesList()),
      ]);
      setMarketCatalog(list);
      setUpdates(nextUpdates);
      setSources(nextSources);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const reloadMarket = useCallback(async (force = false) => {
    try {
      await Promise.all([reloadOfficial(force), refreshDbx()]);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [reloadOfficial, refreshDbx]);

  useEffect(() => {
    void reloadInstalled();
    void reloadMarket(false);
  }, [reloadInstalled, reloadMarket]);

  // 市场打开即自动拉全量（npm 默认查询，静默失败仅留种子；单次挂载一次）
  const autoNpmLoaded = useRef(false);
  useEffect(() => {
    if (autoNpmLoaded.current) return;
    autoNpmLoaded.current = true;
    void searchNpmMarket("rubick", { quiet: true, size: 50 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(PLUGIN_OFFICIAL_CATALOG_UPDATED, () => {
      void reloadOfficial(false);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reloadOfficial]);

  const officialIds = useMemo(() => {
    const ids = firstPartyIdSet();
    for (const plugin of marketCatalog) {
      if (plugin.sourceId === "official") ids.add(plugin.id);
    }
    return ids;
  }, [marketCatalog]);

  const registryThirdPartyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const plugin of marketCatalog) {
      if (plugin.sourceId !== "official") ids.add(plugin.id);
    }
    return ids;
  }, [marketCatalog]);

  const dbxPluginIds = useMemo(
    () => new Set(catalog.map((driver) => driver.pluginId)),
    [catalog],
  );

  const originOf = useCallback(
    (item: PluginListItem): PluginOrigin =>
      originForInstalled(item, officialIds, dbxPluginIds, registryThirdPartyIds),
    [officialIds, dbxPluginIds, registryThirdPartyIds],
  );

  const marketItems = useMemo(() => {
    const fromRegistry = marketCatalog.map((plugin) =>
      marketplaceToMarketItem(plugin, pluginDisplayName(plugin.id, t, plugin.name)),
    );
    const seen = new Set(fromRegistry.map((item) => item.id));
    const dbxItems = catalog
      .filter((driver) => !seen.has(driver.pluginId))
      .map((driver) => dbxToMarketItem(driver, pluginDisplayName(driver.pluginId, t, driver.label)));
    for (const item of dbxItems) seen.add(item.id);
    // npm 搜索结果：来源 rubick，id 与后端 sanitize 对齐用于已安装判定
    const npmItems = (npmSearch?.items ?? []).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return [...fromRegistry, ...dbxItems, ...npmItems].map((item) =>
      withLocalStats(item, {
        installs: statsById[item.id]?.installs ?? 0,
      }),
    );
  }, [marketCatalog, catalog, npmSearch, t, statsById]);

  const query = search.trim().toLowerCase();
  const matchesKind = useCallback(
    (kind: PluginListItem["kind"]) => kindFilter === "all" || kind === kindFilter,
    [kindFilter],
  );

  const filteredInstalled = useMemo(() => {
    return items.filter((item) => {
      if (!matchesKind(item.kind)) return false;
      return pluginMatchesQuery(item.id, pluginDisplayName(item.id, t), item.kind, query);
    });
  }, [items, matchesKind, query, t]);

  const filteredMarket = useMemo(() => {
    return marketItems.filter((item) => {
      if (!matchesKind(item.kind)) return false;
      if (marketFilter === "official" && item.origin !== "official") return false;
      if (marketFilter === "thirdParty" && item.origin !== "thirdParty") return false;
      if (
        marketFilter !== "all" &&
        marketFilter !== "official" &&
        marketFilter !== "thirdParty" &&
        item.sourceId !== marketFilter
      ) {
        return false;
      }
      if (
        item.sourceId === "rubick" &&
        extCategory !== "all" &&
        item.extCategory !== extCategory
      ) {
        return false;
      }
      return pluginMatchesQuery(item.id, item.name, item.kind, query);
    });
  }, [marketItems, matchesKind, marketFilter, extCategory, query]);

  /** 来源直列：官方 + 各来源 id（dbx / rubick / 自定义源…），不再用统一第三方。 */
  const sourceFilters = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of marketItems) {
      const sid = item.sourceId ?? "";
      if (!sid || sid === "official" || seen.has(sid)) continue;
      seen.add(sid);
      ids.push(sid);
    }
    ids.sort();
    return ids.map((id) => ({
      id,
      label:
        id === "dbx"
          ? t("plugins.center.origin.dbx")
          : id === "rubick"
            ? t("plugins.center.origin.rubick")
            : id,
    }));
  }, [marketItems, t]);

  const searchNpmMarket = async (rawQuery?: string, opts?: { quiet?: boolean; size?: number }) => {
    const q = (rawQuery ?? search).trim();
    if (!q || npmSearching) return;
    setNpmSearching(true);
    try {
      const hits = await unwrapCommand(commands.pluginExternalSearchNpm(q, opts?.size ?? 25));
      const mapped: MarketItem[] = hits.map((hit) => ({
        id: `omni.ext.${sanitizeExternalId(hit.npm)}`,
        name: hit.npm,
        kind: "addon" as const,
        version: hit.version,
        origin: "thirdParty" as const,
        distribution: "download" as const,
        installed: false,
        installedVersion: null,
        size: 0,
        artifactKind: null,
        dbxKey: null,
        description: hit.description,
        permissions: [],
        needsUpdate: false,
        createdAt: null,
        updatedAt: null,
        downloads: null,
        localInstalls: 0,
        changelog: null,
        sourceId: "rubick",
        externalNpm: hit.npm,
        extCategory: categorizeExternalPlugin({
          npm: hit.npm,
          name: hit.npm,
          description: hit.description,
          keywords: hit.keywords,
        }),
      }));
      setNpmSearch({ query: q, items: mapped });
      if (!opts?.quiet) setError(null);
    } catch (err) {
      if (!opts?.quiet) setError(String(err));
    } finally {
      setNpmSearching(false);
    }
  };

  const clearNpmSearch = useCallback(() => {
    setNpmSearch(null);
  }, []);

  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = {
      all: 0,
      engine: 0,
      importer: 0,
      panel: 0,
      cloud: 0,
      module: 0,
      theme: 0,
      addon: 0,
    };
    const seen = new Set<string>();
    const add = (id: string, name: string, kind: PluginListItem["kind"]) => {
      if (!pluginMatchesQuery(id, name, kind, query)) return;
      const key = `${kind}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      counts[kind] += 1;
      counts.all += 1;
    };
    for (const item of items) {
      add(item.id, pluginDisplayName(item.id, t), item.kind);
    }
    for (const item of marketItems) {
      add(item.id, item.name, item.kind);
    }
    return counts;
  }, [items, marketItems, query, t]);

  const selectedInstalled = items.find((item) => item.id === selectedId) ?? null;
  const selectedMarket = marketItems.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) return;
    const visible =
      filteredInstalled.some((item) => item.id === selectedId) ||
      filteredMarket.some((item) => item.id === selectedId);
    if (!visible) setSelectedId(null);
  }, [filteredInstalled, filteredMarket, selectedId]);

  const toggle = async (item: PluginListItem, enabled: boolean) => {
    setBusyId(item.id);
    try {
      await unwrapCommand(commands.pluginSetEnabled(item.id, enabled));
      if (enabled && item.kind === "theme") {
        useSettingsStore.getState().setThemePackId(item.id);
      }
      await reloadInstalled();
      await reloadOfficial();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const executeInstallPlan = async (plan: ResolvePlan, recordId: string) => {
    setInstallingMarketId(recordId);
    try {
      const steps =
        plan.items.length > 0
          ? plan.items
          : [{ id: recordId, version: null as string | null, action: "install", sourceId: "" }];
      for (const step of steps) {
        await unwrapCommand(commands.pluginInstallVersion(step.id, step.version, true));
      }
      recordInstall(recordId);
      await reloadInstalled();
      await reloadMarket();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingMarketId(null);
    }
  };

  const cancelPendingPlan = useCallback(() => {
    if (!confirming) setPendingPlan(null);
  }, [confirming]);

  const confirmPendingPlan = async () => {
    if (!pendingPlan || confirming) return;
    setConfirming(true);
    try {
      await executeInstallPlan(pendingPlan.plan, pendingPlan.targetId);
      setPendingPlan(null);
    } finally {
      setConfirming(false);
    }
  };

  /** 外部插件：判定（analyze）→ 弹窗展示 verdict → 确认转换安装。 */
  const startExternalAnalyze = async (item: MarketItem) => {
    if (!item.externalNpm || confirming) return;
    setInstallingMarketId(item.id);
    try {
      const verdict = await unwrapCommand(
        commands.pluginExternalAnalyzeNpm(item.externalNpm, item.version),
      );
      setPendingExternal({ item, verdict });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingMarketId(null);
    }
  };

  const confirmPendingExternal = async () => {
    if (!pendingExternal || confirming) return;
    // external-only 无确认路径（弹窗只展示原因与外跳指引）
    if (!pendingExternal.verdict.runnable || !pendingExternal.item.externalNpm) return;
    setConfirming(true);
    try {
      await unwrapCommand(
        commands.pluginExternalConvertNpm(
          pendingExternal.item.externalNpm,
          pendingExternal.item.version,
        ),
      );
      recordInstall(pendingExternal.item.id);
      setPendingExternal(null);
      await reloadInstalled();
      await reloadMarket();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setConfirming(false);
    }
  };

  const cancelPendingExternal = useCallback(() => {
    if (!confirming) setPendingExternal(null);
  }, [confirming]);

  const uninstall = async (item: PluginListItem) => {
    setBusyId(item.id);
    try {
      await unwrapCommand(commands.pluginUninstall(item.id));
      await reloadInstalled();
      await reloadMarket();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const installFromFile = async () => {
    setInstalling(true);
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "OmniPanel Plugin", extensions: ["omni-plugin", "zip"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      // 先预读清单做权限确认，不直接安装
      const manifestJson = await unwrapCommand(commands.pluginPeekManifest(picked));
      const manifest = parsePluginManifest(JSON.parse(manifestJson));
      const fileName = picked.split(/[\\/]/).pop() || picked;
      setPendingInstall({ path: picked, fileName, manifest });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstalling(false);
    }
  };

  const cancelPendingInstall = useCallback(() => {
    if (!confirming) setPendingInstall(null);
  }, [confirming]);

  const confirmPendingInstall = async () => {
    if (!pendingInstall || confirming) return;
    setConfirming(true);
    try {
      await unwrapCommand(commands.pluginInstallFromFile(pendingInstall.path));
      setPendingInstall(null);
      await reloadInstalled();
      await reloadMarket();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setConfirming(false);
    }
  };

  const openOverlay = async (id: string) => {
    try {
      await openPluginOverlay(id);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const installMarket = async (item: MarketItem) => {
    // 外部来源（Rubick npm 包）：先判定再分级，不走版本直装
    if (item.externalNpm) {
      await startExternalAnalyze(item);
      return;
    }
    if (item.dbxKey) {
      setInstallingMarketId(item.id);
      try {
        await unwrapCommand(commands.pluginDbxInstall(item.dbxKey));
        recordInstall(item.id);
        await reloadInstalled();
        await reloadMarket();
        setError(null);
      } catch (err) {
        setError(String(err));
      } finally {
        setInstallingMarketId(null);
      }
      return;
    }
    try {
      const plan = await unwrapCommand(commands.pluginResolvePlan(item.id, `=${item.version}`));
      if (shouldConfirmInstallPlan(plan, item.id)) {
        setPendingPlan({ targetId: item.id, plan });
        return;
      }
      await executeInstallPlan(plan, item.id);
    } catch (err) {
      setError(String(err));
    }
  };

  const updatePlugins = async (ids: string[] | null) => {
    setInstallingMarketId(ids?.length === 1 ? ids[0] : "__all__");
    try {
      const results = await unwrapCommand(commands.pluginUpdateAll(ids));
      const failed = results.filter((row) => !row.ok);
      setError(
        failed.length
          ? failed
              .map((row) =>
                t("plugins.center.updateFailed", { id: row.id, error: row.error ?? "" }),
              )
              .join("\n")
          : null,
      );
      await reloadInstalled();
      await reloadMarket();
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingMarketId(null);
    }
  };

  const refreshSources = async () => {
    setSources(await unwrapCommand(commands.pluginRegistrySourcesList()));
  };

  const addSource = async (id: string, url: string, keys: string[], token: string | null) => {
    setSourceBusyId("__add__");
    try {
      await unwrapCommand(commands.pluginRegistrySourceAdd(id, url, keys, token));
      setSourceTest(null);
      await refreshSources();
      await reloadMarket(true);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSourceBusyId(null);
    }
  };

  const removeSource = async (id: string) => {
    setSourceBusyId(id);
    try {
      await unwrapCommand(commands.pluginRegistrySourceRemove(id));
      await refreshSources();
      await reloadMarket(true);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSourceBusyId(null);
    }
  };

  const setSourceEnabled = async (id: string, enabled: boolean) => {
    setSourceBusyId(id);
    try {
      await unwrapCommand(commands.pluginRegistrySourceSetEnabled(id, enabled));
      await refreshSources();
      await reloadMarket(true);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSourceBusyId(null);
    }
  };

  const testSource = async (id: string) => {
    setSourceBusyId(id);
    try {
      setSourceTest(await unwrapCommand(commands.pluginRegistrySourceTest(id)));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSourceBusyId(null);
    }
  };

  const confirmSourceKey = async (id: string, key: string) => {
    setSourceBusyId(id);
    try {
      await unwrapCommand(commands.pluginRegistryConfirmKey(id, key));
      await refreshSources();
      await reloadMarket(true);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSourceBusyId(null);
    }
  };

  return {
    items,
    filteredInstalled,
    filteredMarket,
    marketItems,
    error,
    busyId,
    installing,
    confirming,
    pendingInstall,
    cancelPendingInstall,
    confirmPendingInstall,
    installingMarketId,
    kindFilter,
    setKindFilter,
    kindCounts,
    marketFilter,
    setMarketFilter,
    sourceFilters,
    search,
    setSearch,
    npmSearch,
    npmSearching,
    searchNpmMarket,
    clearNpmSearch,
    extCategory,
    setExtCategory,
    selectedId,
    setSelectedId,
    selectedInstalled,
    selectedMarket,
    catalogRefreshing,
    originOf,
    toggle,
    uninstall,
    installFromFile,
    installMarket,
    openOverlay,
    reloadMarket,
    homeHiddenIds,
    setHomePinned,
    setError,
    updates,
    updatePlugins,
    sources,
    sourcesOpen,
    setSourcesOpen,
    sourceBusyId,
    sourceTest,
    addSource,
    removeSource,
    setSourceEnabled,
    testSource,
    confirmSourceKey,
    pendingPlan,
    cancelPendingPlan,
    confirmPendingPlan,
    pendingExternal,
    cancelPendingExternal,
    confirmPendingExternal,
    isDbxId: (id: string) => dbxPluginIds.has(id),
    dbxIds: dbxPluginIds,
  };
}
