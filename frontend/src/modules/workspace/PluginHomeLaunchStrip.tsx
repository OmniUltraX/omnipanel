import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import {
  listPinnedHomePlugins,
  loadPluginIcon,
  openPluginHome,
  resolveHomeTitle,
  resolvePluginIconPath,
  type EligibleHomePlugin,
} from "../../lib/pluginHomeLaunch";
import { getPluginManifest } from "../../lib/pluginManifests";
import { errorToString } from "../../lib/errorToString";
import { showToast } from "../../stores/toastStore";
import { usePluginHomePinStore } from "../../stores/pluginHomePinStore";
import { usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { useSettingsStore } from "../../stores/settingsStore";

function HomeLaunchIcon({ entry }: { entry: EligibleHomePlugin }) {
  const [src, setSrc] = useState<string | null>(null);
  const theme = useSettingsStore((s) => s.resolved);
  const iconPath =
    resolvePluginIconPath(getPluginManifest(entry.pluginId), theme) ?? entry.home.icon;
  useEffect(() => {
    let cancelled = false;
    void loadPluginIcon(entry.pluginId, iconPath).then((next) => {
      if (!cancelled) setSrc(next);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.pluginId, iconPath]);

  if (src) {
    return <img src={src} alt="" />;
  }
  const letter = resolveHomeTitle(entry.home).trim().charAt(0) || "?";
  return <span className="home-board-launch__letter">{letter}</span>;
}

export function PluginHomeLaunchStrip() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const items = usePluginRuntimeStore((s) => s.items);
  const hydrated = usePluginRuntimeStore((s) => s.hydrated);
  const hiddenIds = usePluginHomePinStore((s) => s.hiddenIds);
  const order = usePluginHomePinStore((s) => s.order);

  useEffect(() => {
    void usePluginRuntimeStore.getState().hydrate();
  }, []);

  const pinned = useMemo(
    () => listPinnedHomePlugins(items, hiddenIds, order),
    [items, hiddenIds, order],
  );

  if (!hydrated || pinned.length === 0) return null;

  return (
    <section className="home-board-launch" aria-label={t("dashboard.pluginLaunch")}>
      {pinned.map((entry) => {
        const title = resolveHomeTitle(entry.home);
        return (
          <button
            key={entry.pluginId}
            type="button"
            className="home-board-launch__item"
            title={title}
            onClick={() => {
              void openPluginHome(entry, navigate).catch((err) => {
                showToast(errorToString(err));
              });
            }}
          >
            <span className="home-board-launch__icon">
              <HomeLaunchIcon entry={entry} />
            </span>
            <span className="home-board-launch__label">{title}</span>
          </button>
        );
      })}
    </section>
  );
}
