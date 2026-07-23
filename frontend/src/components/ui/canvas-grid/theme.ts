import type { GridThemeTokens } from "./types";

function parsePx(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function readColor(style: CSSStyleDeclaration, prop: string, fallback: string): string {
  const value = style.getPropertyValue(prop).trim();
  return value || fallback;
}

export type CanvasThemeProfile = "data-table" | "panel";

/**
 * 模块级主题 cache：按 profile + 主题签名 缓存。
 * 主题色由 CSS 变量（:root）+ 静态类规则决定，只有主题切换时才变化。
 * 17 次 DOM 探测（每次强制 reflow）= 1500ms+，cache 后后续 grid 挂载 0ms。
 */
const themeCache = new Map<string, GridThemeTokens>();

/** 主题签名：捕获亮/暗主题切换。data-theme 属性 + class 变化都会刷新签名。 */
function getThemeSignature(): string {
  const el = document.documentElement;
  return `${el.getAttribute("data-theme") ?? ""}|${el.className}|${el.getAttribute("data-color-scheme") ?? ""}`;
}

/** 失效主题 cache（主题切换时调用）。 */
export function invalidateCanvasGridThemeCache(): void {
  themeCache.clear();
}

/**
 * 批量探测 data-table 主题色：把所有 14 个背景探测 + 3 个 tag 探测合并到 ONE DOM 操作。
 * 原实现每次 probe 都 append+getComputedStyle+remove（17 次强制 reflow = 1500ms+），
 * 合并后只 append 一次、批量读 getComputedStyle（浏览器合并为一次 style recalc）、remove 一次。
 */
function probeDataTableThemeBatch(host: HTMLElement): {
  rownumBg: string;
  rownumStripedBg: string;
  selectedBg: string;
  dragSelectedBg: string;
  dirtyUpdateBg: string;
  dirtyInsertBg: string;
  dirtyDeleteBg: string;
  selectedDirtyUpdateBg: string;
  selectedDirtyInsertBg: string;
  selectedDirtyDeleteBg: string;
  relationBg: string;
  relationDisplayBg: string;
  relationStripedBg: string;
  relationDisplayStripedBg: string;
  nullTag: { color: string; backgroundColor: string; borderColor: string };
  emptyTag: { color: string; backgroundColor: string; borderColor: string };
  dirtyNullTag: { color: string; backgroundColor: string; borderColor: string };
} {
  // 一个隐藏容器，内含所有探测 cell，只 append/remove 一次
  const container = document.createElement("div");
  container.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";

  const table = document.createElement("table");
  table.className = "db-data-table";
  const tbody = document.createElement("tbody");

  // 辅助：创建一行带指定 class 的探测 cell，返回 td 供后续读取
  const makeBgRow = (
    key: string,
    rowClasses: string[],
    cellClasses: string[],
  ): HTMLTableCellElement => {
    const tr = document.createElement("tr");
    tr.className = "db-data-table-row";
    for (const c of rowClasses) tr.classList.add(c);
    const td = document.createElement("td");
    td.className = "db-data-table-cell";
    for (const c of cellClasses) td.classList.add(c);
    td.dataset.probeKey = key;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return td;
  };

  // 辅助：创建 tag 探测 cell（内含 span）
  const makeTagRow = (
    key: string,
    tagClass: string,
    dirty: boolean,
  ): HTMLSpanElement => {
    const tr = document.createElement("tr");
    tr.className = "db-data-table-row";
    const td = document.createElement("td");
    td.className = dirty
      ? "db-data-table-cell db-data-table-cell--dirty"
      : "db-data-table-cell";
    const span = document.createElement("span");
    span.className = tagClass;
    span.textContent = "N";
    td.appendChild(span);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return span;
  };

  // 14 个背景探测 cell
  const bgCells: Record<string, HTMLTableCellElement> = {};
  bgCells.rownum = makeBgRow("rownum", [], ["db-data-table-cell--rownum"]);
  bgCells.rownumStriped = makeBgRow("rownumStriped", ["db-data-table-row--striped"], ["db-data-table-cell--rownum"]);
  bgCells.selected = makeBgRow("selected", [], ["db-data-table-cell--selected"]);
  bgCells.dragSelected = makeBgRow("dragSelected", [], ["db-data-table-cell--drag-selected"]);
  bgCells.dirtyUpdate = makeBgRow("dirtyUpdate", [], ["db-data-table-cell--dirty"]);
  bgCells.dirtyInsert = makeBgRow("dirtyInsert", [], ["db-data-table-cell--dirty", "db-data-table-cell--dirty-insert"]);
  bgCells.dirtyDelete = makeBgRow("dirtyDelete", [], ["db-data-table-cell--dirty", "db-data-table-cell--dirty-delete"]);
  bgCells.selectedDirtyUpdate = makeBgRow("selectedDirtyUpdate", [], ["db-data-table-cell--selected", "db-data-table-cell--dirty"]);
  bgCells.selectedDirtyInsert = makeBgRow("selectedDirtyInsert", [], ["db-data-table-cell--selected", "db-data-table-cell--dirty", "db-data-table-cell--dirty-insert"]);
  bgCells.selectedDirtyDelete = makeBgRow("selectedDirtyDelete", [], ["db-data-table-cell--selected", "db-data-table-cell--dirty", "db-data-table-cell--dirty-delete"]);
  bgCells.relation = makeBgRow("relation", [], ["db-data-table-cell--relation"]);
  bgCells.relationDisplay = makeBgRow("relationDisplay", [], ["db-data-table-cell--relation-display"]);
  bgCells.relationStriped = makeBgRow("relationStriped", ["db-data-table-row--striped"], ["db-data-table-cell--relation"]);
  bgCells.relationDisplayStriped = makeBgRow("relationDisplayStriped", ["db-data-table-row--striped"], ["db-data-table-cell--relation-display"]);

  // 3 个 tag 探测 span
  const nullTagSpan = makeTagRow("nullTag", "db-data-table-cell-null-tag", false);
  const emptyTagSpan = makeTagRow("emptyTag", "db-data-table-cell-empty-tag", false);
  const dirtyNullTagSpan = makeTagRow("dirtyNullTag", "db-data-table-cell-null-tag", true);

  table.appendChild(tbody);
  container.appendChild(table);
  host.appendChild(container);

  // 批量读取：浏览器对连续 getComputedStyle 调用合并为一次 style recalc
  const readTag = (span: HTMLSpanElement) => {
    const s = getComputedStyle(span);
    return { color: s.color, backgroundColor: s.backgroundColor, borderColor: s.borderColor };
  };

  const result = {
    rownumBg: getComputedStyle(bgCells.rownum).backgroundColor,
    rownumStripedBg: getComputedStyle(bgCells.rownumStriped).backgroundColor,
    selectedBg: getComputedStyle(bgCells.selected).backgroundColor,
    dragSelectedBg: getComputedStyle(bgCells.dragSelected).backgroundColor,
    dirtyUpdateBg: getComputedStyle(bgCells.dirtyUpdate).backgroundColor,
    dirtyInsertBg: getComputedStyle(bgCells.dirtyInsert).backgroundColor,
    dirtyDeleteBg: getComputedStyle(bgCells.dirtyDelete).backgroundColor,
    selectedDirtyUpdateBg: getComputedStyle(bgCells.selectedDirtyUpdate).backgroundColor,
    selectedDirtyInsertBg: getComputedStyle(bgCells.selectedDirtyInsert).backgroundColor,
    selectedDirtyDeleteBg: getComputedStyle(bgCells.selectedDirtyDelete).backgroundColor,
    relationBg: getComputedStyle(bgCells.relation).backgroundColor,
    relationDisplayBg: getComputedStyle(bgCells.relationDisplay).backgroundColor,
    relationStripedBg: getComputedStyle(bgCells.relationStriped).backgroundColor,
    relationDisplayStripedBg: getComputedStyle(bgCells.relationDisplayStriped).backgroundColor,
    nullTag: readTag(nullTagSpan),
    emptyTag: readTag(emptyTagSpan),
    dirtyNullTag: readTag(dirtyNullTagSpan),
  };

  host.removeChild(container);
  return result;
}

function probePanelBackgroundBatch(
  host: HTMLElement,
): { selectedBg: string; rowSelectedBg: string } {
  const container = document.createElement("div");
  container.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
  const table = document.createElement("table");
  table.className = "db-tables-panel-grid";
  const tbody = document.createElement("tbody");

  const tr1 = document.createElement("tr");
  const td1 = document.createElement("td");
  td1.className = "db-tables-panel-grid__cell--selected";
  tr1.appendChild(td1);
  tbody.appendChild(tr1);

  const tr2 = document.createElement("tr");
  tr2.className = "is-selected";
  const td2 = document.createElement("td");
  tr2.appendChild(td2);
  tbody.appendChild(tr2);

  table.appendChild(tbody);
  container.appendChild(table);
  host.appendChild(container);

  const selectedBg = getComputedStyle(td1).backgroundColor;
  const rowSelectedBg = getComputedStyle(tr2).backgroundColor;

  host.removeChild(container);
  return { selectedBg, rowSelectedBg };
}

function baseTheme(style: CSSStyleDeclaration, fontFamily: string): Omit<
  GridThemeTokens,
  | "rownumBg"
  | "rownumStripedBg"
  | "selectedBg"
  | "dragSelectedBg"
  | "rowSelectedBg"
  | "dirtyUpdateBg"
  | "dirtyInsertBg"
  | "dirtyDeleteBg"
  | "selectedDirtyUpdateBg"
  | "selectedDirtyInsertBg"
  | "selectedDirtyDeleteBg"
  | "relationBg"
  | "relationDisplayBg"
  | "relationStripedBg"
  | "relationDisplayStripedBg"
  | "nullTagFg"
  | "nullTagBg"
  | "nullTagBorder"
  | "emptyTagFg"
  | "emptyTagBg"
  | "emptyTagBorder"
  | "dirtyNullTagFg"
  | "dirtyNullTagBg"
  | "dirtyNullTagBorder"
  | "headerHeight"
> {
  return {
    bg: readColor(style, "--bg", "#0f1115"),
    surface: readColor(style, "--surface", "#161a22"),
    surfaceHover: readColor(style, "--surface-hover", "#1c2230"),
    fg: readColor(style, "--fg", "#e8eaed"),
    fg2: readColor(style, "--fg-2", "#a8b0bd"),
    meta: readColor(style, "--meta", "#7a8494"),
    border: readColor(style, "--border", "#2a3140"),
    accent: readColor(style, "--accent", "#4c8bf5"),
    warn: readColor(style, "--warn", "#d4a017"),
    success: readColor(style, "--success", "#3d9a6a"),
    danger: readColor(style, "--danger", "#d14b4b"),
    fontFamily,
    fontSize: 11,
    cellPaddingX: 8,
    cellPaddingY: 4,
    dirtyUpdateFg: readColor(style, "--warn", "#d4a017"),
    dirtyInsertFg: readColor(style, "--success", "#3d9a6a"),
    dirtyDeleteFg: readColor(style, "--danger", "#d14b4b"),
    valueBtnBg: readColor(style, "--surface", "#161a22"),
    valueBtnBorder: readColor(style, "--border", "#2a3140"),
    valueBtnFg: readColor(style, "--fg-2", "#a8b0bd"),
    placeholderFg: readColor(style, "--fg-2", "#a8b0bd"),
  };
}

/** 从表格宿主读取已解析的主题色，避免硬编码。 */
export function readCanvasGridTheme(
  host: HTMLElement | null,
  profile: CanvasThemeProfile = "data-table",
): GridThemeTokens {
  // cache 查找：主题签名没变就直接返回，跳过所有 DOM 探测
  const sig = getThemeSignature();
  const cacheKey = `${profile}::${sig}`;
  const cached = themeCache.get(cacheKey);
  if (cached) return cached;

  const root = host ?? document.documentElement;
  const style = getComputedStyle(root);
  const mono = readColor(style, "--font-mono", "ui-monospace, monospace");
  const fontFamily = `"Maple Mono NF CN Light", ${mono}`;
  const probeHost = host ?? document.body;
  const base = baseTheme(style, fontFamily);
  const accentSoft = readColor(style, "--accent-soft", "rgba(76, 139, 245, 0.18)");

  let result: GridThemeTokens;

  if (profile === "panel") {
    const { selectedBg, rowSelectedBg } = probePanelBackgroundBatch(probeHost);
    const finalSelectedBg = selectedBg || accentSoft;
    const finalRowSelectedBg = rowSelectedBg || accentSoft;
    const hostBg =
      host != null
        ? getComputedStyle(host).backgroundColor
        : "";
    result = {
      ...base,
      bg: hostBg && hostBg !== "rgba(0, 0, 0, 0)" && hostBg !== "transparent" ? hostBg : base.bg,
      fontSize: 11,
      cellPaddingX: 8,
      cellPaddingY: 6,
      rownumBg: base.bg,
      rownumStripedBg: base.surface,
      selectedBg: finalSelectedBg,
      dragSelectedBg: finalSelectedBg,
      rowSelectedBg: finalRowSelectedBg,
      dirtyUpdateBg: base.surface,
      dirtyInsertBg: base.surface,
      dirtyDeleteBg: base.surface,
      selectedDirtyUpdateBg: finalSelectedBg,
      selectedDirtyInsertBg: finalSelectedBg,
      selectedDirtyDeleteBg: finalSelectedBg,
      relationBg: base.bg,
      relationDisplayBg: base.bg,
      relationStripedBg: base.surface,
      relationDisplayStripedBg: base.surface,
      nullTagFg: base.meta,
      nullTagBg: base.surface,
      nullTagBorder: base.border,
      emptyTagFg: base.meta,
      emptyTagBg: base.surface,
      emptyTagBorder: base.border,
      dirtyNullTagFg: base.meta,
      dirtyNullTagBg: base.surface,
      dirtyNullTagBorder: base.border,
      headerHeight: measureHeaderHeight(host),
    };
  } else {
    const probed = probeDataTableThemeBatch(probeHost);
    result = {
      ...base,
      rownumBg: probed.rownumBg || base.bg,
      rownumStripedBg: probed.rownumStripedBg || base.surface,
      selectedBg: probed.selectedBg,
      dragSelectedBg: probed.dragSelectedBg,
      rowSelectedBg: accentSoft,
      dirtyUpdateBg: probed.dirtyUpdateBg,
      dirtyInsertBg: probed.dirtyInsertBg,
      dirtyDeleteBg: probed.dirtyDeleteBg,
      selectedDirtyUpdateBg: probed.selectedDirtyUpdateBg,
      selectedDirtyInsertBg: probed.selectedDirtyInsertBg,
      selectedDirtyDeleteBg: probed.selectedDirtyDeleteBg,
      relationBg: probed.relationBg,
      relationDisplayBg: probed.relationDisplayBg,
      relationStripedBg: probed.relationStripedBg,
      relationDisplayStripedBg: probed.relationDisplayStripedBg,
      nullTagFg: probed.nullTag.color,
      nullTagBg: probed.nullTag.backgroundColor,
      nullTagBorder: probed.nullTag.borderColor,
      emptyTagFg: probed.emptyTag.color,
      emptyTagBg: probed.emptyTag.backgroundColor,
      emptyTagBorder: probed.emptyTag.borderColor,
      dirtyNullTagFg: probed.dirtyNullTag.color,
      dirtyNullTagBg: probed.dirtyNullTag.backgroundColor,
      dirtyNullTagBorder: probed.dirtyNullTag.borderColor,
      headerHeight: measureHeaderHeight(host),
    };
  }

  themeCache.set(cacheKey, result);
  return result;
}

/** @deprecated 使用 readCanvasGridTheme */
export function readGridTheme(host: HTMLElement | null): GridThemeTokens {
  return readCanvasGridTheme(host, "data-table");
}

export function measureHeaderHeight(host: HTMLElement | null): number {
  if (!host) return 28;
  const thead = host.querySelector("thead");
  if (thead instanceof HTMLElement) {
    const h = thead.getBoundingClientRect().height;
    if (h > 0) return h;
  }
  const th = host.querySelector("th");
  if (th instanceof HTMLElement) {
    const h = th.getBoundingClientRect().height;
    if (h > 0) return h;
  }
  return parsePx(getComputedStyle(host).getPropertyValue("--db-grid-header-height"), 28);
}
