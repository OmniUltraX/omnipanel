import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { getPluginManifest } from "../../lib/pluginManifests";
import type { PluginListItem } from "../../ipc/bindings";
import { IconChevronLeft, IconChevronRight, IconGrid, IconList } from "../../components/ui/icons/Icons";
import { Select } from "../../components/ui/form/Select";
import { isDbxOrigin, originMetaLabel } from "./pluginOrigin";
import { PluginGlyph } from "./pluginGlyph";
import {
  MARKET_PAGE_SIZE_DEFAULT,
  MARKET_PAGE_SIZE_OPTIONS,
  MARKET_SORT_DEFAULT_DIR,
  MARKET_SORT_KEYS,
  formatPluginCount,
  formatPluginDate,
  paginateItems,
  sortMarketItems,
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
  market: MarketItem[];
  installed: PluginListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  installingMarketId: string | null;
  catalogRefreshing: boolean;
  onInstallMarket: (item: MarketItem) => void;
  onOpenOverlay: (id: string) => void;
  onRefreshMarket: () => void;
};

export function PluginsMarketPane({
  kindFilter,
  marketFilter,
  onMarketFilter,
  market,
  installed,
  selectedId,
  onSelect,
  installingMarketId,
  catalogRefreshing,
  onInstallMarket,
  onOpenOverlay,
  onRefreshMarket,
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
          {(["all", "official", "thirdParty"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={`plugin-center-chip${marketFilter === filter ? " is-active" : ""}`}
              onClick={() => onMarketFilter(filter)}
            >
              {t(`plugins.center.filter.${filter}`)}
            </button>
          ))}
        </div>
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
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={catalogRefreshing}
          onClick={onRefreshMarket}
        >
          {t("plugins.center.refresh")}
        </button>
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
              locale={locale}
              onSelect={onSelect}
              onInstall={onInstallMarket}
              onOpen={onOpenOverlay}
            />
          ) : (
            <MarketRow
              key={`${item.origin}:${item.id}`}
              item={item}
              installed={installedById.get(item.id) ?? null}
              selected={selectedId === item.id}
              installing={installingMarketId === item.id}
              locale={locale}
              onSelect={onSelect}
              onInstall={onInstallMarket}
              onOpen={onOpenOverlay}
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

function canOpenOverlay(item: PluginListItem | null): boolean {
  return Boolean(
    item &&
      item.enabled &&
      item.activated &&
      (getPluginManifest(item.id)?.contributes.overlays?.length ?? 0) > 0,
  );
}

function marketMetaBits(
  item: MarketItem,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): string[] {
  const bits = [originMetaLabel(item.origin, t), t(`plugins.center.kinds.${item.kind}`)];
  const updated = formatPluginDate(item.updatedAt, locale);
  if (updated) bits.push(t("plugins.center.updatedAt", { time: updated }));
  if (item.downloads != null && item.downloads > 0) {
    bits.push(t("plugins.center.downloads", { count: formatPluginCount(item.downloads) }));
  } else if (item.localInstalls > 0) {
    bits.push(t("plugins.center.downloadsLocal", { count: formatPluginCount(item.localInstalls) }));
  }
  return bits;
}

function MarketAction({
  item,
  installed,
  installing,
  onInstall,
  onOpen,
}: {
  item: MarketItem;
  installed: PluginListItem | null;
  installing: boolean;
  onInstall: (item: MarketItem) => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const bundled = item.distribution === "bundled" || installed?.source === "builtin";
  const canDownload = !bundled && (!item.installed || item.needsUpdate);
  const openable = canOpenOverlay(installed);

  if (canDownload) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={installing}
        onClick={(event) => {
          event.stopPropagation();
          onInstall(item);
        }}
      >
        {installing
          ? t("plugins.catalog.installing")
          : item.needsUpdate
            ? t("plugins.catalog.update")
            : t("plugins.center.get")}
      </button>
    );
  }
  if (openable && installed) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={(event) => {
          event.stopPropagation();
          void onOpen(installed.id);
        }}
      >
        {t("plugins.openOverlay")}
      </button>
    );
  }
  if (item.installed || bundled) {
    return <span className="plugin-center-row__status">{t("plugins.catalog.installed")}</span>;
  }
  return null;
}

function MarketRow({
  item,
  installed,
  selected,
  installing,
  locale,
  onSelect,
  onInstall,
  onOpen,
}: {
  item: MarketItem;
  installed: PluginListItem | null;
  selected: boolean;
  installing: boolean;
  locale: string;
  onSelect: (id: string) => void;
  onInstall: (item: MarketItem) => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const meta = marketMetaBits(item, t, locale);
  if (item.installed) {
    meta.push(item.needsUpdate ? t("plugins.catalog.update") : t("plugins.catalog.installed"));
  }
  return (
    <div className={`plugin-center-row plugin-center-row--split${selected ? " is-active" : ""}`}>
      <button type="button" className="plugin-center-row__hit plugin-center-row__hit--icon" onClick={() => onSelect(item.id)}>
        <PluginGlyph pluginId={item.id} kind={item.kind} name={item.name} size="sm" fromDbx={isDbxOrigin(item.origin)} />
        <span className="plugin-center-row__body">
          <span className="plugin-center-row__name">{item.name}</span>
          <span className="plugin-center-row__meta">{meta.join(" · ")}</span>
        </span>
      </button>
      <MarketAction
        item={item}
        installed={installed}
        installing={installing}
        onInstall={onInstall}
        onOpen={onOpen}
      />
    </div>
  );
}

function MarketCard({
  item,
  installed,
  selected,
  installing,
  locale,
  onSelect,
  onInstall,
  onOpen,
}: {
  item: MarketItem;
  installed: PluginListItem | null;
  selected: boolean;
  installing: boolean;
  locale: string;
  onSelect: (id: string) => void;
  onInstall: (item: MarketItem) => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const desc =
    item.description.trim() ||
    (isDbxOrigin(item.origin)
      ? t("plugins.center.sourceDbx")
      : `${t(`plugins.center.kinds.${item.kind}`)} · v${item.version}`);
  return (
    <div className={`plugin-center-card${selected ? " is-active" : ""}`}>
      <button type="button" className="plugin-center-card__hit" onClick={() => onSelect(item.id)}>
        <span className="plugin-center-card__top">
          <PluginGlyph pluginId={item.id} kind={item.kind} name={item.name} size="md" fromDbx={isDbxOrigin(item.origin)} />
          <span className="plugin-center-card__titles">
            <span className="plugin-center-card__name">{item.name}</span>
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
          onInstall={onInstall}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}
