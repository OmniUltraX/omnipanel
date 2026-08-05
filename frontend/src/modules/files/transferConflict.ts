import { t } from "../../i18n";
import { appChoose } from "../../lib/appChoose";
import type { FileTransferConflictPolicy } from "../../ipc/bindings";

export type TransferConflictChoice = FileTransferConflictPolicy; // skip | overwrite | rename

/**
 * 目标目录已有同名项时，弹出单层三选一：「自动改名 / 覆盖 / 跳过」。
 * 无冲突时返回 rename（与文件面板粘贴行为一致）。
 * 用户关闭/取消（返回 null）时按 skip 处理，避免误覆盖。
 */
export async function promptTransferConflictPolicy(
  itemNames: string[],
  existingNames: Iterable<string>,
): Promise<TransferConflictChoice> {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames);
  const conflictNames = [...new Set(itemNames.map((n) => topLevelName(n)).filter(Boolean))].filter(
    (name) => existing.has(name),
  );
  if (conflictNames.length === 0) return "rename";

  const preview = conflictNames.slice(0, 5).join(", ");
  const names = conflictNames.length > 5 ? `${preview}…` : preview;

  const choice = await appChoose(
    t("files.transfer.conflictBody", { count: conflictNames.length, names }),
    t("files.transfer.conflictTitle"),
    [
      { id: "rename", label: t("files.transfer.conflictRename"), variant: "primary" },
      { id: "overwrite", label: t("files.transfer.conflictOverwrite"), variant: "warn" },
      { id: "skip", label: t("files.transfer.conflictSkip"), variant: "secondary" },
    ],
  );

  if (choice === "overwrite") return "overwrite";
  if (choice === "skip") return "skip";
  if (choice === "rename") return "rename";
  // 用户关闭/取消弹窗：按 skip 处理，避免误覆盖
  return "skip";
}

export function topLevelName(relativeName: string): string {
  const normalized = relativeName.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.split("/").filter(Boolean)[0] ?? normalized;
}

/** 按顶层名过滤：skip 策略下剔除与目标冲突的整棵树。 */
export function filterEntriesByConflictSkip<T extends { name: string }>(
  entries: T[],
  existingNames: Iterable<string>,
): T[] {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames);
  return entries.filter((e) => !existing.has(topLevelName(e.name)));
}
