import type { DockHeaderIconKind } from "./DockHeaderIcon";
import type { DockableTab } from "./dockableTab";
import type { DockTabLiveMeta } from "./dockTabLiveMeta";

/** 溢出菜单里的一条标签。字段都来自 DockableTab，不绑定具体模块。 */
export interface DockTabOverflowTab {
  id: string;
  panelType: string;
  label: string;
  tooltip?: string;
  overflowed: boolean;
  icon?: DockHeaderIconKind;
  status?: DockableTab["status"];
  dirty?: boolean;
  saved?: boolean;
  preview?: boolean;
  closable: boolean;
}

export interface DockTabOverflowSection {
  key: string;
  /** 仅在「未显示 / 标签栏上」两段同时存在时，写在该段第一组上 */
  bucket?: "overflow" | "visible";
  bucketCount?: number;
  /** 同一段里出现两种及以上 panelType 时才有分组标题 */
  groupLabel?: string;
  items: DockTabOverflowTab[];
}

const VISIBLE_EPSILON = 1;

export function isTabFullyVisible(tab: HTMLElement, container: HTMLElement): boolean {
  const tabRect = tab.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  const vertical = Boolean(
    container.closest(".dv-groupview-header-vertical, .dv-tabs-container-vertical"),
  );
  if (vertical) {
    return (
      tabRect.top >= box.top - VISIBLE_EPSILON &&
      tabRect.bottom <= box.bottom + VISIBLE_EPSILON
    );
  }
  return (
    tabRect.left >= box.left - VISIBLE_EPSILON &&
    tabRect.right <= box.right + VISIBLE_EPSILON
  );
}

/** 读取一个 dock 分组标签栏上的标签，以及哪些没有完整露出。不扫分组内部嵌套的 dock。 */
export function measureGroupTabs(
  groupEl: HTMLElement,
): { id: string; overflowed: boolean }[] {
  const header = groupEl.querySelector<HTMLElement>(
    ":scope > .dv-tabs-and-actions-container",
  );
  const container = header?.querySelector<HTMLElement>(".dv-tabs-container");
  if (!header || !container) return [];

  const result: { id: string; overflowed: boolean }[] = [];
  container.querySelectorAll<HTMLElement>(":scope > .dv-tab").forEach((tab) => {
    if (tab.classList.contains("dock-tab--bar-hidden")) return;
    const id =
      tab.dataset.tabId ||
      tab.querySelector<HTMLElement>("[data-dock-tab-id]")?.dataset.dockTabId;
    if (!id) return;
    result.push({ id, overflowed: !isTabFullyVisible(tab, container) });
  });
  return result;
}

export function presentDockOverflowTab(
  tab: DockableTab,
  overflowed: boolean,
  meta: DockTabLiveMeta | undefined,
): DockTabOverflowTab {
  const live = meta && meta.rev > 0 ? meta : undefined;
  const pageType = live?.type ?? tab.type;
  const dirty =
    pageType === "file" ? Boolean(live?.dirty || tab.dirty) : undefined;
  const saved =
    pageType === "file"
      ? !dirty && Boolean(live?.saved ?? tab.saved)
      : undefined;
  return {
    id: tab.id,
    panelType: tab.panelType,
    label: live?.label ?? tab.label,
    tooltip: tab.tooltip ?? tab.label,
    overflowed,
    icon: live?.icon ?? tab.icon,
    status: tab.status,
    dirty,
    saved,
    preview: live ? Boolean(live.preview) : Boolean(tab.preview),
    closable: tab.closable !== false,
  };
}

export function splitMatch(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (at > cursor) parts.push({ text: text.slice(cursor, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    cursor = at + needle.length;
  }
  return parts.filter((part) => part.text.length > 0);
}

function sortByMru<T extends { id: string }>(items: T[], mru: readonly string[]): T[] {
  const rank = new Map(mru.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({
      item,
      index,
      rank: rank.get(item.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

function groupByPanelType(items: DockTabOverflowTab[]): DockTabOverflowTab[][] {
  const order: string[] = [];
  const groups = new Map<string, DockTabOverflowTab[]>();
  for (const item of items) {
    const list = groups.get(item.panelType);
    if (list) {
      list.push(item);
      continue;
    }
    order.push(item.panelType);
    groups.set(item.panelType, [item]);
  }
  return order.map((panelType) => groups.get(panelType) ?? []);
}

function sectionsFor(
  items: DockTabOverflowTab[],
  bucket: "overflow" | "visible" | null,
  showBucket: boolean,
  bucketCount: number,
  mru: readonly string[],
  resolveGroupLabel: (panelType: string) => string,
): DockTabOverflowSection[] {
  const groups = groupByPanelType(items);
  const multi = groups.length > 1;
  return groups.map((group, index) => ({
    key: `${bucket ?? "all"}:${group[0]?.panelType ?? index}`,
    bucket: showBucket && index === 0 && bucket ? bucket : undefined,
    bucketCount: showBucket && index === 0 ? bucketCount : undefined,
    groupLabel: multi ? resolveGroupLabel(group[0]?.panelType ?? "") : undefined,
    items: sortByMru(group, mru),
  }));
}

/**
 * 空查询：被裁切的在前，栏上完整可见的在后；两种都有才显示分段标题。
 * 同一段只有一种 panelType 时不画分组标题。
 * 有查询时跨段过滤标题、提示和分组名，不再分「未显示 / 标签栏上」。
 */
export function buildDockTabOverflowSections(
  entries: DockTabOverflowTab[],
  query: string,
  mru: readonly string[],
  resolveGroupLabel: (panelType: string) => string,
): DockTabOverflowSection[] {
  const normalized = query.trim().toLowerCase();
  const matched = normalized
    ? entries.filter((entry) => {
        const groupLabel = resolveGroupLabel(entry.panelType);
        return (
          entry.label.toLowerCase().includes(normalized) ||
          (entry.tooltip ?? "").toLowerCase().includes(normalized) ||
          groupLabel.toLowerCase().includes(normalized)
        );
      })
    : entries;
  if (matched.length === 0) return [];

  if (normalized) {
    return sectionsFor(matched, null, false, matched.length, mru, resolveGroupLabel);
  }

  const overflow = matched.filter((entry) => entry.overflowed);
  const visible = matched.filter((entry) => !entry.overflowed);
  const showBucket = overflow.length > 0 && visible.length > 0;
  return [
    ...sectionsFor(
      overflow,
      "overflow",
      showBucket,
      overflow.length,
      mru,
      resolveGroupLabel,
    ),
    ...sectionsFor(
      visible,
      "visible",
      showBucket,
      visible.length,
      mru,
      resolveGroupLabel,
    ),
  ];
}
