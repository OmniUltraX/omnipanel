import type { SftpEntry } from "@/ipc/bindings";
import type { LsEntry, LsListing } from "./parseLsListing";
import { classifyLsEntryKindFromName, normalizeLsEntryName } from "./parseLsListing";

/** 用 SFTP 目录元数据修正 plain ls 对无扩展名条目的类型猜测。 */
export function enrichLsListingWithSftp(
  listing: LsListing,
  sftpEntries: SftpEntry[],
): LsListing {
  if (listing.layout !== "grid" || sftpEntries.length === 0) {
    return listing;
  }

  // 兼容 ls 加 -F 标志时的 / 后缀：SFTP 列表没有该后缀。
  const byName = new Map(
    sftpEntries.map((entry) => [normalizeLsEntryName(entry.name), entry] as const),
  );
  // 同时准备一个 ANSI 兼容的 fallback（兜底 entry.name 仍带 ANSI 残留的情况）
  const byCleanName = new Map(
    sftpEntries.map((entry) => [stripAnsiAndPunct(entry.name), entry] as const),
  );

  const entries: LsEntry[] = listing.entries.map((entry) => {
    const name = entry.name;
    let meta = byName.get(name);
    if (!meta) {
      const cleaned = stripAnsiAndPunct(name);
      meta = byCleanName.get(cleaned);
    }
    if (!meta) return entry;

    if (meta.isSymlink) {
      return { ...entry, kind: "symlink", navigable: meta.isDir };
    }

    if (meta.isDir) {
      return { ...entry, kind: "directory", navigable: true };
    }

    if (entry.kind === "directory") {
      // grid 启发式错判的 directory（如无扩展名普通文件 "sudoers"）：
      // SFTP 明确是 file，需要把 kind 改回 file，并清掉 navigable 否则会按目录触发 cd
      return { ...entry, kind: classifyLsEntryKindFromName(entry.name), navigable: false };
    }

    return entry;
  });

  return { ...listing, entries };
}

function stripAnsiAndPunct(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[*@=/]+$/g, "")
    .toLowerCase();
}
