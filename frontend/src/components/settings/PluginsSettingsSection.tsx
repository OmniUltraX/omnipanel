import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n";
import { commands, type DbxCatalogDriver, type PluginListItem } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { Button } from "../ui/primitives/Button";
import { openImporter } from "../../modules/importer/ImporterWizardDialog";
import {
  PLUGIN_ID_EVERYTHING,
  usePluginRuntimeStore,
} from "../../stores/pluginRuntimeStore";
import { getPluginManifest } from "../../lib/pluginManifests";
import { importerEntries, listActiveImporters, resolveImporterText } from "../../lib/importerCatalog";
import { parsePluginHomeContribution } from "../../lib/pluginHomeContribution";
import { openPluginOverlay } from "../../lib/pluginHomeLaunch";
import { usePluginHomePinStore } from "../../stores/pluginHomePinStore";
import { useDbxCatalogStore } from "../../stores/dbxCatalogStore";

const PLUGIN_NAME_KEYS: Record<string, string> = {
  [PLUGIN_ID_EVERYTHING]: "plugins.names.everything",
  "omni.cloud.aliyun": "plugins.names.aliyun",
  "omni.engine.qdrant": "plugins.names.qdrant",
  "omni.engine.clickhouse": "plugins.names.clickhouse",
  "omni.engine.mongodb": "plugins.names.mongodb",
  "omni.engine.mysql": "plugins.names.mysql",
  "omni.engine.postgres": "plugins.names.postgres",
  "omni.engine.sqlite": "plugins.names.sqlite",
  "omni.engine.sqlserver": "plugins.names.sqlserver",
  "omni.engine.redis": "plugins.names.redis",
  "omni.module.nacos": "plugins.names.nacos",
  "omni.importer.warpgate": "plugins.names.warpgate",
  "omni.panel.1panel": "plugins.names.onepanel",
  "omni.panel.bt": "plugins.names.bt",
  "omni.theme.default": "plugins.names.themeDefault",
  "omni.addon.translator": "plugins.names.translator",
};

const UNSUPPORTED_REASON_KEYS: Record<string, string> = {
  "platform.unsupported": "plugins.unsupported.platform",
};

function formatCatalogSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function isAlwaysOnEngine(item: PluginListItem): boolean {
  return item.source === "builtin" && item.kind === "engine";
}

