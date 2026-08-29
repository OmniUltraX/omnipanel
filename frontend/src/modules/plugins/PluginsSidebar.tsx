import type { PluginListItem } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { pluginDisplayName } from "./pluginDisplayName";
import { isDbxOrigin, originMetaLabel, type PluginOrigin } from "./pluginOrigin";
import { groupInstalledByKind, type KindFilter } from "./pluginCenterTypes";
import { PluginGlyph } from "./pluginGlyph";

type Props = {
  kindFilter: KindFilter;
  installed: PluginListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  originOf: (item: PluginListItem) => PluginOrigin;
  installing: boolean;
  onInstallFile: () => void;
};

export function PluginsSidebar({
  kindFilter,
  installed,
  selectedId,
  onSelect,
  originOf,
  installing,
  onInstallFile,
}: Props) {
  const { t } = useI18n();
  const groups = kindFilter === "all" ? groupInstalledByKind(installed) : null;

  return (
    <aside className="plugin-center-col plugin-center-col--installed">
      <div className="plugin-center-col__head">
        <h2>
          {t("plugins.center.installedCount", { count: installed.length })}
        </h2>
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
                <h3 className="plugin-center-group__title">{t(`plugins.center.kinds.${group.kind}`)}</h3>
                {group.items.map((item) => (
                  <InstalledRow
                    key={item.id}
                    item={item}
                    selected={selectedId === item.id}
                    fromDbx={isDbxOrigin(originOf(item))}
                    originLabel={originMetaLabel(originOf(item), t)}
                    disabledLabel={t("settings.plugins.disabled")}
                    onSelect={onSelect}
                    tName={pluginDisplayName(item.id, t)}
                  />
                ))}
              </section>
            ))
          : installed.map((item) => (
              <InstalledRow
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                fromDbx={isDbxOrigin(originOf(item))}
                originLabel={originMetaLabel(originOf(item), t)}
                disabledLabel={t("settings.plugins.disabled")}
                onSelect={onSelect}
                tName={pluginDisplayName(item.id, t)}
              />
            ))}
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
  fromDbx,
  originLabel,
  disabledLabel,
  onSelect,
  tName,
}: {
  item: PluginListItem;
  selected: boolean;
  fromDbx: boolean;
  originLabel: string;
  disabledLabel: string;
  onSelect: (id: string) => void;
  tName: string;
}) {
  return (
    <button
      type="button"
      className={`plugin-center-row plugin-center-row--installed${selected ? " is-active" : ""}`}
      onClick={() => onSelect(item.id)}
    >
      <PluginGlyph pluginId={item.id} kind={item.kind} name={tName} size="sm" fromDbx={fromDbx} />
      <span className="plugin-center-row__body">
        <span className="plugin-center-row__name">{tName}</span>
        <span className="plugin-center-row__meta">
          {originLabel}
          {item.enabled ? "" : ` · ${disabledLabel}`}
        </span>
      </span>
    </button>
  );
}
