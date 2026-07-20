export interface FilesModuleContext {
  connectionId: string | null;
  connectionName: string | null;
  currentPath: string | null;
}

export function isFilesModuleContextEmpty(context: FilesModuleContext): boolean {
  return !context.connectionId && !context.currentPath;
}
