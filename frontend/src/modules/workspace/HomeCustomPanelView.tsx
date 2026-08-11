import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, {
  useContainerWidth,
  type Layout,
} from "react-grid-layout";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { IconSettings, IconTrash } from "../../components/ui/icons/Icons";
import { Button } from "../../components/ui/primitives/Button";
import { useI18n } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  DockerTargetSelect,
  getSmallComponent,
  listSmallComponents,
  SmallComponentDataSourceSelect,
  SmallComponentSizeSelect,
  sizeBoundsFromPresets,
  type HomeCustomPanelWidget,
  type SmallComponentDefinition,
} from "./smallComponents";
import {
  useDashboardStore,
  type HomeCustomPanelId,
} from "./useDashboardStore";
import {
  CUSTOM_PANEL_GRID_COLS,
  CUSTOM_PANEL_GRID_MARGIN,
  CUSTOM_PANEL_GRID_PADDING,
  CUSTOM_PANEL_ROW_HEIGHT,
} from "./customPanelGrid";

interface HomeCustomPanelViewProps {
  panelId: HomeCustomPanelId;
}

/** 传给 RGL 的布局：缩放边界始终取定义全部预设并集，避免旧数据 min/max 锁死 */
function layoutFromWidgets(widgets: HomeCustomPanelWidget[]): Layout {
  return widgets.map((widget) => {
    const def = getSmallComponent(widget.type);
    const bounds = def?.sizes?.length
      ? sizeBoundsFromPresets(def.sizes)
      : {};
    return {
      i: widget.id,
      x: widget.layout.x,
      y: widget.layout.y,
      w: widget.layout.w,
      h: widget.layout.h,
      minW: bounds.minW ?? widget.layout.minW,
      minH: bounds.minH ?? widget.layout.minH,
      maxW: bounds.maxW ?? widget.layout.maxW,
      maxH: bounds.maxH ?? widget.layout.maxH,
    };
  });
}

