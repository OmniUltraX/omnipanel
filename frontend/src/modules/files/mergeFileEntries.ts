import type { FileEntry } from "../../ipc/bindings";
import { sortFileEntries } from "./utils";

/** 按 path 合并目录项，用于 S3 分页追加。 */
export function mergeFileEntries(existing: FileEntry[], incoming: FileEntry[]): FileEntry[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((e) => e.path));
  const next = [...existing];
  for (const entry of incoming) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    next.push(entry);
  }
  return sortFileEntries(next);
}
