import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { DatabaseSchema } from "../../types";
import { Catalog, type Column, type Database, type ResolvedTable } from "../catalog";
import { sliceStatementAtOffset, statementOffsetAtPos } from "../parser/ast";
import {
  analyzeStatementAtOffset,
  resolveTableByAlias,
  resolveMissingTableHover,
  type StatementAnalysis,
} from "../parser/analyzer";
import { resolveDerivedColumnInStatement, type DerivedColumn } from "../parser/derivedColumns";
import { mountSqlHighlightBlock } from "./sqlHoverHighlight";

function stripQuotes(name: string): string {
  return name.replace(/^[`"]|[`"]$/g, "");
}

function identifierAtPos(line: string, offsetInLine: number): { word: string; from: number; to: number } | null {
  const re = /[`"]?[\w$]+[`"]?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (offsetInLine >= start && offsetInLine <= end) {
      const word = stripQuotes(raw);
      return { word, from: start, to: end };
    }
  }
  return null;
}

function qualifierBeforePos(line: string, identFrom: number): string | null {
  const prefix = line.slice(0, identFrom);
  const match = prefix.match(/([`"]?[\w$]+[`"]?)\.\s*$/);
  if (!match) return null;
  return stripQuotes(match[1]);
}

function formatNullable(nullable: boolean | undefined): string {
  if (nullable === undefined) return "—";
  return nullable ? "是" : "否";
}

function formatYesNo(value: boolean | undefined): string {
  return value ? "是" : "否";
}

function formatDataSource(database: Database): string {
  const parts: string[] = [];
  if (database.connectionName?.trim()) {
    parts.push(database.connectionName.trim());
  }
  if (database.dbType?.trim()) {
    parts.push(database.dbType.trim().toUpperCase());
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function createBadge(text: string, variant: "kind" | "pk" | "fk" | "count"): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = `db-sql-hover-badge db-sql-hover-badge--${variant}`;
  badge.textContent = text;
  return badge;
}

function createMetaGrid(rows: { label: string; value: string; mono?: boolean }[]): HTMLElement {
  const grid = document.createElement("dl");
  grid.className = "db-sql-hover-meta";

  for (const row of rows) {
    const dt = document.createElement("dt");
    dt.className = "db-sql-hover-meta__label";
    dt.textContent = row.label;

    const dd = document.createElement("dd");
    dd.className = `db-sql-hover-meta__value${row.mono ? " db-sql-hover-meta__value--mono" : ""}`;
    dd.textContent = row.value || "—";

    grid.appendChild(dt);
    grid.appendChild(dd);
  }

  return grid;
}

function appendNullableCell(row: HTMLTableRowElement, nullable: boolean | undefined): void {
  const cell = document.createElement("td");
  const span = document.createElement("span");
  if (nullable === undefined) {
    span.className = "db-sql-hover-null db-sql-hover-null--unknown";
    span.textContent = "—";
  } else if (nullable) {
    span.className = "db-sql-hover-null db-sql-hover-null--yes";
    span.textContent = "是";
  } else {
    span.className = "db-sql-hover-null db-sql-hover-null--no";
    span.textContent = "否";
  }
  cell.appendChild(span);
  row.appendChild(cell);
}

function appendKeyBadgesCell(row: HTMLTableRowElement, column: Column): void {
  const cell = document.createElement("td");
  const wrap = document.createElement("div");
  wrap.className = "db-sql-hover-keys";

  if (column.isPK) {
    wrap.appendChild(createBadge("PK", "pk"));
  }
  if (column.isFK) {
    wrap.appendChild(createBadge("FK", "fk"));
  }
  if (!column.isPK && !column.isFK) {
    const empty = document.createElement("span");
    empty.className = "db-sql-hover-keys__empty";
    empty.textContent = "—";
    wrap.appendChild(empty);
  }

  cell.appendChild(wrap);
  row.appendChild(cell);
}

function appendTextCell(row: HTMLTableRowElement, text: string, className?: string): void {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  row.appendChild(cell);
}

function createColumnsTable(columns: Column[]): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "db-sql-hover-table db-data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["字段", "类型", "可空", "键", "注释"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const column of columns) {
    const row = document.createElement("tr");
    appendTextCell(row, column.name, "db-sql-hover-table__name");
    appendTextCell(row, column.type, "db-sql-hover-table__type");
    appendNullableCell(row, column.nullable);
    appendKeyBadgesCell(row, column);
    appendTextCell(row, column.comment?.trim() || "—", "db-sql-hover-table__comment");
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

function createHeader(
  kindLabel: string,
  title: string,
  subtitle?: string,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "db-sql-hover-header";

  const titleRow = document.createElement("div");
  titleRow.className = "db-sql-hover-header__title-row";

  titleRow.appendChild(createBadge(kindLabel, "kind"));

  const titleEl = document.createElement("span");
  titleEl.className = "db-sql-hover-header__title";
  titleEl.textContent = title;
  titleRow.appendChild(titleEl);

  header.appendChild(titleRow);

  if (subtitle) {
    const subtitleEl = document.createElement("div");
    subtitleEl.className = "db-sql-hover-header__subtitle";
    subtitleEl.textContent = subtitle;
    header.appendChild(subtitleEl);
  }

  return header;
}

function buildTableTooltipDom(
  resolved: ResolvedTable,
  options?: { alias?: string },
): HTMLElement {
  const { database, table } = resolved;
  const dom = document.createElement("div");
  dom.className = "db-sql-hover-card db-sql-hover-card--table";

  dom.appendChild(
    createHeader(
      table.kind === "view" ? "视图" : "表",
      table.name,
      `${database.name}.${table.name}`,
    ),
  );

  const metaRows = [
    { label: "数据源", value: formatDataSource(database) },
    { label: "数据库", value: database.name, mono: true },
    { label: "对象", value: table.kind === "view" ? "视图" : "数据表" },
    { label: "注释", value: table.comment?.trim() || "—" },
  ];
  if (options?.alias && options.alias.toLowerCase() !== table.name.toLowerCase()) {
    metaRows.push({ label: "别名", value: options.alias, mono: true });
  }
  dom.appendChild(createMetaGrid(metaRows));

  if (table.columns.length > 0) {
    const section = document.createElement("div");
    section.className = "db-sql-hover-section";

    const sectionHead = document.createElement("div");
    sectionHead.className = "db-sql-hover-section__head";

    const sectionTitle = document.createElement("span");
    sectionTitle.className = "db-sql-hover-section__title";
    sectionTitle.textContent = "字段";
    sectionHead.appendChild(sectionTitle);
    sectionHead.appendChild(createBadge(String(table.columns.length), "count"));
    section.appendChild(sectionHead);

    const scroll = document.createElement("div");
    scroll.className = "db-sql-hover-section__scroll";
    scroll.appendChild(createColumnsTable(table.columns));
    section.appendChild(scroll);

    dom.appendChild(section);
  }

  return dom;
}

function buildColumnTooltipDom(
  resolved: ResolvedTable,
  column: Column,
  options?: { qualifier?: string },
): HTMLElement {
  const { database, table } = resolved;
  const dom = document.createElement("div");
  dom.className = "db-sql-hover-card db-sql-hover-card--column";

  const displayName =
    options?.qualifier && options.qualifier.toLowerCase() !== table.name.toLowerCase()
      ? `${options.qualifier}.${column.name}`
      : column.name;

  dom.appendChild(
    createHeader("字段", displayName, `${database.name}.${table.name}.${column.name}`),
  );

  dom.appendChild(
    createMetaGrid([
      { label: "数据源", value: formatDataSource(database) },
      { label: "数据库", value: database.name, mono: true },
      { label: "表", value: table.name, mono: true },
      { label: "对象", value: table.kind === "view" ? "视图" : "数据表" },
      { label: "类型", value: column.type, mono: true },
      { label: "可空", value: formatNullable(column.nullable) },
      { label: "主键", value: formatYesNo(column.isPK) },
      { label: "外键", value: formatYesNo(column.isFK) },
      { label: "注释", value: column.comment?.trim() || "—" },
    ]),
  );

  const keys = document.createElement("div");
  keys.className = "db-sql-hover-keys db-sql-hover-keys--footer";
  if (column.isPK) keys.appendChild(createBadge("PK", "pk"));
  if (column.isFK) keys.appendChild(createBadge("FK", "fk"));
  if (column.isPK || column.isFK) {
    dom.appendChild(keys);
  }

  return dom;
}

function buildDerivedColumnTooltipDom(
  derived: DerivedColumn,
  qualifier: string,
  dbType?: string | null,
): { dom: HTMLElement; destroy?: () => void } {
  const dom = document.createElement("div");
  dom.className = "db-sql-hover-card db-sql-hover-card--derived";

  dom.appendChild(
    createHeader("派生字段", `${qualifier}.${derived.name}`, `子查询 ${derived.sourceAlias}`),
  );

  dom.appendChild(
    createMetaGrid([
      { label: "来源", value: "子查询输出列" },
      { label: "别名", value: derived.sourceAlias, mono: true },
      { label: "字段", value: derived.name, mono: true },
    ]),
  );

  const section = document.createElement("div");
  section.className = "db-sql-hover-section";

  const sectionHead = document.createElement("div");
  sectionHead.className = "db-sql-hover-section__head";
  const sectionTitle = document.createElement("span");
  sectionTitle.className = "db-sql-hover-section__title";
  sectionTitle.textContent = "定义";
  sectionHead.appendChild(sectionTitle);
  section.appendChild(sectionHead);

  const highlight = mountSqlHighlightBlock(derived.expression, dbType);
  section.appendChild(highlight.host);

  dom.appendChild(section);
  return { dom, destroy: highlight.destroy };
}

function buildMissingTableTooltipDom(displayName: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "db-sql-hover-card db-sql-hover-card--missing-table";

  const header = document.createElement("div");
  header.className = "db-sql-hover-header";

  const titleRow = document.createElement("div");
  titleRow.className = "db-sql-hover-header__title-row";

  const titleEl = document.createElement("div");
  titleEl.className = "db-sql-hover-header__title";
  titleEl.textContent = "表不存在";

  titleRow.appendChild(titleEl);
  header.appendChild(titleRow);

  const subtitleEl = document.createElement("div");
  subtitleEl.className = "db-sql-hover-header__subtitle db-sql-hover-header__subtitle--mono";
  subtitleEl.textContent = displayName;
  header.appendChild(subtitleEl);

  dom.appendChild(header);
  return dom;
}

function makeTooltip(dom: HTMLElement, destroy?: () => void): Tooltip {
  const onMouseDown = (event: MouseEvent) => {
    event.stopPropagation();
  };
  dom.addEventListener("mousedown", onMouseDown);

  return {
    pos: 0,
    dom,
    create() {
      return {
        dom,
        destroy: () => {
          dom.removeEventListener("mousedown", onMouseDown);
          destroy?.();
        },
      };
    },
  };
}

function resolveQualifiedTable(
  catalog: Catalog,
  schemaName: string,
  tableName: string,
): ResolvedTable | null {
  return catalog.findTable(tableName, schemaName);
}

function resolveColumnInStatement(
  catalog: Catalog,
  analysis: StatementAnalysis,
  word: string,
): { resolved: ResolvedTable; column: Column; qualifier?: string } | null {
  for (const ref of analysis.tables) {
    const resolved = catalog.findTable(ref.tableName, ref.schemaName);
    if (!resolved) continue;
    const column = resolved.table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
    if (column) {
      return {
        resolved,
        column,
        qualifier: ref.alias && ref.alias.toLowerCase() !== ref.tableName.toLowerCase() ? ref.alias : undefined,
      };
    }
  }
  return null;
}

function resolveColumnByCatalog(catalog: Catalog, word: string): { resolved: ResolvedTable; column: Column } | null {
  const matches: { resolved: ResolvedTable; column: Column }[] = [];
  for (const database of catalog.databases) {
    for (const table of database.tables) {
      const column = table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
      if (!column) continue;
      matches.push({
        resolved: {
          database,
          table,
          qualifiedTable: `${database.name}.${table.name}`,
        },
        column,
      });
    }
  }
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

function resolveHoverTarget(
  catalog: Catalog,
  analysis: StatementAnalysis | null,
  statement: string,
  dbType: string | undefined,
  word: string,
  qualifier: string | null,
):
  | { kind: "table"; resolved: ResolvedTable; alias?: string }
  | { kind: "column"; resolved: ResolvedTable; column: Column; qualifier?: string }
  | { kind: "derived"; derived: DerivedColumn; qualifier: string }
  | null {
  if (qualifier) {
    const derived = resolveDerivedColumnInStatement(statement, qualifier, word, dbType);
    if (derived) {
      return { kind: "derived", derived, qualifier };
    }

    const qualifiedTable = resolveQualifiedTable(catalog, qualifier, word);
    if (qualifiedTable && qualifiedTable.table.name.toLowerCase() === word.toLowerCase()) {
      return { kind: "table", resolved: qualifiedTable };
    }

    if (analysis) {
      const aliasTable = resolveTableByAlias(catalog, analysis, qualifier);
      const column = aliasTable?.table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
      if (column && aliasTable) {
        return {
          kind: "column",
          resolved: aliasTable,
          column,
          qualifier,
        };
      }
    }

    const schemaColumn = catalog.findColumn(qualifier, word);
    if (schemaColumn) {
      const resolved = catalog.findTable(qualifier);
      if (resolved) {
        return { kind: "column", resolved, column: schemaColumn, qualifier };
      }
    }

    return null;
  }

  if (analysis) {
    const tableRef = analysis.aliasMap.get(word.toLowerCase());
    if (tableRef) {
      const resolved = catalog.findTable(tableRef.tableName, tableRef.schemaName);
      if (resolved) {
        const alias =
          tableRef.alias && tableRef.alias.toLowerCase() === word.toLowerCase() ? word : undefined;
        return { kind: "table", resolved, alias };
      }
    }

    const statementColumn = resolveColumnInStatement(catalog, analysis, word);
    if (statementColumn) {
      return { kind: "column", ...statementColumn };
    }
  }

  const resolvedTable = catalog.findTable(word);
  if (resolvedTable) {
    return { kind: "table", resolved: resolvedTable };
  }

  const catalogColumn = resolveColumnByCatalog(catalog, word);
  if (catalogColumn) {
    return { kind: "column", ...catalogColumn };
  }

  return null;
}

/** 表/列 Hover 提示（Metadata Catalog + 语句内别名解析）。 */
export function createSqlHoverTooltip(
  getSchemas: () => DatabaseSchema[],
  getDbType?: () => string | undefined,
) {
  return hoverTooltip(
    (view, pos) => {
      const catalog = Catalog.fromSchemas(getSchemas());
      const line = view.state.doc.lineAt(pos);
      const offsetInLine = pos - line.from;
      const ident = identifierAtPos(line.text, offsetInLine);
      if (!ident) return null;

      const word = ident.word;
      const doc = view.state.doc.toString();
      const statement = sliceStatementAtOffset(doc, pos);
      const offsetInStatement = statementOffsetAtPos(doc, pos);
      const dbType = getDbType?.();
      const analysis = analyzeStatementAtOffset(statement, offsetInStatement, dbType);
      const qualifier = qualifierBeforePos(line.text, ident.from);
      const target = resolveHoverTarget(catalog, analysis, statement, dbType, word, qualifier);
      const missingTable = target
        ? null
        : resolveMissingTableHover(catalog, analysis, word, qualifier);
      if (!target && !missingTable) return null;

      let tooltip: Tooltip;
      if (target?.kind === "table") {
        tooltip = makeTooltip(buildTableTooltipDom(target.resolved, { alias: target.alias }));
      } else if (target?.kind === "derived") {
        const built = buildDerivedColumnTooltipDom(target.derived, target.qualifier, dbType);
        tooltip = makeTooltip(built.dom, built.destroy);
      } else if (target?.kind === "column") {
        tooltip = makeTooltip(
          buildColumnTooltipDom(target.resolved, target.column, { qualifier: target.qualifier }),
        );
      } else {
        tooltip = makeTooltip(buildMissingTableTooltipDom(missingTable!));
      }

      return { ...tooltip, pos, end: pos + word.length };
    },
    {
      hoverTime: 280,
      /** 鼠标在浮层上时保持显示，便于拖选复制 SQL 定义。 */
      hideOn(_view, tooltip) {
        const dom = (tooltip as Tooltip & { dom?: HTMLElement }).dom;
        if (!dom) {
          return false;
        }
        return !dom.matches(":hover");
      },
    },
  );
}
