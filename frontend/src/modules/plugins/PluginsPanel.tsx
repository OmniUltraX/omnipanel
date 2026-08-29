import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation } from "react-router-dom";
import { TextInput } from "../../components/ui/form/TextInput";
import { useI18n } from "../../i18n";
import { isPluginsPath } from "../../lib/paths";
import {
  DETAIL_HEIGHT_DEFAULT,
  DETAIL_HEIGHT_MIN,
  KIND_FILTERS,
} from "./pluginCenterTypes";
import { PluginDetailPane } from "./PluginDetailPane";
import { PluginsMarketPane } from "./PluginsMarketPane";
import { PluginsSidebar } from "./PluginsSidebar";
import { usePluginCenter } from "./usePluginCenter";

const DETAIL_HEIGHT_KEY = "omnipanel.pluginCenter.detailHeight";

function readDetailHeight(): number {
  try {
    const raw = Number(localStorage.getItem(DETAIL_HEIGHT_KEY));
    if (Number.isFinite(raw) && raw >= DETAIL_HEIGHT_MIN) return Math.round(raw);
  } catch {
    /* ignore */
  }
  return DETAIL_HEIGHT_DEFAULT;
}

function persistDetailHeight(height: number) {
  try {
    localStorage.setItem(DETAIL_HEIGHT_KEY, String(height));
  } catch {
    /* ignore quota / private mode */
  }
}

function clampDetailHeight(height: number, host: HTMLElement | null): number {
  const max = host
    ? Math.max(DETAIL_HEIGHT_MIN, Math.round(host.clientHeight * 0.7))
    : 560;
  return Math.min(max, Math.max(DETAIL_HEIGHT_MIN, Math.round(height)));
}

export function PluginsPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const center = usePluginCenter();
  const hostRef = useRef<HTMLDivElement>(null);
  const [detailHeight, setDetailHeight] = useState(readDetailHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const selected = Boolean(center.selectedInstalled || center.selectedMarket);

  const selectedId = center.selectedId;
  const setSelectedId = center.setSelectedId;

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement && hostRef.current?.contains(active)) {
      active.blur();
    }
  }, [setSelectedId]);

  useEffect(() => {
    if (!isPluginsPath(location.pathname)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!selectedId) return;
      if (document.querySelector(".cmd-palette-overlay.show")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[role='dialog'], .modal, .cmd-palette")) return;
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [clearSelection, location.pathname, selectedId]);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startH: detailHeight };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [detailHeight],
  );

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clampDetailHeight(drag.startH + (drag.startY - event.clientY), hostRef.current);
    setDetailHeight(next);
  }, []);

  const onResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDetailHeight((height) => {
      const clamped = clampDetailHeight(height, hostRef.current);
      persistDetailHeight(clamped);
      return clamped;
    });
  }, []);

  return (
    <div
      ref={hostRef}
      className="plugin-center"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!selectedId) return;
        event.preventDefault();
        clearSelection();
      }}
    >
      <header className="plugin-center-toolbar">
        <div className="plugin-center-toolbar__search">
          <TextInput
            value={center.search}
            onChange={center.setSearch}
            placeholder={t("plugins.center.search")}
            size="sm"
            clearable
            copyable={false}
          />
        </div>
        <div className="plugin-center-kinds" role="tablist" aria-label={t("plugins.center.filter.all")}>
          {KIND_FILTERS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={center.kindFilter === kind}
              className={`plugin-center-kind${center.kindFilter === kind ? " is-active" : ""}`}
              onClick={() => center.setKindFilter(kind)}
            >
              {kind === "all" ? t("plugins.center.filter.all") : t(`plugins.center.kinds.${kind}`)}
              <span className="plugin-center-kind__count">{center.kindCounts[kind]}</span>
            </button>
          ))}
        </div>
      </header>
      {center.error ? <p className="plugin-center-error">{center.error}</p> : null}
      <div className="plugin-center-split">
        <PluginsSidebar
          kindFilter={center.kindFilter}
          installed={center.filteredInstalled}
          selectedId={center.selectedId}
          onSelect={center.setSelectedId}
          originOf={center.originOf}
          installing={center.installing}
          onInstallFile={() => void center.installFromFile()}
        />
        <PluginsMarketPane
          kindFilter={center.kindFilter}
          marketFilter={center.marketFilter}
          onMarketFilter={center.setMarketFilter}
          market={center.filteredMarket}
          installed={center.items}
          selectedId={center.selectedId}
          onSelect={center.setSelectedId}
          installingMarketId={center.installingMarketId}
          catalogRefreshing={center.catalogRefreshing}
          onInstallMarket={(item) => void center.installMarket(item)}
          onOpenOverlay={(id) => void center.openOverlay(id)}
          onRefreshMarket={() => void center.reloadMarket()}
        />
      </div>
      {selected ? (
        <div className="plugin-center-inspector" style={{ height: detailHeight }}>
          <div
            className="plugin-center-inspector__resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("plugins.center.resizeDetail")}
            aria-valuenow={detailHeight}
            aria-valuemin={DETAIL_HEIGHT_MIN}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />
          <div className="plugin-center-inspector__body">
            <PluginDetailPane
              installed={center.selectedInstalled}
              market={center.selectedMarket}
              origin={
                center.selectedInstalled
                  ? center.originOf(center.selectedInstalled)
                  : (center.selectedMarket?.origin ?? null)
              }
              busyId={center.busyId}
              installingMarketId={center.installingMarketId}
              homeHiddenIds={center.homeHiddenIds}
              onToggle={(item, enabled) => void center.toggle(item, enabled)}
              onUninstall={(item) => void center.uninstall(item)}
              onInstallMarket={(item) => void center.installMarket(item)}
              onOpenOverlay={(id) => void center.openOverlay(id)}
              onHomePin={center.setHomePinned}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
