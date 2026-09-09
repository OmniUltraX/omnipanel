import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSearchParams } from "react-router-dom";
import { TextInput } from "../../components/ui/form/TextInput";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { PLUGINS_STUDIO_VIEW, isPluginsStudioSearch } from "../../lib/paths";
import { useModuleVisibility } from "../../lib/moduleVisibility";
import {
  DETAIL_HEIGHT_DEFAULT,
  DETAIL_HEIGHT_MIN,
  KIND_FILTERS,
} from "./pluginCenterTypes";
import { PluginDepConfirmDialog } from "./PluginDepConfirmDialog";
import { PluginDetailPane } from "./PluginDetailPane";
import { PluginInstallConfirmDialog } from "./PluginInstallConfirmDialog";
import { PluginSourcesDialog } from "./PluginSourcesDialog";
import { PluginsMarketPane } from "./PluginsMarketPane";
import { PluginsSidebar } from "./PluginsSidebar";
import { usePluginCenter } from "./usePluginCenter";

const StudioPanel = lazy(() =>
  import("../studio/StudioPanel").then((mod) => ({ default: mod.StudioPanel })),
);

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
  const [searchParams, setSearchParams] = useSearchParams();
  const studioOpen = isPluginsStudioSearch(searchParams.toString());
  const { active: pluginsRouteActive } = useModuleVisibility();
  const center = usePluginCenter();
  const hostRef = useRef<HTMLDivElement>(null);
  const [detailHeight, setDetailHeight] = useState(readDetailHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const selected = Boolean(center.selectedInstalled || center.selectedMarket);

  const selectedId = center.selectedId;
  const setSelectedId = center.setSelectedId;

  const setStudioOpen = useCallback(
    (open: boolean) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (open) next.set("view", PLUGINS_STUDIO_VIEW);
          else next.delete("view");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [studioMounted, setStudioMounted] = useState(studioOpen);
  useEffect(() => {
    if (studioOpen) setStudioMounted(true);
  }, [studioOpen]);

  const topbarTabs = useMemo(
    () => [
      { id: "market", label: t("plugins.center.market"), active: !studioOpen },
      { id: "studio", label: t("plugins.studio.open"), active: studioOpen },
    ],
    [studioOpen, t],
  );
  useTopbarTabs(
    topbarTabs,
    { onSelect: (id) => setStudioOpen(id === "studio") },
    { mode: "connection", enabled: pluginsRouteActive },
  );

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement && hostRef.current?.contains(active)) {
      active.blur();
    }
  }, [setSelectedId]);

  useEffect(() => {
    if (!pluginsRouteActive) return;
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
  }, [clearSelection, pluginsRouteActive, selectedId]);

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
      {studioOpen ? null : (
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
      )}
      {center.error && !studioOpen ? <p className="plugin-center-error">{center.error}</p> : null}
      {studioMounted ? (
        <div
          className="plugin-studio-host"
          hidden={!studioOpen}
          style={{ display: studioOpen ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0 }}
        >
          <Suspense fallback={null}>
            <StudioPanel active={studioOpen} />
          </Suspense>
        </div>
      ) : null}
      {studioOpen ? null : (
        <>
          <div className="plugin-center-split">
            <PluginsSidebar
              kindFilter={center.kindFilter}
              installed={center.filteredInstalled}
              selectedId={center.selectedId}
              onSelect={center.setSelectedId}
              originOf={center.originOf}
              dbxIds={center.dbxIds}
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
              updates={center.updates}
              onInstallMarket={(item) => void center.installMarket(item)}
              onOpenOverlay={(id) => void center.openOverlay(id)}
              onRefreshMarket={() => void center.reloadMarket(true)}
              onOpenSources={() => center.setSourcesOpen(true)}
              onUpdateAll={() => void center.updatePlugins(null)}
              onUpdateOne={(id) => void center.updatePlugins([id])}
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
        </>
      )}
      {center.pendingInstall ? (
        <PluginInstallConfirmDialog
          manifest={center.pendingInstall.manifest}
          fileName={center.pendingInstall.fileName}
          confirming={center.confirming}
          onConfirm={() => void center.confirmPendingInstall()}
          onCancel={() => center.cancelPendingInstall()}
        />
      ) : null}
      {center.pendingPlan ? (
        <PluginDepConfirmDialog
          plan={center.pendingPlan.plan}
          confirming={center.confirming}
          onConfirm={() => void center.confirmPendingPlan()}
          onCancel={() => center.cancelPendingPlan()}
        />
      ) : null}
      <PluginSourcesDialog
        open={center.sourcesOpen}
        sources={center.sources}
        busyId={center.sourceBusyId}
        testResult={center.sourceTest}
        onClose={() => center.setSourcesOpen(false)}
        onAdd={(id, url, keys, token) => void center.addSource(id, url, keys, token)}
        onRemove={(id) => void center.removeSource(id)}
        onSetEnabled={(id, enabled) => void center.setSourceEnabled(id, enabled)}
        onTest={(id) => void center.testSource(id)}
        onConfirmKey={(id, key) => void center.confirmSourceKey(id, key)}
      />
    </div>
  );
}
