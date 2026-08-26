import { useMemo } from "react";
import { useI18n } from "../../../i18n";
import { getEngineIcon, type DbEngine } from "./engineIcons";
import {
  ENGINE_PICKER_CATEGORIES,
  categoriesWithItems,
  filterPickerItems,
  isEngineInstalling,
  type EnginePickerCategoryKey,
  type EnginePickerItem,
} from "./enginePicker";

type ConnectionEnginePickerProps = {
  items: EnginePickerItem[];
  selectedId: string;
  category: EnginePickerCategoryKey;
  search: string;
  installingKey: string | null;
  theme: "light" | "dark";
  onCategoryChange: (key: EnginePickerCategoryKey) => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: DbEngine) => void;
  onInstall: (item: EnginePickerItem) => void;
  onUpgrade: (item: EnginePickerItem) => void;
  onUninstall: (item: EnginePickerItem) => void;
};

type Translate = (key: string, params?: Record<string, string | number>) => string;

function chipTitle(t: Translate, item: EnginePickerItem, disabled: boolean): string {
  const parts = [item.label];
  if (item.fromDbx) parts.push(t("database.dialog.engineSourceDbx"));
  if (disabled) parts.push(t("database.dialog.engineNotInstalled"));
  return parts.join(" · ");
}

export function ConnectionEnginePicker({
  items,
  selectedId,
  category,
  search,
  installingKey,
  theme,
  onCategoryChange,
  onSearchChange,
  onSelect,
  onInstall,
  onUpgrade,
  onUninstall,
}: ConnectionEnginePickerProps) {
  const { t } = useI18n();
  const visibleCategories = useMemo(() => categoriesWithItems(items), [items]);
  const visibleItems = useMemo(
    () => filterPickerItems(items, category, search),
    [items, category, search],
  );
  const searching = search.trim().length > 0;

  return (
    <div className="engine-picker">
      <nav className="engine-picker-nav" aria-label={t("database.dialog.engine")}>
        {ENGINE_PICKER_CATEGORIES.filter((entry) => visibleCategories.includes(entry.key)).map(
          (entry) => {
            const count = items.filter((item) => item.category === entry.key).length;
            const active = !searching && category === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                className={`engine-picker-nav-item${active ? " engine-picker-nav-item--active" : ""}`}
                onClick={() => {
                  onCategoryChange(entry.key);
                  if (searching) onSearchChange("");
                }}
              >
                <span>{t(entry.titleKey)}</span>
                <span className="engine-picker-nav-count">{count}</span>
              </button>
            );
          },
        )}
      </nav>
      <div className="engine-picker-main">
        <input
          className="input engine-picker-search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("database.dialog.engineSearch")}
          aria-label={t("database.dialog.engineSearch")}
        />
        {visibleItems.length === 0 ? (
          <div className="engine-picker-empty">{t("database.dialog.engineEmpty")}</div>
        ) : (
          <div className="engine-grid engine-grid--picker">
            {visibleItems.map((item) => {
              const iconUrl = getEngineIcon(item.id, theme);
              const installing = isEngineInstalling(installingKey, item.catalogKey);
              const disabled = !item.available;
              const active = item.available && selectedId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`engine-chip${active ? " engine-chip--active" : ""}${disabled ? " engine-chip--disabled" : ""}${item.fromDbx ? " engine-chip--dbx" : ""}`}
                  disabled={installing}
                  title={chipTitle(t, item, disabled)}
                  onClick={() => {
                    if (item.available) {
                      onSelect(item.id);
                      return;
                    }
                    if (item.catalogKey) onInstall(item);
                  }}
                >
                  {item.fromDbx ? (
                    <span className="engine-chip-source" aria-hidden>
                      {t("database.dialog.engineSourceDbx")}
                    </span>
                  ) : null}
                  <span className="engine-chip-icon">
                    {iconUrl ? (
                      <img src={iconUrl} alt="" className="engine-chip-logo" draggable={false} />
                    ) : (
                      item.icon
                    )}
                  </span>
                  <span className="engine-chip-label">{item.label}</span>
                  {installing ? (
                    <span className="engine-chip-badge">{t("database.dialog.engineInstalling")}</span>
                  ) : disabled ? (
                    <span className="engine-chip-badge">{t("database.dialog.enginePending")}</span>
                  ) : (
                    <span className="engine-chip-actions">
                      {item.needsUpgrade ? (
                        <span
                          className="engine-chip-badge engine-chip-badge--action"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onUpgrade(item);
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          {t("database.dialog.engineUpgrade")}
                        </span>
                      ) : null}
                      {item.fromDbx && item.pluginId ? (
                        <span
                          className="engine-chip-badge engine-chip-badge--action"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onUninstall(item);
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          {t("database.dialog.engineUninstall")}
                        </span>
                      ) : null}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
