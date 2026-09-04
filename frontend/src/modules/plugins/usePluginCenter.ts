import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { parsePluginManifest, type PluginManifest } from "@omnipanel/plugin-sdk";
import { commands, type OfficialCatalogPlugin, type PluginListItem } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { PLUGIN_OFFICIAL_CATALOG_UPDATED } from "../../ipc/events";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { useDbxCatalogStore } from "../../stores/dbxCatalogStore";
import { usePluginHomePinStore } from "../../stores/pluginHomePinStore";
import { usePluginMarketStatsStore } from "../../stores/pluginMarketStatsStore";
import { useI18n } from "../../i18n";
import { pluginDisplayName } from "./pluginDisplayName";
import { firstPartyIdSet, originForInstalled, type PluginOrigin } from "./pluginOrigin";
import { openPluginOverlay } from "../../lib/pluginHomeLaunch";
import {
  dbxToMarketItem,
  officialToMarketItem,
  pluginMatchesQuery,
  withLocalStats,
  type KindFilter,
  type MarketFilter,
  type MarketItem,
} from "./pluginCenterTypes";

export function usePluginCenter() {
  const { t } = useI18n();
  const [items, setItems] = useState<PluginListItem[]>([]);
  const [official, setOfficial] = useState<OfficialCatalogPlugin[]>([]);
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
      const list = await unwrapCommand(commands.pluginOfficialCatalog(force));
      setOfficial(list);
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
    for (const plugin of official) ids.add(plugin.id);
    return ids;
  }, [official]);

  const dbxPluginIds = useMemo(
    () => new Set(catalog.map((driver) => driver.pluginId)),
    [catalog],
  );

  const originOf = useCallback(
    (item: PluginListItem): PluginOrigin => originForInstalled(item, officialIds, dbxPluginIds),
    [officialIds, dbxPluginIds],
  );

  const marketItems = useMemo(() => {
    const officialItems = official.map((plugin) =>
      officialToMarketItem(plugin, pluginDisplayName(plugin.id, t, plugin.name)),
    );
    const dbxItems = catalog.map((driver) =>
      dbxToMarketItem(driver, pluginDisplayName(driver.pluginId, t, driver.label)),
    );
    return [...officialItems, ...dbxItems].map((item) =>
      withLocalStats(item, {
        installs: statsById[item.id]?.installs ?? 0,
      }),
    );
  }, [official, catalog, t, statsById]);

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
      return pluginMatchesQuery(item.id, item.name, item.kind, query);
    });
  }, [marketItems, matchesKind, marketFilter, query]);

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
      await reloadInstalled();
      await reloadOfficial();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

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
    setInstallingMarketId(item.id);
    try {
      if (item.origin === "thirdParty" && item.dbxKey) {
        await unwrapCommand(commands.pluginDbxInstall(item.dbxKey));
      } else {
        await unwrapCommand(commands.pluginOfficialInstall(item.id));
      }
      recordInstall(item.id);
      await reloadInstalled();
      await reloadMarket();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingMarketId(null);
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
    search,
    setSearch,
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
  };
}
