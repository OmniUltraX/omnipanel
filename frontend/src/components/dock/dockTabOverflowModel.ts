import type { DockHeaderIconKind } from "./DockHeaderIcon";
import type { DockableTab } from "./dockableTab";
import type { DockTabLiveMeta } from "./dockTabLiveMeta";
import { textSearchMatches } from "../../lib/textSearchMatch";

/** 溢出列表的排列方式。顺序＝标签栏顺序，分组＝按面板类型，最近＝最近使用。 */
export type DockTabOverflowMode = "order" | "group" | "recent";

/** 溢出菜单里的一条标签。字段都来自 DockableTab，不绑定具体模块。 */
export interface DockTabOverflowTab {
  id: string;
  panelType: string;
  label: string;
  tooltip?: string;
  detail?: string;
  noteKey?: string;
  /** 打开菜单时从侧栏备注解析出的正文 */
  note?: string;
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
    detail: tab.detail,
    noteKey: tab.noteKey,
    overflowed,
    icon: live?.icon ?? tab.icon,
    status: tab.status,
    dirty,
    saved,
    preview: live ? Boolean(live.preview) : Boolean(tab.preview),
    closable: tab.closable !== false,
  };
}

/** 副标题：用户备注优先，再接地址 / 库名等补充信息。和标题相同则不展示。 */
export function dockTabOverflowSubtitle(
  tab: Pick<DockTabOverflowTab, "label" | "detail" | "note">,
): string | undefined {
  const note = tab.note?.trim();
  const detail = tab.detail?.trim();
  const extra = detail && detail !== tab.label && detail !== note ? detail : undefined;
  const text = [note, extra].filter(Boolean).join(" · ");
  if (!text || text === tab.label) return undefined;
  return text;
}

function entryMatches(
  entry: DockTabOverflowTab,
  query: string,
  groupLabel: string,
): boolean {
  const subtitle = dockTabOverflowSubtitle(entry) ?? "";
  return (
    textSearchMatches(query, entry.label) ||
    textSearchMatches(query, subtitle) ||
    textSearchMatches(query, entry.detail ?? "") ||
    textSearchMatches(query, entry.note ?? "") ||
    textSearchMatches(query, entry.tooltip ?? "") ||
    textSearchMatches(query, groupLabel)
  );
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
  itemOrder: "strip" | "mru",
  grouped: boolean,
): DockTabOverflowSection[] {
  const groups = grouped ? groupByPanelType(items) : [items];
  const multi = grouped && groups.length > 1;
  return groups
    .filter((group) => group.length > 0)
    .map((group, index) => ({
      key: `${bucket ?? "all"}:${grouped ? group[0]?.panelType ?? index : "flat"}`,
      bucket: showBucket && index === 0 && bucket ? bucket : undefined,
      bucketCount: showBucket && index === 0 ? bucketCount : undefined,
      groupLabel: multi ? resolveGroupLabel(group[0]?.panelType ?? "") : undefined,
      items: itemOrder === "mru" ? sortByMru(group, mru) : group,
    }));
}

/**
 * order：标签栏顺序，只按是否露出分段。
 * group：按 panelType 分组，组内保持标签栏顺序。
 * recent：整表按最近使用排成一列。
 * 有查询时不再分「未显示 / 标签栏上」，匹配含拼音。
 */
export function buildDockTabOverflowSections(
  entries: DockTabOverflowTab[],
  query: string,
  mru: readonly string[],
  resolveGroupLabel: (panelType: string) => string,
  mode: DockTabOverflowMode = "group",
): DockTabOverflowSection[] {
  const normalized = query.trim();
  const matched = normalized
    ? entries.filter((entry) => entryMatches(entry, normalized, resolveGroupLabel(entry.panelType)))
    : entries;
  if (matched.length === 0) return [];

  if (mode === "recent") {
    return sectionsFor(matched, null, false, matched.length, mru, resolveGroupLabel, "mru", false);
  }

  if (normalized) {
    return sectionsFor(
      matched,
      null,
      false,
      matched.length,
      mru,
      resolveGroupLabel,
      "strip",
      mode === "group",
    );
  }

  const overflow = matched.filter((entry) => entry.overflowed);
  const visible = matched.filter((entry) => !entry.overflowed);
  const showBucket = overflow.length > 0 && visible.length > 0;
  const grouped = mode === "group";
  return [
    ...sectionsFor(
      overflow,
      "overflow",
      showBucket,
      overflow.length,
      mru,
      resolveGroupLabel,
      "strip",
      grouped,
    ),
    ...sectionsFor(
      visible,
      "visible",
      showBucket,
      visible.length,
      mru,
      resolveGroupLabel,
      "strip",
      grouped,
    ),
  ];
}
