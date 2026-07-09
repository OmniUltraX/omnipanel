/** 冲突详情单元格复制：完整值（不截断） */
export function formatRowDiffCopyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export async function copyRowDiffText(text: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // fallback below
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export function formatConflictCellCopyText(
  sourceVal: unknown,
  targetVal: unknown,
  resolution?: "source" | "target",
): string {
  if (resolution === "source") {
    return formatRowDiffCopyValue(sourceVal);
  }
  if (resolution === "target") {
    return formatRowDiffCopyValue(targetVal);
  }
  return `${formatRowDiffCopyValue(sourceVal)} → ${formatRowDiffCopyValue(targetVal)}`;
}
