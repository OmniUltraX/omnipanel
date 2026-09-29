import type { PluginListItem } from "../../ipc/bindings";
import { IconDownload, IconSettings, IconTrash } from "../../components/ui/Icons";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { useI18n } from "../../i18n";
import { pluginDisplayName } from "./pluginDisplayName";
import { isDbxCatalog, originMetaLabel, type PluginOrigin } from "./pluginOrigin";
import { groupInstalledByKind, type KindFilter } from "./pluginCenterTypes";
import { PluginGlyph } from "./pluginGlyph";

type Props = {
  kindFilter: KindFilter;
  installed: PluginListItem[];
  selectedId: string | null;
  busyId: string | null;
  /** 有可用更新的插件 id（来自市场目录）。 */
  updateIds: ReadonlySet<string>;
  updatingId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onUninstall: (item: PluginListItem) => void;
  onUpdate: (id: string) => void;
  originOf: (item: PluginListItem) => PluginOrigin;
  dbxIds: ReadonlySet<string>;
  devIds: ReadonlySet<string>;
  installing: boolean;
  onInstallFile: () => void;
};

export function PluginsSidebar({
  kindFilter,
  installed,
  selectedId,
  busyId,
  updateIds,
  updatingId,
  onSelect,
  onOpenSettings,
  onUninstall,
  onUpdate,
  originOf,
  dbxIds,
  devIds,
  installing,
  onInstallFile,
}: Props) {
  const { t } = useI18n();
  const groups = kindFilter === "all" ? groupInstalledByKind(installed) : null;
  const rowProps = (item: PluginListItem) => ({
    item,
    selected: selectedId === item.id,
    busy: busyId === item.id || updatingId === item.id,
    needsUpdate: updateIds.has(item.id),
    fromDbx: isDbxCatalog(item.id, dbxIds),
    originLabel: originMetaLabel(originOf(item), t, {
      dbx: isDbxCatalog(item.id, dbxIds),
    }),
    devBadge: devIds.has(item.id) ? t("plugins.center.devBadge") : null,
    disabledLabel: t("settings.plugins.disabled"),
    onSelect,
    onOpenSettings,
    onUninstall,
    onUpdate,
    tName: pluginDisplayName(item.id, t),
    settingsLabel: t("plugins.settings.action"),
    uninstallLabel: t("plugins.uninstall"),
    updateLabel: t("plugins.catalog.update"),
  });

  return (
    <aside className="plugin-center-col plugin-center-col--installed">
      <div className="plugin-center-col__head">
        <h2>{t("plugins.center.installedCount", { count: installed.length })}</h2>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={installing}
          onClick={onInstallFile}
        >
          {t("plugins.install.action")}
        </button>
      </div>
      <div className="plugin-center-list">
        {groups
          ? groups.map((group) => (
              <section key={group.kind} className="plugin-center-group">
                <h3 className="plugin-center-group__title">
                  {t(`plugins.center.kinds.${group.kind}`)}
                </h3>
                {group.items.map((item) => (
                  <InstalledRow key={item.id} {...rowProps(item)} />
                ))}
              </section>
            ))
          : installed.map((item) => <InstalledRow key={item.id} {...rowProps(item)} />)}
        {installed.length === 0 ? (
          <p className="plugin-center-empty">{t("plugins.center.emptyInstalled")}</p>
        ) : null}
      </div>
    </aside>
  );
}

function InstalledRow({
  item,
  selected,
  busy,
  needsUpdate,
  fromDbx,
  originLabel,
  devBadge,
  disabledLabel,
  onSelect,
  onOpenSettings,
  onUninstall,
  onUpdate,
  tName,
  settingsLabel,
  uninstallLabel,
  updateLabel,
}: {
  item: PluginListItem;
  selected: boolean;
  busy: boolean;
  needsUpdate: boolean;
  fromDbx: boolean;
  originLabel: string;
  devBadge: string | null;
  disabledLabel: string;
  onSelect: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onUninstall: (item: PluginListItem) => void;
  onUpdate: (id: string) => void;
  tName: string;
  settingsLabel: string;
  uninstallLabel: string;
  updateLabel: string;
}) {
  const canUninstall = item.source === "installed";

  return (
    <div
      className={`plugin-center-row plugin-center-row--split${selected ? " is-active" : ""}`}
    >
      <button
        type="button"
        className="plugin-center-row__hit plugin-center-row__hit--icon"
        onClick={() => onSelect(item.id)}
      >
        <PluginGlyph pluginId={item.id} kind={item.kind} name={tName} size="sm" fromDbx={fromDbx} />
        <span className="plugin-center-row__body">
          <span className="plugin-center-row__name">{tName}</span>
          <span className="plugin-center-row__meta">
            {devBadge ? `${devBadge} · ${originLabel}` : originLabel}
            {item.enabled ? "" : ` · ${disabledLabel}`}
          </span>
        </span>
      </button>
      <div className="plugin-center-row__actions">
        {needsUpdate ? (
          <WorkbenchActionButton
            icon={true}
            className="plugin-center-row__update-btn"
            disabled={busy}
            title={updateLabel}
            aria-label={updateLabel}
            onClick={() => onUpdate(item.id)}
          >
            <IconDownload size={14} />
          </WorkbenchActionButton>
        ) : null}
        <WorkbenchActionButton
          icon={true}
          disabled={busy}
          title={settingsLabel}
          aria-label={settingsLabel}
          onClick={() => onOpenSettings(item.id)}
        >
          <IconSettings size={14} />
        </WorkbenchActionButton>
        {canUninstall ? (
          <WorkbenchActionButton
            icon={true}
            danger={true}
            disabled={busy}
            title={uninstallLabel}
            aria-label={uninstallLabel}
            onClick={() => onUninstall(item)}
          >
            <IconTrash size={14} />
          </WorkbenchActionButton>
        ) : null}
      </div>
    </div>
  );
}
