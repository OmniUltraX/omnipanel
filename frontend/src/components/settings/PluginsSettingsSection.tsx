import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n";
import { commands, type PluginListItem } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { Button } from "../ui/primitives/Button";
import { openWarpgateImport } from "../../modules/importer/WarpgateImportDialog";
import {
  PLUGIN_ID_EVERYTHING,
  PLUGIN_ID_WARPGATE,
  usePluginRuntimeStore,
} from "../../stores/pluginRuntimeStore";

const PLUGIN_NAME_KEYS: Record<string, string> = {
  [PLUGIN_ID_EVERYTHING]: "plugins.names.everything",
  "omni.cloud.aliyun": "plugins.names.aliyun",
  "omni.engine.qdrant": "plugins.names.qdrant",
  "omni.engine.clickhouse": "plugins.names.clickhouse",
  "omni.engine.redis": "plugins.names.redis",
  "omni.module.nacos": "plugins.names.nacos",
  [PLUGIN_ID_WARPGATE]: "plugins.names.warpgate",
  "omni.panel.1panel": "plugins.names.onepanel",
  "omni.panel.bt": "plugins.names.bt",
  "omni.theme.default": "plugins.names.themeDefault",
};

const UNSUPPORTED_REASON_KEYS: Record<string, string> = {
  "platform.unsupported": "plugins.unsupported.platform",
};

export function PluginsSettingsSection() {
  const { t } = useI18n();
  const [items, setItems] = useState<PluginListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const syncRuntime = usePluginRuntimeStore((s) => s.reload);

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

  useEffect(() => {
    void reload();
  }, [reload]);

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

  const warpgateOn = items.some(
    (item) => item.id === PLUGIN_ID_WARPGATE && item.enabled && item.activated,
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
                disabled={busyId === item.id || Boolean(item.unsupportedReason)}
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
      {warpgateOn ? (
        <div className="setting-row">
          <div className="setting-label">
            <h4>{t("plugins.warpgate.title")}</h4>
            <p>{t("plugins.warpgate.hint")}</p>
          </div>
          <Button type="button" size="sm" onClick={() => openWarpgateImport()}>
            {t("plugins.warpgate.open")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
