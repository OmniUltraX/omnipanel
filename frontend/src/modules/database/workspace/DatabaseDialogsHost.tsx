import type { DbConnectionConfig } from "../api";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { ConnectionImportPreviewDialog } from "../connection/ConnectionImportPreviewDialog";
import type { NavicatImportPreviewItem } from "../navicatImport/types";
import type { MysqlExportDestination } from "../mysqlExport";
import type { MysqlImportSource } from "../mysqlImport";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";
import { MysqlExportDialog } from "./MysqlExportDialog";
import { MysqlImportDialog } from "./MysqlImportDialog";

export type DatabaseDialogsHostProps = {
  connections: DbConnectionConfig[];
  createDbDialog: { connId: string } | null;
  onCloseCreateDb: () => void;
  onCreatedDatabase: (connId: string) => void;
  exportDialog: { connection: DbConnectionConfig; databaseName: string } | null;
  exportSubmitting: boolean;
  onCloseExport: () => void;
  onConfirmExport: (destination: MysqlExportDestination) => void;
  importDialog: { connection: DbConnectionConfig; databaseName: string } | null;
  importSubmitting: boolean;
  onCloseImport: () => void;
  onConfirmImport: (source: MysqlImportSource) => void;
  dialogOpen: boolean;
  editingConnection: DbConnectionConfig | null;
  onCloseConnectionDialog: () => void;
  onSavedConnection: () => void;
  importPreview: { fileName: string; items: NavicatImportPreviewItem[] } | null;
  onCloseImportPreview: () => void;
  onImportedConnections: () => void;
};

/** 数据库模块对话框宿主：从 DatabasePanel 抽离，避免壳组件继续膨胀。 */
export function DatabaseDialogsHost({
  connections,
  createDbDialog,
  onCloseCreateDb,
  onCreatedDatabase,
  exportDialog,
  exportSubmitting,
  onCloseExport,
  onConfirmExport,
  importDialog,
  importSubmitting,
  onCloseImport,
  onConfirmImport,
  dialogOpen,
  editingConnection,
  onCloseConnectionDialog,
  onSavedConnection,
  importPreview,
  onCloseImportPreview,
  onImportedConnections,
}: DatabaseDialogsHostProps) {
  return (
    <>
      <CreateDatabaseDialog
        open={createDbDialog !== null}
        connection={
          createDbDialog
            ? (connections.find((c) => c.id === createDbDialog.connId) ?? null)
            : null
        }
        onCancel={onCloseCreateDb}
        onCreated={() => {
          const connId = createDbDialog?.connId;
          onCloseCreateDb();
          if (connId) onCreatedDatabase(connId);
        }}
      />
      <MysqlExportDialog
        open={exportDialog !== null}
        sourceConnection={exportDialog?.connection ?? null}
        sourceDatabase={exportDialog?.databaseName ?? ""}
        connections={connections}
        submitting={exportSubmitting}
        onClose={() => {
          if (!exportSubmitting) onCloseExport();
        }}
        onConfirm={onConfirmExport}
      />
      <MysqlImportDialog
        open={importDialog !== null}
        connection={importDialog?.connection ?? null}
        databaseName={importDialog?.databaseName ?? ""}
        submitting={importSubmitting}
        onClose={() => {
          if (!importSubmitting) onCloseImport();
        }}
        onConfirm={onConfirmImport}
      />
      <ConnectionDialog
        open={dialogOpen}
        onClose={onCloseConnectionDialog}
        onSaved={onSavedConnection}
        initialConnection={editingConnection}
      />
      <ConnectionImportPreviewDialog
        open={importPreview !== null}
        fileName={importPreview?.fileName ?? ""}
        items={importPreview?.items ?? []}
        existingConnections={connections}
        onClose={onCloseImportPreview}
        onImported={onImportedConnections}
      />
    </>
  );
}
