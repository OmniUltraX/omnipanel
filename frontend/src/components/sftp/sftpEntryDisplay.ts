import type { FileEntryType } from "../ui/icons/FileEntryIcon";
import type { SftpEntry } from "./sftpUtils";

export function sftpEntryIconType(entry: SftpEntry): FileEntryType {
  if (entry.isSymlink) return "symlink";
  if (entry.isDir) return "dir";
  return "file";
}

export function sftpEntryRowClass(entry: SftpEntry): string {
  if (entry.isSymlink) return "sftp-row-link";
  if (entry.isDir) return "sftp-row-dir";
  return "sftp-row-file";
}

export function sftpEntryDisplayName(entry: SftpEntry): string {
  if (entry.isSymlink && entry.linkTarget) {
    return `${entry.name} → ${entry.linkTarget}`;
  }
  return entry.name;
}

export function sftpEntryNameClass(entry: SftpEntry): string {
  if (entry.isSymlink) return "sftp-name-link";
  if (entry.isDir) return "sftp-name-dir";
  return "sftp-name-file";
}
