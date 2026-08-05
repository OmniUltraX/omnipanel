import { useMemo } from "react";
import { useScopedSearchQuery } from "../../../components/ui/search/ScopedSearch";
import { SqlEditor } from "../sql/SqlEditor";
import { VirtualSqlPreview } from "./VirtualSqlPreview";

/** 超过该行数改用虚拟滚动，避免大 SQL 文件拖垮 CodeMirror。 */
export const SQL_PREVIEW_VIRTUAL_LINE_THRESHOLD = 1000;

interface TableDdlViewerProps {
  ddl: string;
  /** 默认只读；同步确认框可设为可编辑 */
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

/** SQL 预览 / 编辑器，用于建表语句与同步确认 SQL。 */
export function TableDdlViewer({
  ddl,
  readOnly = true,
  onChange,
}: TableDdlViewerProps) {
  const highlightQuery = useScopedSearchQuery();
  const lineCount = useMemo(() => {
    if (!ddl) {
      return 0;
    }
    let count = 1;
    for (let i = 0; i < ddl.length; i += 1) {
      if (ddl.charCodeAt(i) === 10) {
        count += 1;
      }
    }
    return count;
  }, [ddl]);

  // 可编辑时必须用编辑器；超大只读脚本仍走虚拟列表
  if (readOnly && lineCount > SQL_PREVIEW_VIRTUAL_LINE_THRESHOLD) {
    return <VirtualSqlPreview ddl={ddl} />;
  }

  return (
    <div className={`table-ddl-viewer${readOnly ? "" : " table-ddl-viewer--editable"}`}>
      <SqlEditor
        value={ddl}
        onChange={onChange ?? (() => undefined)}
        readOnly={readOnly}
        openMode="table"
        highlightQuery={highlightQuery}
      />
    </div>
  );
}