/** 首页自定义面板：react-grid-layout 空画布 + 小组件注册入口 */
export function HomeCustomPanelView({ panelId }: HomeCustomPanelViewProps) {
  const { t } = useI18n();
  const widgets = useDashboardStore(
    (s) => s.customPanels[panelId]?.widgets ?? EMPTY_WIDGETS,
  );
  const setCustomPanelLayout = useDashboardStore((s) => s.setCustomPanelLayout);
  const addCustomPanelWidget = useDashboardStore((s) => s.addCustomPanelWidget);
  const removeCustomPanelWidget = useDashboardStore(
    (s) => s.removeCustomPanelWidget,
  );

  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  const catalog = listSmallComponents();
  const layout = useMemo(() => layoutFromWidgets(widgets), [widgets]);
  const isEmpty = widgets.length === 0;

  const handleLayoutChange = useCallback(
    (next: Layout) => {
      setCustomPanelLayout(panelId, next);
    },
    [panelId, setCustomPanelLayout],
  );

  const handleAdd = useCallback(
    (type: string) => {
      addCustomPanelWidget(panelId, type);
      setPickerOpen(false);
    },
    [addCustomPanelWidget, panelId],
  );

  /** 双击画布空白处打开「添加组件」；点在小组件上则忽略 */
  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".home-custom-panel-widget")) return;
    if (target.closest(".home-custom-panel-picker")) return;
    if (target.closest(".form-dialog, .modal-dialog, .modal-overlay")) return;
    setPickerOpen(true);
  }, []);

  return (
    <div className="dashboard-page dashboard-page--custom-panel">
      <div className="home-custom-panel">
        <div
          className="home-custom-panel__canvas"
          ref={containerRef}
          onDoubleClick={handleCanvasDoubleClick}
        >
          {isEmpty ? (
            <div className="home-custom-panel__empty">
              <Button
                type="button"
                variant="outline"
                className="home-custom-panel__empty-add"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen(true)}
              >
                {t("homeWorkspace.customPanel.addWidget")}
              </Button>
              <p className="home-custom-panel__empty-hint">
                {t("homeWorkspace.customPanel.emptyHint")}
              </p>
            </div>
          ) : null}

          {mounted && !isEmpty ? (
            <GridLayout
              className="home-custom-panel__grid"
              width={width}
              layout={layout}
              gridConfig={{
                cols: CUSTOM_PANEL_GRID_COLS,
                rowHeight: CUSTOM_PANEL_ROW_HEIGHT,
                margin: CUSTOM_PANEL_GRID_MARGIN,
                containerPadding: CUSTOM_PANEL_GRID_PADDING,
              }}
              dragConfig={{
                enabled: true,
                handle: ".home-custom-panel-widget__drag",
                cancel: ".home-custom-panel-widget__actions",
              }}
              resizeConfig={{ enabled: false }}
              onLayoutChange={handleLayoutChange}
            >
              {widgets.map((widget) => (
                <div key={widget.id} className="home-custom-panel-widget">
                  <CustomPanelWidgetChrome
                    widget={widget}
                    panelId={panelId}
                    onRemove={() =>
                      removeCustomPanelWidget(panelId, widget.id)
                    }
                  />
                </div>
              ))}
            </GridLayout>
          ) : null}
        </div>
      </div>

      {pickerOpen ? (
        <SmallComponentPicker
          catalog={catalog}
          onSelect={handleAdd}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

const EMPTY_WIDGETS: HomeCustomPanelWidget[] = [];

function SmallComponentPicker({
  catalog,
  onSelect,
  onClose,
}: {
  catalog: SmallComponentDefinition[];
  onSelect: (type: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((item) => {
      const label = t(item.labelKey as never).toLowerCase();
      const desc = item.descriptionKey
        ? t(item.descriptionKey as never).toLowerCase()
        : "";
      return (
        item.type.toLowerCase().includes(q) ||
        label.includes(q) ||
        desc.includes(q)
      );
    });
  }, [catalog, query, t]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      onSelect(filtered[selectedIndex].type);
    }
  };

  return (
    <div className="home-custom-panel-picker">
      <button
        type="button"
        className="home-custom-panel-picker__backdrop"
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <div
        className="home-custom-panel-picker__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("homeWorkspace.customPanel.addWidget")}
        onKeyDown={handleListKeyDown}
      >
        {/* 与 TopbarTabAddButton 菜单搜索同一套全局样式 */}
        <div className="topbar-add-menu-search">
          <svg
            className="topbar-add-menu-search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="topbar-add-menu-search-input"
            placeholder={t("homeWorkspace.customPanel.searchWidgets")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleListKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="home-custom-panel-picker__list" role="listbox">
          {catalog.length === 0 ? (
            <div className="home-custom-panel-picker__empty">
              {t("homeWorkspace.customPanel.noWidgets")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="home-custom-panel-picker__empty">
              {t("homeWorkspace.customPanel.searchNoResults")}
            </div>
          ) : (
            filtered.map((item, index) => (
              <button
                key={item.type}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={
                  index === selectedIndex
                    ? "home-custom-panel-picker__item is-active"
                    : "home-custom-panel-picker__item"
                }
                onClick={() => onSelect(item.type)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="home-custom-panel-picker__item-label">
                  {t(item.labelKey as never)}
                </span>
                {item.descriptionKey ? (
                  <span className="home-custom-panel-picker__item-desc">
                    {t(item.descriptionKey as never)}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function CustomPanelWidgetChrome({
  widget,
  panelId,
  onRemove,
}: {
  widget: HomeCustomPanelWidget;
  panelId: HomeCustomPanelId;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [editOpen, setEditOpen] = useState(false);
  const liveWidget = useDashboardStore(
    (s) =>
      s.customPanels[panelId]?.widgets.find((w) => w.id === widget.id) ?? widget,
  );
  const connections = useConnectionStore((s) => s.connections);
  const def = getSmallComponent(liveWidget.type);
  const Comp = def?.component;
  const setCustomPanelWidgetDataSource = useDashboardStore(
    (s) => s.setCustomPanelWidgetDataSource,
  );
  const setCustomPanelWidgetTarget = useDashboardStore(
    (s) => s.setCustomPanelWidgetTarget,
  );
  const setCustomPanelWidgetSize = useDashboardStore(
    (s) => s.setCustomPanelWidgetSize,
  );
  const dataSourceKind = def?.dataSourceKind ?? null;
  const targetKind = def?.targetKind ?? null;
  const typeLabel = def
    ? t(def.labelKey as never)
    : t("homeWorkspace.customPanel.unknownWidget");
  const dataSourceName = useMemo(() => {
    const id = liveWidget.dataSourceId;
    if (!id) return null;
    return connections.find((c) => c.id === id)?.name ?? null;
  }, [connections, liveWidget.dataSourceId]);
  const targetLabel = useMemo(() => {
    const target = liveWidget.target;
    if (!target) return null;
    if (target.kind === "docker-compose") return target.composeProject;
    if (target.kind === "docker-container") {
      return target.containerId.slice(0, 12);
    }
    return null;
  }, [liveWidget.target]);
  const displayName = useMemo(() => {
    if (targetLabel && dataSourceName) {
      return `${dataSourceName} / ${targetLabel}`;
    }
    return (
      targetLabel ??
      dataSourceName ??
      (dataSourceKind
        ? t("homeWorkspace.customPanel.dataSource.unset")
        : typeLabel)
    );
  }, [targetLabel, dataSourceName, dataSourceKind, t, typeLabel]);

  return (
    <div
      className={
        editOpen
          ? "home-custom-panel-widget__inner is-editing"
          : "home-custom-panel-widget__inner"
      }
    >
      <div className="home-custom-panel-widget__header">
        <button
          type="button"
          className="home-custom-panel-widget__drag"
          title={t("homeWorkspace.customPanel.dragHandle")}
          aria-label={t("homeWorkspace.customPanel.dragHandle")}
        >
          <span aria-hidden>⋮⋮</span>
        </button>
        <span className="home-custom-panel-widget__type" title={typeLabel}>
          {typeLabel}
        </span>
        <span className="home-custom-panel-widget__name" title={displayName}>
          {displayName}
        </span>
        <div className="home-custom-panel-widget__actions">
          <button
            type="button"
            className="home-custom-panel-widget__icon-btn"
            title={t("homeWorkspace.customPanel.widgetSettings")}
            aria-label={t("homeWorkspace.customPanel.widgetSettings")}
            onClick={() => setEditOpen(true)}
          >
            <IconSettings size={14} />
          </button>
          <button
            type="button"
            className="home-custom-panel-widget__icon-btn home-custom-panel-widget__icon-btn--danger"
            title={t("homeWorkspace.customPanel.removeWidget")}
            aria-label={t("homeWorkspace.customPanel.removeWidget")}
            onClick={onRemove}
          >
            <IconTrash size={14} />
          </button>
        </div>
      </div>

      <div className="home-custom-panel-widget__body">
        {Comp ? (
          <Comp
            instanceId={liveWidget.id}
            panelId={panelId}
            dataSourceId={liveWidget.dataSourceId ?? null}
          />
        ) : (
          <p className="home-custom-panel-widget__missing">
            {t("homeWorkspace.customPanel.unknownWidgetHint", {
              type: liveWidget.type,
            })}
          </p>
        )}
      </div>

      <FormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t("homeWorkspace.customPanel.editWidgetTitle", {
          name: typeLabel,
        })}
        size="sm"
        className="home-custom-panel-widget-edit"
        bodyClassName="home-custom-panel-widget-edit__body"
        cancelLabel={t("common.close")}
        cancelVariant="secondary"
      >
        {def?.sizes?.length ? (
          <FormField label={t("homeWorkspace.customPanel.selectSize")}>
            <SmallComponentSizeSelect
              widget={liveWidget}
              def={def}
              borderless={false}
              className="home-custom-panel-widget-edit__control"
              onChange={(sizeId) =>
                setCustomPanelWidgetSize(panelId, liveWidget.id, sizeId)
              }
            />
          </FormField>
        ) : null}
        {dataSourceKind ? (
          <FormField label={t("homeWorkspace.customPanel.dataSource.label")}>
            <SmallComponentDataSourceSelect
              kind={dataSourceKind}
              value={liveWidget.dataSourceId ?? null}
              borderless={false}
              className="home-custom-panel-widget-edit__control"
              onChange={(dataSourceId) =>
                setCustomPanelWidgetDataSource(
                  panelId,
                  liveWidget.id,
                  dataSourceId,
                )
              }
            />
          </FormField>
        ) : null}
        {targetKind ? (
          <FormField
            label={
              targetKind === "docker-container"
                ? t("homeWorkspace.customPanel.target.container")
                : t("homeWorkspace.customPanel.target.compose")
            }
          >
            <DockerTargetSelect
              connectionId={liveWidget.dataSourceId ?? null}
              targetKind={targetKind}
              value={liveWidget.target}
              className="home-custom-panel-widget-edit__control"
              onChange={(target) =>
                setCustomPanelWidgetTarget(panelId, liveWidget.id, target)
              }
            />
          </FormField>
        ) : null}
      </FormDialog>
    </div>
  );
}
