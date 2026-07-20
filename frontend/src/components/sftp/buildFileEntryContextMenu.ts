import type { ContextMenuItem } from "../ui/menu/ContextMenu";

export type FileEntryCtxLabels = {
  open: string;
  openDir: string;
  openFile: string;
  edit: string;
  download: string;
  copyName: string;
  copyPath: string;
  copyCd: string;
  listDir: string;
  viewContent: string;
  showInfo: string;
  revealInSftp: string;
  rename: string;
  chmod: string;
  delete: string;
};

export type FileEntryCtxHandlers = {
  onOpen?: () => void;
  onEdit?: () => void;
  onDownload?: () => void;
  onCopyName?: () => void;
  onCopyPath?: () => void;
  onCopyCd?: () => void;
  onListDir?: () => void;
  onViewContent?: () => void;
  onShowInfo?: () => void;
  onRevealInSftp?: () => void;
  onRename?: () => void;
  onChmod?: () => void;
  onDelete?: () => void;
};

export type BuildFileEntryContextMenuOptions = {
  isDir: boolean;
  labels: FileEntryCtxLabels;
  handlers: FileEntryCtxHandlers;
};

function pushSep(items: ContextMenuItem[], id: string) {
  if (items.length === 0) return;
  const last = items[items.length - 1];
  if (last?.separator) return;
  items.push({ id, label: "", separator: true });
}

/** 文件/目录统一右键菜单（终端 ls block 与 SFTP / 本地文件侧栏共用） */
export function buildFileEntryContextMenuItems(
  options: BuildFileEntryContextMenuOptions,
): ContextMenuItem[] {
  const { isDir, labels, handlers } = options;
  const items: ContextMenuItem[] = [];

  if (handlers.onOpen) {
    items.push({
      id: "open",
      label: isDir ? labels.openDir : labels.openFile,
      onClick: handlers.onOpen,
    });
  }
  if (!isDir && handlers.onEdit) {
    items.push({
      id: "edit",
      label: labels.edit,
      onClick: handlers.onEdit,
    });
  }
  if (!isDir && handlers.onDownload) {
    items.push({
      id: "download",
      label: labels.download,
      onClick: handlers.onDownload,
    });
  }

  pushSep(items, "sep-copy");
  if (handlers.onCopyName) {
    items.push({ id: "copy-name", label: labels.copyName, onClick: handlers.onCopyName });
  }
  if (handlers.onCopyPath) {
    items.push({ id: "copy-path", label: labels.copyPath, onClick: handlers.onCopyPath });
  }
  if (isDir && handlers.onCopyCd) {
    items.push({ id: "copy-cd", label: labels.copyCd, onClick: handlers.onCopyCd });
  }

  const hasShell =
    handlers.onListDir || handlers.onViewContent || handlers.onShowInfo || handlers.onRevealInSftp;
  if (hasShell) {
    pushSep(items, "sep-shell");
    if (isDir && handlers.onListDir) {
      items.push({ id: "list-dir", label: labels.listDir, onClick: handlers.onListDir });
    }
    if (!isDir && handlers.onViewContent) {
      items.push({ id: "view-content", label: labels.viewContent, onClick: handlers.onViewContent });
    }
    if (handlers.onShowInfo) {
      items.push({ id: "show-info", label: labels.showInfo, onClick: handlers.onShowInfo });
    }
    if (handlers.onRevealInSftp) {
      items.push({
        id: "reveal-sftp",
        label: labels.revealInSftp,
        onClick: handlers.onRevealInSftp,
      });
    }
  }

  const hasMutate = handlers.onRename || handlers.onChmod || handlers.onDelete;
  if (hasMutate) {
    pushSep(items, "sep-mutate");
    if (handlers.onRename) {
      items.push({ id: "rename", label: labels.rename, onClick: handlers.onRename });
    }
    if (handlers.onChmod) {
      items.push({ id: "chmod", label: labels.chmod, onClick: handlers.onChmod });
    }
    if (handlers.onDelete) {
      items.push({
        id: "delete",
        label: labels.delete,
        danger: true,
        onClick: handlers.onDelete,
      });
    }
  }

  return items;
}
