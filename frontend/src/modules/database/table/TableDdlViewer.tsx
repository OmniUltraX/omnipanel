import { useScopedSearchQuery } from "../../../components/ui/search/ScopedSearch";
import { SqlEditor } from "../sql/SqlEditor";

interface TableDdlViewerProps {
  ddl: string;
}

/** 只读 SQL 编辑器，用于展示建表语句。 */
export function TableDdlViewer({ ddl }: TableDdlViewerProps) {
  const highlightQuery = useScopedSearchQuery();

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
