import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { DockviewApi } from "dockview-react";
import { useI18n } from "../../i18n";
import { resolveStatusBarPanelTypeLabel } from "../../lib/statusBarPanelTypeLabel";
import { scheduleScrollDockTabIntoView } from "./dockTabScroll";
import { getTabGroupMeta } from "./dockPanelType";
import { useDockTabLiveMetaMap } from "./dockTabLiveMeta";
import {
  measureGroupTabs,
  presentDockOverflowTab,
} from "./dockTabOverflowModel";
import {
  DockTabOverflowMenu,
  type DockTabOverflowAnchorBox,
} from "./DockTabOverflowMenu";
import type { DockableTab } from "./dockableTab";

interface UseDockTabOverflowOptions {
  rootRef: RefObject<HTMLElement | null>;
  apiRef: RefObject<DockviewApi | null>;
  enabled: boolean;
  tabs: DockableTab[];
  activeTabId: string;
  mruRef: RefObject<string[]>;
  resolveTabGroupMeta?: (
    panelType: string,
  ) => Partial<{ label: string }> | undefined;
}

function anchorBox(rect: DOMRect): DockTabOverflowAnchorBox {
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  };
}

function sameMeasured(
  prev: { id: string; overflowed: boolean }[],
  next: { id: string; overflowed: boolean }[],
): boolean {
  if (prev.length !== next.length) return false;
  return prev.every(
    (item, index) =>
      item.id === next[index]?.id && item.overflowed === next[index]?.overflowed,
  );
}

function sameAnchor(prev: DockTabOverflowAnchorBox, next: DockTabOverflowAnchorBox): boolean {
  return (
    prev.top === next.top &&
    prev.left === next.left &&
    prev.bottom === next.bottom &&
    prev.right === next.right
  );
}

/**
 * 替换 dockview 默认的溢出白名单。测量仍用标签栏真实布局，
 * 菜单本身只吃 DockableTab，因此各模块不用单独接。
 */
export function useDockTabOverflow({
  rootRef,
  apiRef,
  enabled,
  tabs,
  activeTabId,
  mruRef,
  resolveTabGroupMeta,
}: UseDockTabOverflowOptions): ReactNode {
  const { t } = useI18n();
  const liveMeta = useDockTabLiveMetaMap();
  const triggerRef = useRef<HTMLElement | null>(null);
  const groupRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  const [session, setSession] = useState<{
    anchor: DockTabOverflowAnchorBox;
    measured: { id: string; overflowed: boolean }[];
    mru: string[];
  } | null>(null);

  openRef.current = session != null;

  const dismiss = useCallback(() => {
    triggerRef.current?.classList.remove("is-open");
    triggerRef.current = null;
    groupRef.current = null;
    setSession(null);
  }, []);

  useEffect(() => {
    if (!enabled) dismiss();
  }, [dismiss, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const triggerRoot = target.closest<HTMLElement>(".dv-tabs-overflow-dropdown-root");
      if (!triggerRoot || !root.contains(triggerRoot)) return;
      const group = triggerRoot.closest<HTMLElement>(".dv-groupview");
      const measured = group ? measureGroupTabs(group) : [];
      // 量不到标签时留给 dockview 自己的下拉，避免把点击吃掉。
      if (!group || measured.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const button = triggerRoot.querySelector<HTMLElement>(
        ".dv-tabs-overflow-dropdown-default",
      );
      if (openRef.current && triggerRef.current === button) {
        dismiss();
        return;
      }
      root
        .querySelectorAll(".dv-tabs-overflow-dropdown-default.is-open")
        .forEach((node) => node.classList.remove("is-open"));
      button?.classList.add("is-open");
      triggerRef.current = button;
      groupRef.current = group;
      setSession({
        anchor: anchorBox(triggerRoot.getBoundingClientRect()),
        measured,
        mru: [...mruRef.current],
      });
    };

    root.addEventListener("click", onClick, true);
    return () => {
      root.removeEventListener("click", onClick, true);
      root
        .querySelectorAll(".dv-tabs-overflow-dropdown-default.is-open")
        .forEach((node) => node.classList.remove("is-open"));
    };
  }, [dismiss, enabled, mruRef, rootRef]);

  const menuOpen = session != null;

  useEffect(() => {
    if (!menuOpen) return;
    const group = groupRef.current;
    if (!group?.isConnected) {
      dismiss();
      return;
    }
    const measured = measureGroupTabs(group);
    if (measured.length === 0) {
      dismiss();
      return;
    }
    setSession((prev) => {
      if (!prev || sameMeasured(prev.measured, measured)) return prev;
      return { ...prev, measured };
    });
  }, [dismiss, menuOpen, tabs]);

  useEffect(() => {
    if (!menuOpen) return;
    const sync = () => {
      const button = triggerRef.current;
      const triggerRoot = button?.closest<HTMLElement>(".dv-tabs-overflow-dropdown-root");
      const group = groupRef.current;
      if (!triggerRoot?.isConnected || !group?.isConnected) {
        dismiss();
        return;
      }
      const measured = measureGroupTabs(group);
      const anchor = anchorBox(triggerRoot.getBoundingClientRect());
      if (anchor.width === 0 && anchor.height === 0) {
        dismiss();
        return;
      }
      setSession((prev) => {
        if (!prev) return prev;
        if (sameAnchor(prev.anchor, anchor) && sameMeasured(prev.measured, measured)) {
          return prev;
        }
        return { ...prev, anchor, measured };
      });
    };
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [dismiss, menuOpen]);

  const resolveGroupLabel = useCallback(
    (panelType: string) => {
      const custom = resolveTabGroupMeta?.(panelType)?.label;
      if (custom) return custom;
      const translated = resolveStatusBarPanelTypeLabel(panelType, t);
      if (translated !== panelType) return translated;
      return getTabGroupMeta(panelType).label;
    },
    [resolveTabGroupMeta, t],
  );

  const presented = useMemo(() => {
    if (!session) return [];
    const byId = new Map(
      tabs.filter((tab) => !tab.tabBarHidden).map((tab) => [tab.id, tab]),
    );
    return session.measured.flatMap((item) => {
      const tab = byId.get(item.id);
      if (!tab) return [];
      return [presentDockOverflowTab(tab, item.overflowed, liveMeta.get(tab.id))];
    });
  }, [liveMeta, session, tabs]);

  const activate = useCallback(
    (tabId: string) => {
      apiRef.current?.getPanel(tabId)?.api.setActive();
      scheduleScrollDockTabIntoView(rootRef.current, tabId);
      dismiss();
    },
    [apiRef, dismiss, rootRef],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || tab.closable === false) return;
      apiRef.current?.getPanel(tabId)?.api.close();
    },
    [apiRef, tabs],
  );

  if (!session || presented.length === 0) return null;

  return (
    <DockTabOverflowMenu
      anchor={session.anchor}
      tabs={presented}
      activeTabId={activeTabId}
      mru={session.mru}
      resolveGroupLabel={resolveGroupLabel}
      onActivate={activate}
      onCloseTab={closeTab}
      onDismiss={dismiss}
    />
  );
}
