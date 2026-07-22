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

function probeDataTableBackground(host: HTMLElement, classNames: string[]): string {
  const table = document.createElement("table");
  table.className = "db-data-table";
  table.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  tr.className = classNames.find((c) => c.startsWith("db-data-table-row")) ?? "db-data-table-row";
  for (const cls of classNames) {
    if (cls.startsWith("db-data-table-row")) {
      tr.classList.add(cls);
    }
  }
  const td = document.createElement("td");
  td.className = "db-data-table-cell";
  for (const cls of classNames) {
    if (!cls.startsWith("db-data-table-row")) {
      td.classList.add(cls);
    }
  }
  tr.appendChild(td);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  host.appendChild(table);
  const bg = getComputedStyle(td).backgroundColor;
  host.removeChild(table);
  return bg;
}

function probeDataTableTag(
  host: HTMLElement,
  tagClass: string,
  dirty: boolean,
): {
  color: string;
  backgroundColor: string;
  borderColor: string;
} {
  const table = document.createElement("table");
  table.className = "db-data-table";
  table.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
  const tbody = document.createElement("tbody");
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
  table.appendChild(tbody);
  host.appendChild(table);
  const style = getComputedStyle(span);
  const result = {
    color: style.color,
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
  };
  host.removeChild(table);
  return result;
}

function probePanelBackground(
  host: HTMLElement,
  options: { rowSelected?: boolean; cellSelected?: boolean },
): string {
  const table = document.createElement("table");
  table.className = "db-tables-panel-grid";
  table.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  if (options.rowSelected) tr.className = "is-selected";
  const td = document.createElement("td");
  if (options.cellSelected) td.className = "db-tables-panel-grid__cell--selected";
  tr.appendChild(td);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  host.appendChild(table);
  const bg = getComputedStyle(options.cellSelected ? td : tr).backgroundColor;
  host.removeChild(table);
  return bg;
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
  const root = host ?? document.documentElement;
  const style = getComputedStyle(root);
  const mono = readColor(style, "--font-mono", "ui-monospace, monospace");
  const fontFamily = `"Maple Mono NF CN Light", ${mono}`;
  const probeHost = host ?? document.body;
  const base = baseTheme(style, fontFamily);
  const accentSoft = readColor(style, "--accent-soft", "rgba(76, 139, 245, 0.18)");

  if (profile === "panel") {
    const selectedBg =
      probePanelBackground(probeHost, { cellSelected: true }) || accentSoft;
    const rowSelectedBg =
      probePanelBackground(probeHost, { rowSelected: true }) || accentSoft;
    const hostBg =
      host != null
        ? getComputedStyle(host).backgroundColor
        : "";
    return {
      ...base,
      bg: hostBg && hostBg !== "rgba(0, 0, 0, 0)" && hostBg !== "transparent" ? hostBg : base.bg,
      fontSize: 11,
      cellPaddingX: 8,
      cellPaddingY: 6,
      rownumBg: base.bg,
      rownumStripedBg: base.surface,
      selectedBg,
      dragSelectedBg: selectedBg,
      rowSelectedBg,
      dirtyUpdateBg: base.surface,
      dirtyInsertBg: base.surface,
      dirtyDeleteBg: base.surface,
      selectedDirtyUpdateBg: selectedBg,
      selectedDirtyInsertBg: selectedBg,
      selectedDirtyDeleteBg: selectedBg,
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
  }

  const nullTag = probeDataTableTag(probeHost, "db-data-table-cell-null-tag", false);
  const emptyTag = probeDataTableTag(probeHost, "db-data-table-cell-empty-tag", false);
  const dirtyNullTag = probeDataTableTag(probeHost, "db-data-table-cell-null-tag", true);

  return {
    ...base,
    rownumBg:
      probeDataTableBackground(probeHost, ["db-data-table-row", "db-data-table-cell--rownum"]) ||
      base.bg,
    rownumStripedBg:
      probeDataTableBackground(probeHost, [
        "db-data-table-row",
        "db-data-table-row--striped",
        "db-data-table-cell--rownum",
      ]) || base.surface,
    selectedBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--selected",
    ]),
    dragSelectedBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--drag-selected",
    ]),
    rowSelectedBg: accentSoft,
    dirtyUpdateBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--dirty",
    ]),
    dirtyInsertBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--dirty",
      "db-data-table-cell--dirty-insert",
    ]),
    dirtyDeleteBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--dirty",
      "db-data-table-cell--dirty-delete",
    ]),
    selectedDirtyUpdateBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--selected",
      "db-data-table-cell--dirty",
    ]),
    selectedDirtyInsertBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--selected",
      "db-data-table-cell--dirty",
      "db-data-table-cell--dirty-insert",
    ]),
    selectedDirtyDeleteBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--selected",
      "db-data-table-cell--dirty",
      "db-data-table-cell--dirty-delete",
    ]),
    relationBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--relation",
    ]),
    relationDisplayBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-cell--relation-display",
    ]),
    relationStripedBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-row--striped",
      "db-data-table-cell--relation",
    ]),
    relationDisplayStripedBg: probeDataTableBackground(probeHost, [
      "db-data-table-row",
      "db-data-table-row--striped",
      "db-data-table-cell--relation-display",
    ]),
    nullTagFg: nullTag.color,
    nullTagBg: nullTag.backgroundColor,
    nullTagBorder: nullTag.borderColor,
    emptyTagFg: emptyTag.color,
    emptyTagBg: emptyTag.backgroundColor,
    emptyTagBorder: emptyTag.borderColor,
    dirtyNullTagFg: dirtyNullTag.color,
    dirtyNullTagBg: dirtyNullTag.backgroundColor,
    dirtyNullTagBorder: dirtyNullTag.borderColor,
    headerHeight: measureHeaderHeight(host),
  };
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
