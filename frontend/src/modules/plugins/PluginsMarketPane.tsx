import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { PluginListItem } from "../../ipc/bindings";
import { IconChevronLeft, IconChevronRight, IconGrid, IconList } from "../../components/ui/icons/Icons";
import { Select } from "../../components/ui/form/Select";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { originMetaLabel } from "./pluginOrigin";
import { PluginGlyph } from "./pluginGlyph";
import {
  EXTERNAL_CATEGORIES,
  MARKET_PAGE_SIZE_DEFAULT,
  MARKET_PAGE_SIZE_OPTIONS,
  MARKET_SORT_DEFAULT_DIR,
  MARKET_SORT_KEYS,
  formatPluginCount,
  formatPluginDate,
  paginateItems,
  sortMarketItems,
  type ExternalCategory,
  type KindFilter,
  type MarketFilter,
  type MarketItem,
  type MarketSortDir,
  type MarketSortKey,
  type MarketView,
} from "./pluginCenterTypes";

const VIEW_STORAGE_KEY = "omnipanel.pluginCenter.marketView";
const PAGE_SIZE_STORAGE_KEY = "omnipanel.pluginCenter.marketPageSize";
const SORT_STORAGE_KEY = "omnipanel.pluginCenter.marketSort";

function readMarketView(): MarketView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    return raw === "list" || raw === "grid" ? raw : "grid";
  } catch {
    return "grid";
  }
}

function persistMarketView(view: MarketView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* ignore quota / private mode */
  }
}

function readPageSize(): number {
  try {
    const raw = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    if ((MARKET_PAGE_SIZE_OPTIONS as readonly number[]).includes(raw)) return raw;
  } catch {
    /* ignore */
  }
  return MARKET_PAGE_SIZE_DEFAULT;
}

function persistPageSize(size: number) {
  try {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    /* ignore quota / private mode */
  }
}

type StoredSort = { key: MarketSortKey; dir: MarketSortDir };

function readMarketSort(): StoredSort {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? "");
    const key = MARKET_SORT_KEYS.includes(raw?.key) ? (raw.key as MarketSortKey) : "updated";
    const dir = raw?.dir === "asc" || raw?.dir === "desc" ? raw.dir : MARKET_SORT_DEFAULT_DIR[key];
    return { key, dir };
  } catch {
    return { key: "updated", dir: "desc" };
  }
}

function persistMarketSort(sort: StoredSort) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    /* ignore quota / private mode */
  }
}

function pageNumbers(page: number, total: number): number[] {
  const start = Math.max(1, page - 2);
  const end = Math.min(total, page + 2);
  const pages: number[] = [];
  for (let i = start; i <= end; i += 1) pages.push(i);
  return pages;
}

type Props = {
  kindFilter: KindFilter;
  marketFilter: MarketFilter;
  onMarketFilter: (filter: MarketFilter) => void;
  sourceFilters: { id: string; label: string }[];
  market: MarketItem[];
  installed: PluginListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  installingMarketId: string | null;
  catalogRefreshing: boolean;
  onInstallMarket: (item: MarketItem) => void;
  onUninstall: (item: PluginListItem) => void;
  busyId: string | null;
  onRefreshMarket: () => void;
  onOpenSources: () => void;
  npmSearching: boolean;
  npmActive: boolean;
  onSearchNpm: () => void;
  onClearNpmSearch: () => void;
  rubickEnabled: boolean;
  extCategory: ExternalCategory | "all";
  onExtCategory: (category: ExternalCategory | "all") => void;
};

function marketVersionParts(item: MarketItem): { current: string; latest: string | null } {
  const latest = item.version.trim();
  const installed = item.installedVersion?.trim() || "";
  const current = installed || latest;
  const showLatest = Boolean(item.needsUpdate && latest && installed && installed !== latest);
  return { current, latest: showLatest ? latest : null };
}

