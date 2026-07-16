import { useMemo } from "react";
import { useScopedSearchQuery } from "../../../components/ui/search/ScopedSearch";
import { SqlEditor } from "../sql/SqlEditor";
import { VirtualSqlPreview } from "./VirtualSqlPreview";

/** 超过该行数改用虚拟滚动，避免大 SQL 文件拖垮 CodeMirror。 */
export const SQL_PREVIEW_VIRTUAL_LINE_THRESHOLD = 1000;

interface TableDdlViewerProps {
  ddl: string;
}

/** 只读 SQL 编辑器，用于展示建表语句 / 同步预览 SQL。 */
export function TableDdlViewer({ ddl }: TableDdlViewerProps) {
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

  if (lineCount > SQL_PREVIEW_VIRTUAL_LINE_THRESHOLD) {
    return <VirtualSqlPreview ddl={ddl} />;
  }

  return (
    <div className="table-ddl-viewer">
      <SqlEditor
        value={ddl}
        onChange={() => undefined}
        readOnly
        openMode="table"
        highlightQuery={highlightQuery}
      />
    </div>
  );
}
