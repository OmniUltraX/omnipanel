import type { PluginKind } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { getPluginManifest } from "../../lib/pluginManifests";
import { getEngineDescriptor } from "../database/engineRegistry";
import {
  IconDatabase,
  IconDownload,
  IconGlobe,
  IconGrid,
  IconImage,
  IconMonitor,
  IconWrench,
} from "../../components/ui/icons/Icons";
import { getPluginMarketIcon } from "./pluginMarketIcons";

const SIZE_PX = { sm: 22, md: 32, lg: 40 } as const;

function KindMark({ kind, size }: { kind: PluginKind; size: number }) {
  const iconSize = Math.max(12, Math.round(size * 0.55));
  switch (kind) {
    case "engine":
      return <IconDatabase size={iconSize} />;
    case "importer":
      return <IconDownload size={iconSize} />;
    case "panel":
      return <IconMonitor size={iconSize} />;
    case "cloud":
      return <IconGlobe size={iconSize} />;
    case "module":
      return <IconWrench size={iconSize} />;
    case "theme":
      return <IconImage size={iconSize} />;
    default:
      return <IconGrid size={iconSize} />;
  }
}

export function PluginGlyph({
  pluginId,
  kind,
  name,
  size = "md",
  fromDbx = false,
}: {
  pluginId: string;
  kind: PluginKind;
  name?: string;
  size?: keyof typeof SIZE_PX;
  fromDbx?: boolean;
}) {
  const { t } = useI18n();
  const theme = useSettingsStore((s) => s.resolved);
  const px = SIZE_PX[size];
  const iconUrl = getPluginMarketIcon(pluginId, kind, theme);
  const engineForm = kind === "engine" ? getPluginManifest(pluginId)?.contributes.ui?.connectionForm : null;
  const engineKey =
    engineForm && typeof engineForm === "object"
      ? String((engineForm as { engineKey?: unknown }).engineKey ?? "").trim() ||
        (pluginId.startsWith("omni.engine.") ? pluginId.slice("omni.engine.".length) : pluginId)
      : null;
  const letters =
    getEngineDescriptor(engineKey)?.icon ??
    (name?.trim().slice(0, 2) || pluginId.replace(/^omni\.[a-z]+\./, "").slice(0, 2)).toUpperCase();

  return (
    <span className={`plugin-center-glyph-wrap plugin-center-glyph-wrap--${size}`} aria-hidden>
      <span
        className={`plugin-center-glyph plugin-center-glyph--${size}${iconUrl ? "" : " plugin-center-glyph--fallback"}`}
        style={{ width: px, height: px }}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" draggable={false} />
        ) : kind === "engine" ? (
          <span className="plugin-center-glyph__letters">{letters}</span>
        ) : (
          <KindMark kind={kind} size={px} />
        )}
      </span>
      {fromDbx ? (
        <span className="plugin-center-glyph__dbx">{t("plugins.center.origin.dbx")}</span>
      ) : null}
    </span>
  );
}
