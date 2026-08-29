import type { PluginListItem } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { getPluginManifest } from "../../lib/pluginManifests";
import { parsePluginHomeContribution } from "../../lib/pluginHomeContribution";
import { openImporter } from "../importer/ImporterWizardDialog";
import { importerEntries, listActiveImporters, resolveImporterText } from "../../lib/importerCatalog";
import { pluginDisplayName } from "./pluginDisplayName";
import { isDbxOrigin, originLabelKey, type PluginOrigin } from "./pluginOrigin";
import { formatPluginSize, type MarketItem } from "./pluginCenterTypes";
import { PluginGlyph } from "./pluginGlyph";

const UNSUPPORTED_REASON_KEYS: Record<string, string> = {
  "platform.unsupported": "plugins.unsupported.platform",
};

function isAlwaysOnEngine(item: PluginListItem): boolean {
  return item.source === "builtin" && item.kind === "engine";
}

type Props = {
  installed: PluginListItem | null;
  market: MarketItem | null;
  origin: PluginOrigin | null;
  busyId: string | null;
  installingMarketId: string | null;
  homeHiddenIds: readonly string[];
  onToggle: (item: PluginListItem, enabled: boolean) => void;
  onUninstall: (item: PluginListItem) => void;
  onInstallMarket: (item: MarketItem) => void;
  onOpenOverlay: (id: string) => void;
  onHomePin: (id: string, pinned: boolean) => void;
};

export function PluginDetailPane({
  installed,
  market,
  origin,
  busyId,
  installingMarketId,
  homeHiddenIds,
  onToggle,
  onUninstall,
  onInstallMarket,
  onOpenOverlay,
  onHomePin,
}: Props) {
  const { t } = useI18n();
  const id = installed?.id ?? market?.id ?? null;
  if (!id) return null;

  const name = pluginDisplayName(id, t, market?.name);
  const kind = installed?.kind ?? market?.kind ?? "addon";
  const version = installed?.version ?? market?.version ?? "";
  const resolvedOrigin = origin ?? market?.origin ?? "local";
  const manifest = getPluginManifest(id);
  const permissions =
    manifest?.permissions?.length
      ? manifest.permissions
      : market?.permissions ?? [];
  const description =
    id === "omni.addon.everything"
      ? t("plugins.everything.hint")
      : market?.distribution === "bundled"
        ? ""
        : (market?.description?.trim() ?? "");
  const importers = installed
    ? listActiveImporters([installed]).filter((entry) =>
        importerEntries(entry.importer).includes("settings"),
      )
    : [];
  const canUninstall = installed?.source === "installed";
  const bundled = market?.distribution === "bundled" || installed?.source === "builtin";
  const fromDbx = isDbxOrigin(resolvedOrigin);
  const canDownload =
    Boolean(market) &&
    !bundled &&
    (!market?.installed || Boolean(market?.needsUpdate));
  const installing = installingMarketId === id;
  const unsupported = installed?.unsupportedReason
    ? UNSUPPORTED_REASON_KEYS[installed.unsupportedReason]
      ? t(UNSUPPORTED_REASON_KEYS[installed.unsupportedReason])
      : installed.unsupportedReason
    : null;
  const canOpen =
    Boolean(installed) &&
    (manifest?.contributes.overlays?.length ?? 0) > 0 &&
    Boolean(installed?.enabled) &&
    Boolean(installed?.activated);

  return (
    <div className="plugin-center-detail">
      <header className="plugin-center-detail__header">
        <PluginGlyph pluginId={id} kind={kind} name={name} size="md" fromDbx={fromDbx} />
        <div className="plugin-center-detail__titles">
          <h2>{name}</h2>
          <p className="plugin-center-detail__id">{id}</p>
        </div>
        <span className={`plugin-center-badge plugin-center-badge--${resolvedOrigin}`}>
          {fromDbx ? t("plugins.center.origin.dbx") : t(originLabelKey(resolvedOrigin))}
        </span>
      </header>
      <p className="plugin-center-detail__meta">
        {t(`plugins.center.kinds.${kind}`)} · v{version}
        {market?.artifactKind
          ? ` · ${market.artifactKind === "jar" ? t("plugins.catalog.jar") : t("plugins.catalog.native")}`
          : ""}
        {market && formatPluginSize(market.size) ? ` · ${formatPluginSize(market.size)}` : ""}
        {unsupported ? ` · ${unsupported}` : ""}
      </p>
      {fromDbx ? (
        <aside className="plugin-center-detail__source">
          <p className="plugin-center-detail__source-label">{t("plugins.center.sourceDbx")}</p>
          <p className="plugin-center-detail__source-hint">{t("plugins.center.sourceDbxHint")}</p>
        </aside>
      ) : null}
      {description ? <p className="plugin-center-detail__desc">{description}</p> : null}
      {permissions.length > 0 ? (
        <div className="plugin-center-perms">
          <span className="plugin-center-perms__label">{t("plugins.center.permissions")}</span>
          {permissions.map((perm) => (
            <code key={perm}>{perm}</code>
          ))}
        </div>
      ) : null}
      <div className="plugin-center-detail__actions">
        {canDownload && market ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={installing}
            onClick={() => onInstallMarket(market)}
          >
            {installing
              ? t("plugins.catalog.installing")
              : market.needsUpdate
                ? t("plugins.catalog.update")
                : t("plugins.center.get")}
          </button>
        ) : null}
        {bundled && !canDownload ? (
          <span className="plugin-center-detail__hint">{t("plugins.center.bundled")}</span>
        ) : null}
        {canOpen && installed ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busyId === installed.id}
            onClick={() => onOpenOverlay(installed.id)}
          >
            {t("plugins.openOverlay")}
          </button>
        ) : null}
        {installed && parsePluginHomeContribution(getPluginManifest(installed.id)) && installed.enabled && installed.activated ? (
          <label className="form-check">
            <input
              type="checkbox"
              checked={!homeHiddenIds.includes(installed.id)}
              disabled={busyId === installed.id}
              onChange={(event) => onHomePin(installed.id, event.target.checked)}
            />
            <span>{t("plugins.homePin")}</span>
          </label>
        ) : null}
        {installed && canUninstall ? (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busyId === installed.id}
            onClick={() => onUninstall(installed)}
          >
            {t("plugins.uninstall")}
          </button>
        ) : null}
        {installed ? (
          <label className="form-check">
            <input
              type="checkbox"
              checked={installed.enabled}
              disabled={
                busyId === installed.id ||
                Boolean(installed.unsupportedReason) ||
                isAlwaysOnEngine(installed)
              }
              onChange={(event) => onToggle(installed, event.target.checked)}
            />
            <span>
              {installed.enabled ? t("settings.plugins.enabled") : t("settings.plugins.disabled")}
            </span>
          </label>
        ) : null}
      </div>
      {importers.map((entry) => (
        <div key={`${entry.pluginId}:${entry.importer.id}`} className="plugin-center-importer">
          <div>
            <h4>{resolveImporterText(entry.importer.title, t)}</h4>
            <p>{resolveImporterText(entry.importer.hint, t)}</p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => openImporter(entry.pluginId, entry.importer.id)}
          >
            {t("plugins.importer.open")}
          </button>
        </div>
      ))}
    </div>
  );
}
