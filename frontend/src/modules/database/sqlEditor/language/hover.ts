import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { DatabaseSchema } from "../../types";
import { Catalog } from "../catalog";
import { sliceStatementAtOffset } from "../parser/ast";
import { analyzeStatement, resolveTableByAlias } from "../parser/analyzer";

function identifierAtPos(line: string, offsetInLine: number): { word: string; from: number; to: number } | null {
  const re = /[`"]?[\w$]+[`"]?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (offsetInLine >= start && offsetInLine <= end) {
      const word = raw.replace(/^[`"]|[`"]$/g, "");
      return { word, from: start, to: end };
    }
  }
  return null;
}

function qualifierBeforePos(line: string, identFrom: number): string | null {
  const prefix = line.slice(0, identFrom);
  const match = prefix.match(/([`"]?[\w$]+[`"]?)\.\s*$/);
  if (!match) return null;
  return match[1].replace(/^[`"]|[`"]$/g, "");
}

function buildTableTooltip(
  tableName: string,
  columns: { name: string; type: string }[],
  alias?: string,
): Tooltip {
  const aliasLine = alias && alias.toLowerCase() !== tableName.toLowerCase() ? `别名 ${alias}\n` : "";
  const columnLines = columns
    .slice(0, 24)
    .map((col) => `${col.name}: ${col.type}`)
    .join("\n");
  const more = columns.length > 24 ? `\n… +${columns.length - 24} 列` : "";
  return {
    pos: 0,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-sql-hover-tooltip";
      dom.textContent = `${aliasLine}表 ${tableName}\n${columnLines}${more}`;
      return { dom };
    },
  };
}

function buildColumnTooltip(tableName: string, columnName: string, type: string, alias?: string): Tooltip {
  const prefix = alias && alias.toLowerCase() !== tableName.toLowerCase() ? `${alias} → ` : "";
  return {
    pos: 0,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-sql-hover-tooltip";
      dom.textContent = `${prefix}${tableName}.${columnName}\n${type}`;
      return { dom };
    },
  };
}

/** 表/列 Hover 提示（Metadata Catalog + 语句内别名解析）。 */
export function createSqlHoverTooltip(
  getSchemas: () => DatabaseSchema[],
  getDbType?: () => string | undefined,
) {
  return hoverTooltip((view, pos) => {
    const schemas = getSchemas();
    if (schemas.length === 0) return null;

    const catalog = Catalog.fromSchemas(schemas);
    const line = view.state.doc.lineAt(pos);
    const offsetInLine = pos - line.from;
    const ident = identifierAtPos(line.text, offsetInLine);
    if (!ident) return null;

    const word = ident.word;
    const doc = view.state.doc.toString();
    const statement = sliceStatementAtOffset(doc, pos);
    const analysis = analyzeStatement(statement, getDbType?.());
    const qualifier = qualifierBeforePos(line.text, ident.from);

    if (qualifier && analysis) {
      const aliasTable = resolveTableByAlias(catalog, analysis, qualifier);
      const column = aliasTable?.table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
      if (column && aliasTable) {
        const tooltip = buildColumnTooltip(aliasTable.table.name, column.name, column.type, qualifier);
        return { ...tooltip, pos, end: pos + word.length };
      }
    }

    if (analysis) {
      const aliasRef = analysis.aliasMap.get(word.toLowerCase());
      if (aliasRef && aliasRef.alias?.toLowerCase() === word.toLowerCase()) {
        const resolved = catalog.findTable(aliasRef.tableName, aliasRef.schemaName);
        if (resolved) {
          const tooltip = buildTableTooltip(resolved.table.name, resolved.table.columns, word);
          return { ...tooltip, pos, end: pos + word.length };
        }
      }

      for (const ref of analysis.tables) {
        const table = catalog.findTable(ref.tableName, ref.schemaName);
        if (!table) continue;
        const column = table.table.columns.find((col) => col.name.toLowerCase() === word.toLowerCase());
        if (column) {
          const tooltip = buildColumnTooltip(table.table.name, column.name, column.type, ref.alias);
          return { ...tooltip, pos, end: pos + word.length };
        }
      }
    }

    const resolvedTable = catalog.findTable(word);
    if (resolvedTable) {
      const tooltip = buildTableTooltip(resolvedTable.table.name, resolvedTable.table.columns);
      return { ...tooltip, pos, end: pos + word.length };
    }

    return null;
  });
}