export function PluginsSettingsSection() {
  const { t } = useI18n();
  const [items, setItems] = useState<PluginListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const catalog = useDbxCatalogStore((s) => s.drivers);
  const catalogRefreshing = useDbxCatalogStore((s) => s.refreshing);
  const refreshCatalog = useDbxCatalogStore((s) => s.refresh);
  const catalogLoading = catalogRefreshing && catalog.length === 0;
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const syncRuntime = usePluginRuntimeStore((s) => s.reload);
  const homeHiddenIds = usePluginHomePinStore((s) => s.hiddenIds);
  const setHomePinned = usePluginHomePinStore((s) => s.setPinned);

  const reload = useCallback(async () => {
    try {
      const list = await unwrapCommand(commands.pluginList());
      setItems(list);
      await syncRuntime();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [syncRuntime]);

  const loadCatalog = useCallback(async () => {
    try {
      await refreshCatalog();
    } catch (err) {
      setError(String(err));
    }
  }, [refreshCatalog]);

  useEffect(() => {
    void reload();
    void loadCatalog();
  }, [reload, loadCatalog]);

  const toggle = async (item: PluginListItem, enabled: boolean) => {
    setBusyId(item.id);
    try {
      await unwrapCommand(commands.pluginSetEnabled(item.id, enabled));
      await reload();
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
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const openOverlay = async (item: PluginListItem) => {
    try {
      await openPluginOverlay(item.id);
    } catch (err) {
      setError(String(err));
    }
  };

  const installDbxDriver = async (driver: DbxCatalogDriver) => {
    setInstallingKey(driver.key);
    try {
      await unwrapCommand(commands.pluginDbxInstall(driver.key));
      await reload();
      await loadCatalog();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstallingKey(null);
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
      await unwrapCommand(commands.pluginInstallFromFile(picked));
      await reload();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstalling(false);
    }
  };

  const settingsImporters = listActiveImporters(items).filter((entry) =>
    importerEntries(entry.importer).includes("settings"),
  );

  return (
    <div className="settings-plugins">
      {error ? <p className="setting-hint">{error}</p> : null}
      {items.map((item) => (
        <div key={item.id} className="setting-row">
          <div className="setting-label">
            <h4>
              {PLUGIN_NAME_KEYS[item.id] ? t(PLUGIN_NAME_KEYS[item.id]) : item.id}
              {item.source === "installed" ? (
                <span className="settings-plugins-tag">{t("plugins.source.installed")}</span>
              ) : isAlwaysOnEngine(item) ? (
                <span className="settings-plugins-tag">{t("plugins.source.alwaysOn")}</span>
              ) : null}
            </h4>
            <p>
              {item.id} · {item.kind} · v{item.version}
              {item.unsupportedReason
                ? ` · ${UNSUPPORTED_REASON_KEYS[item.unsupportedReason]
                    ? t(UNSUPPORTED_REASON_KEYS[item.unsupportedReason])
                    : item.unsupportedReason}`
                : ""}
              {item.id === PLUGIN_ID_EVERYTHING ? ` · ${t("plugins.everything.hint")}` : ""}
            </p>
          </div>
          <div className="settings-plugins-actions">
            {item.source === "installed" &&
            (getPluginManifest(item.id)?.contributes.overlays?.length ?? 0) > 0 &&
            item.enabled &&
            item.activated ? (
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={busyId === item.id}
                onClick={() => void openOverlay(item)}
              >
                {t("plugins.openOverlay")}
              </Button>
            ) : null}
            {parsePluginHomeContribution(getPluginManifest(item.id)) &&
            item.enabled &&
            item.activated ? (
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={!homeHiddenIds.includes(item.id)}
                  disabled={busyId === item.id}
                  onChange={(event) => setHomePinned(item.id, event.target.checked)}
                />
                <span>{t("plugins.homePin")}</span>
              </label>
            ) : null}
            {item.source === "installed" ? (
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={busyId === item.id}
                onClick={() => void uninstall(item)}
              >
                {t("plugins.uninstall")}
              </Button>
            ) : null}
            <label className="form-check">
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={
                  busyId === item.id ||
                  Boolean(item.unsupportedReason) ||
                  isAlwaysOnEngine(item)
                }
                onChange={(event) => void toggle(item, event.target.checked)}
              />
              <span>
                {item.enabled ? t("settings.plugins.enabled") : t("settings.plugins.disabled")}
              </span>
            </label>
          </div>
        </div>
      ))}
      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("plugins.catalog.title")}</h4>
          <p>{t("plugins.catalog.hint")}</p>
          <div className="settings-plugins-catalog">
            {catalog.length === 0 && !catalogLoading ? (
              <p className="settings-plugins-catalog-meta">{t("plugins.catalog.empty")}</p>
            ) : null}
            {catalog.map((driver) => {
              const needsUpdate =
                driver.installed &&
                driver.installedVersion != null &&
                driver.installedVersion !== driver.version;
              return (
                <div key={driver.key} className="settings-plugins-catalog-item">
                  <div>
                    <strong>{driver.label}</strong>
                    <div className="settings-plugins-catalog-meta">
                      {driver.pluginId} · v{driver.version}
                      {` · ${driver.artifactKind === "jar" ? t("plugins.catalog.jar") : t("plugins.catalog.native")}`}
                      {driver.size > 0 ? ` · ${formatCatalogSize(driver.size)}` : ""}
                      {driver.installed
                        ? ` · ${t("plugins.catalog.installed")}${
                            driver.installedVersion ? ` v${driver.installedVersion}` : ""
                          }`
                        : ""}
                    </div>
                  </div>
                  {driver.installed && !needsUpdate ? (
                    <span className="settings-plugins-catalog-meta">
                      {t("plugins.catalog.installed")}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={installingKey === driver.key}
                      onClick={() => void installDbxDriver(driver)}
                    >
                      {installingKey === driver.key
                        ? t("plugins.catalog.installing")
                        : needsUpdate
                          ? t("plugins.catalog.update")
                          : t("plugins.catalog.install")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={catalogRefreshing || installingKey !== null}
          onClick={() => void loadCatalog()}
        >
          {t("plugins.catalog.refresh")}
        </Button>
      </div>
      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("plugins.install.title")}</h4>
          <p>{t("plugins.install.hint")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={installing}
          onClick={() => void installFromFile()}
        >
          {t("plugins.install.action")}
        </Button>
      </div>
      {settingsImporters.map((entry) => (
        <div key={`${entry.pluginId}:${entry.importer.id}`} className="setting-row">
          <div className="setting-label">
            <h4>{resolveImporterText(entry.importer.title, t)}</h4>
            <p>{resolveImporterText(entry.importer.hint, t)}</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => openImporter(entry.pluginId, entry.importer.id)}
          >
            {t("plugins.importer.open")}
          </Button>
        </div>
      ))}
    </div>
  );
}