export function PluginsMarketPane({
  kindFilter,
  marketFilter,
  onMarketFilter,
  sourceFilters,
  market,
  installed,
  selectedId,
  onSelect,
  installingMarketId,
  catalogRefreshing,
  onInstallMarket,
  onUninstall,
  busyId,
  onRefreshMarket,
  onOpenSources,
  npmSearching,
  npmActive,
  onSearchNpm,
  onClearNpmSearch,
  rubickEnabled,
  extCategory,
  onExtCategory,
}: Props) {
  const { t, locale } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MarketView>(readMarketView);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<StoredSort>(readMarketSort);
  const installedById = useMemo(
    () => new Map(installed.map((item) => [item.id, item])),
    [installed],
  );

  const sortedMarket = useMemo(
    () => sortMarketItems(market, sort.key, sort.dir),
    [market, sort.dir, sort.key],
  );

  useEffect(() => {
    setPage(1);
  }, [kindFilter, marketFilter, view, market.length, pageSize, sort.key, sort.dir]);

  const paging = paginateItems(sortedMarket, page, pageSize);

  useEffect(() => {
    if (paging.page !== page) setPage(paging.page);
  }, [paging.page, page]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [paging.page, view]);

  const changeView = (next: MarketView) => {
    setView(next);
    persistMarketView(next);
  };

  const changeSortKey = (key: MarketSortKey) => {
    const next = { key, dir: MARKET_SORT_DEFAULT_DIR[key] };
    setSort(next);
    persistMarketSort(next);
  };

  const toggleSortDir = () => {
    const next = { ...sort, dir: (sort.dir === "asc" ? "desc" : "asc") as MarketSortDir };
    setSort(next);
    persistMarketSort(next);
  };

  const sortOptions = MARKET_SORT_KEYS.map((key) => ({
    value: key,
    label: t(`plugins.center.sort.${key}`),
  }));

  return (
    <section className="plugin-center-col plugin-center-col--market">
      <div className="plugin-center-col__head">
        <h2>{t("plugins.center.marketCount", { count: market.length })}</h2>
        <div className="plugin-center-filters" role="group" aria-label={t("plugins.center.market")}>
          <button
            type="button"
            className={`plugin-center-chip${marketFilter === "all" ? " is-active" : ""}`}
            onClick={() => onMarketFilter("all")}
          >
            {t("plugins.center.filter.all")}
          </button>
          <button
            type="button"
            className={`plugin-center-chip${marketFilter === "official" ? " is-active" : ""}`}
            onClick={() => onMarketFilter("official")}
          >
            {t("plugins.center.filter.official")}
          </button>
          {sourceFilters.map((source) => (
            <button
              key={source.id}
              type="button"
              className={`plugin-center-chip${marketFilter === source.id ? " is-active" : ""}`}
              onClick={() => onMarketFilter(source.id)}
            >
              {source.label}
            </button>
          ))}
        </div>
        {market.some((item) => item.sourceId === "rubick") ? (
          <div className="plugin-center-filters" role="group" aria-label={t("plugins.center.extCats.label")}>
            {(["all", ...EXTERNAL_CATEGORIES] as const).map((category) => (
              <button
                key={category}
                type="button"
                className={`plugin-center-chip${extCategory === category ? " is-active" : ""}`}
                onClick={() => onExtCategory(category)}
              >
                {t(`plugins.center.extCats.${category}`)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="plugin-center-sort">
          <Select
            size="sm"
            value={sort.key}
            onChange={(value) => changeSortKey(value as MarketSortKey)}
            options={sortOptions}
            searchable={false}
            aria-label={t("plugins.center.sort.label")}
            title={t("plugins.center.sort.label")}
            panelMinWidth={140}
          />
          <button
            type="button"
            className="plugin-center-chip"
            aria-label={t("plugins.center.sort.dir")}
            title={t("plugins.center.sort.dir")}
            onClick={toggleSortDir}
          >
            {sort.dir === "asc" ? t("plugins.center.sort.asc") : t("plugins.center.sort.desc")}
          </button>
        </div>
        <div className="plugin-center-view" role="group" aria-label={t("plugins.center.viewList")}>
          <button
            type="button"
            className={`btn-icon${view === "list" ? " is-active" : ""}`}
            aria-pressed={view === "list"}
            title={t("plugins.center.viewList")}
            onClick={() => changeView("list")}
          >
            <IconList size={16} />
          </button>
          <button
            type="button"
            className={`btn-icon${view === "grid" ? " is-active" : ""}`}
            aria-pressed={view === "grid"}
            title={t("plugins.center.viewGrid")}
            onClick={() => changeView("grid")}
          >
            <IconGrid size={16} />
          </button>
        </div>
        <WorkbenchActionButton onClick={onOpenSources}>
          {t("plugins.sources.title")}
        </WorkbenchActionButton>
        <WorkbenchActionButton disabled={catalogRefreshing} onClick={onRefreshMarket}>
          {t("plugins.center.refresh")}
        </WorkbenchActionButton>
        {rubickEnabled ? (
          npmActive ? (
            <WorkbenchActionButton onClick={onClearNpmSearch}>
              {t("plugins.center.clearNpmSearch")}
            </WorkbenchActionButton>
          ) : (
            <WorkbenchActionButton disabled={npmSearching} onClick={onSearchNpm}>
              {npmSearching ? t("plugins.center.searching") : t("plugins.center.searchNpm")}
            </WorkbenchActionButton>
          )
        ) : null}
      </div>
      <div
        ref={listRef}
        className={view === "grid" ? "plugin-center-grid" : "plugin-center-list"}
      >
        {paging.slice.map((item) =>
          view === "grid" ? (
            <MarketCard
              key={`${item.origin}:${item.id}`}
              item={item}
              installed={installedById.get(item.id) ?? null}
              selected={selectedId === item.id}
              installing={installingMarketId === item.id}
              uninstalling={busyId === item.id}
              locale={locale}
              onSelect={onSelect}
              onInstall={onInstallMarket}
              onUninstall={onUninstall}
            />
          ) : (
            <MarketRow
              key={`${item.origin}:${item.id}`}
              item={item}
              installed={installedById.get(item.id) ?? null}
              selected={selectedId === item.id}
              installing={installingMarketId === item.id}
              uninstalling={busyId === item.id}
              locale={locale}
              onSelect={onSelect}
              onInstall={onInstallMarket}
              onUninstall={onUninstall}
            />
          ),
        )}
        {market.length === 0 ? (
          <p className="plugin-center-empty">{t("plugins.center.emptyMarket")}</p>
        ) : null}
      </div>
      {market.length > 0 ? (
        <nav className="plugin-center-pager" aria-label={t("plugins.center.pageInfo", {
          from: paging.from,
          to: paging.to,
          total: market.length,
        })}>
          {paging.totalPages > 1 ? (
            <>
              <button
                type="button"
                className="btn-icon"
                disabled={paging.page <= 1}
                title={t("plugins.center.pagePrev")}
                onClick={() => setPage(paging.page - 1)}
              >
                <IconChevronLeft size={16} />
              </button>
              {pageNumbers(paging.page, paging.totalPages).map((num) => (
                <button
                  key={num}
                  type="button"
                  className={`plugin-center-pager__page${num === paging.page ? " is-active" : ""}`}
                  onClick={() => setPage(num)}
                >
                  {num}
                </button>
              ))}
              <button
                type="button"
                className="btn-icon"
                disabled={paging.page >= paging.totalPages}
                title={t("plugins.center.pageNext")}
                onClick={() => setPage(paging.page + 1)}
              >
                <IconChevronRight size={16} />
              </button>
            </>
          ) : null}
          <span className="plugin-center-pager__info">
            {t("plugins.center.pageInfo", {
              from: paging.from,
              to: paging.to,
              total: market.length,
            })}
          </span>
          <label className="plugin-center-pager__size">
            <Select
              size="sm"
              searchable={false}
              className="plugin-center-pager__select"
              value={String(pageSize)}
              aria-label={t("plugins.center.pageSize")}
              title={t("plugins.center.pageSize")}
              panelMinWidth={108}
              options={MARKET_PAGE_SIZE_OPTIONS.map((size) => ({
                value: String(size),
                label: t("plugins.center.pageSizeOption", { count: size }),
              }))}
              onChange={(value) => {
                const next = Number(value);
                setPageSize(next);
                persistPageSize(next);
              }}
            />
          </label>
        </nav>
      ) : null}
    </section>
  );
}

function marketMetaBits(
  item: MarketItem,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): string[] {
  const bits = [originMetaLabel(item.origin, t, { dbx: Boolean(item.dbxKey), rubick: item.sourceId === "rubick" }), t(`plugins.center.kinds.${item.kind}`)];
  const updated = formatPluginDate(item.updatedAt, locale);
  if (updated) bits.push(t("plugins.center.updatedAt", { time: updated }));
  if (item.downloads != null && item.downloads > 0) {
    bits.push(t("plugins.center.downloads", { count: formatPluginCount(item.downloads) }));
  } else if (item.localInstalls > 0) {
    bits.push(t("plugins.center.downloadsLocal", { count: formatPluginCount(item.localInstalls) }));
  }
  return bits;
}

/** 标题旁只显示当前版本；新版本仅出现在右上角标。 */
function MarketVersionLine({ item }: { item: MarketItem }) {
  const { t } = useI18n();
  const { current } = marketVersionParts(item);
  if (!current) return null;
  return (
    <span className="plugin-center-card__versions">
      <span className="plugin-center-card__version" title={t("plugins.center.currentVersion")}>
        v{current}
      </span>
    </span>
  );
}

/** 右下角：未安装→安装；已装有更新→更新+卸载；已装无更新→卸载；内置不可卸→文案。 */
function MarketAction({
  item,
  installed,
  installing,
  uninstalling,
  onInstall,
  onUninstall,
}: {
  item: MarketItem;
  installed: PluginListItem | null;
  installing: boolean;
  uninstalling: boolean;
  onInstall: (item: MarketItem) => void;
  onUninstall: (item: PluginListItem) => void;
}) {
  const { t } = useI18n();
  const bundled = item.distribution === "bundled" || installed?.source === "builtin";
  const isExternal = item.externalNpm != null && item.externalNpm.trim() !== "";
  // 市场标记已装即可卸；无 PluginListItem 时用目录 id 拼最小项，避免按钮整行消失
  const uninstallTarget: PluginListItem | null =
    installed ??
    (item.installed
      ? {
          id: item.id,
          version: item.installedVersion ?? item.version,
          kind: item.kind,
          enabled: true,
          activated: true,
          source: "installed",
          unsupportedReason: null,
        }
      : null);
  const canUninstall = Boolean(uninstallTarget) && !bundled;

  if (!item.installed) {
    return (
      <div className="plugin-center-card__actions">
        <WorkbenchActionButton
          className="plugin-center-card__btn"
          disabled={installing}
          onClick={(event) => {
            event.stopPropagation();
            onInstall(item);
          }}
        >
          {installing
            ? t("plugins.catalog.installing")
            : isExternal
              ? t("plugins.center.convertInstall")
              : t("plugins.catalog.install")}
        </WorkbenchActionButton>
      </div>
    );
  }

  if (bundled && !item.needsUpdate) {
    return <span className="plugin-center-row__status">{t("plugins.center.bundled")}</span>;
  }

  if (item.needsUpdate) {
    return (
      <div className="plugin-center-card__actions">
        <WorkbenchActionButton
          className="plugin-center-card__btn"
          disabled={installing || uninstalling}
          onClick={(event) => {
            event.stopPropagation();
            onInstall(item);
          }}
        >
          {installing ? t("plugins.catalog.installing") : t("plugins.catalog.update")}
        </WorkbenchActionButton>
        {canUninstall && uninstallTarget ? (
          <WorkbenchActionButton
            className="plugin-center-card__btn"
            danger
            disabled={installing || uninstalling}
            onClick={(event) => {
              event.stopPropagation();
              onUninstall(uninstallTarget);
            }}
          >
            {t("plugins.uninstall")}
          </WorkbenchActionButton>
        ) : null}
      </div>
    );
  }

  if (canUninstall && uninstallTarget) {
    return (
      <div className="plugin-center-card__actions">
        <WorkbenchActionButton
          className="plugin-center-card__btn"
          danger
          disabled={uninstalling}
          onClick={(event) => {
            event.stopPropagation();
            onUninstall(uninstallTarget);
          }}
        >
          {t("plugins.uninstall")}
        </WorkbenchActionButton>
      </div>
    );
  }

  return <span className="plugin-center-row__status">{t("plugins.catalog.installed")}</span>;
}

function MarketRow({
  item,
  installed,
  selected,
  installing,
  uninstalling,
  locale,
  onSelect,
  onInstall,
  onUninstall,
}: {
  item: MarketItem;
  installed: PluginListItem | null;
  selected: boolean;
  installing: boolean;
  uninstalling: boolean;
  locale: string;
  onSelect: (id: string) => void;
  onInstall: (item: MarketItem) => void;
  onUninstall: (item: PluginListItem) => void;
}) {
  const { t } = useI18n();
  const meta = marketMetaBits(item, t, locale);
  const versions = marketVersionParts(item);
  return (
    <div className={`plugin-center-row plugin-center-row--split${selected ? " is-active" : ""}`}>
      {item.needsUpdate && versions.latest ? (
        <span className="plugin-center-card__corner" title={t("plugins.center.latestVersion")}>
          v{versions.latest}
        </span>
      ) : null}
      <button type="button" className="plugin-center-row__hit plugin-center-row__hit--icon" onClick={() => onSelect(item.id)}>
        <PluginGlyph pluginId={item.id} kind={item.kind} name={item.name} size="sm" fromDbx={Boolean(item.dbxKey)} />
        <span className="plugin-center-row__body">
          <span className="plugin-center-row__name-row">
            <span className="plugin-center-row__name">{item.name}</span>
            <MarketVersionLine item={item} />
          </span>
          <span className="plugin-center-row__meta">{meta.join(" · ")}</span>
        </span>
      </button>
      <MarketAction
        item={item}
        installed={installed}
        installing={installing}
        uninstalling={uninstalling}
        onInstall={onInstall}
        onUninstall={onUninstall}
      />
    </div>
  );
}

function MarketCard({
  item,
  installed,
  selected,
  installing,
  uninstalling,
  locale,
  onSelect,
  onInstall,
  onUninstall,
}: {
  item: MarketItem;
  installed: PluginListItem | null;
  selected: boolean;
  installing: boolean;
  uninstalling: boolean;
  locale: string;
  onSelect: (id: string) => void;
  onInstall: (item: MarketItem) => void;
  onUninstall: (item: PluginListItem) => void;
}) {
  const { t } = useI18n();
  const versions = marketVersionParts(item);
  const desc =
    item.description.trim() ||
    (item.dbxKey
      ? t("plugins.center.sourceDbx")
      : `${t(`plugins.center.kinds.${item.kind}`)} · v${item.version}`);
  return (
    <div className={`plugin-center-card${selected ? " is-active" : ""}`}>
      {item.needsUpdate && versions.latest ? (
        <span className="plugin-center-card__corner" title={t("plugins.center.latestVersion")}>
          v{versions.latest}
        </span>
      ) : null}
      <button type="button" className="plugin-center-card__hit" onClick={() => onSelect(item.id)}>
        <span className="plugin-center-card__top">
          <PluginGlyph pluginId={item.id} kind={item.kind} name={item.name} size="md" fromDbx={Boolean(item.dbxKey)} />
          <span className="plugin-center-card__titles">
            <span className="plugin-center-card__name-row">
              <span className="plugin-center-card__name">{item.name}</span>
              <MarketVersionLine item={item} />
            </span>
            <span className="plugin-center-card__meta">{marketMetaBits(item, t, locale).join(" · ")}</span>
          </span>
        </span>
        <span className="plugin-center-card__desc">{desc}</span>
      </button>
      <div className="plugin-center-card__action">
        <MarketAction
          item={item}
          installed={installed}
          installing={installing}
          uninstalling={uninstalling}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />
      </div>
    </div>
  );
}
