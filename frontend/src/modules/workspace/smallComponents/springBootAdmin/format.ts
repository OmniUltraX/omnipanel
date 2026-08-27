/** JVM 内存字节，对齐 SBA 的 MB / GB 展示 */
export function formatJvmBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    const digits = gb >= 10 ? 1 : 2;
    return `${trimFloat(gb.toFixed(digits))} GB`;
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${Math.round(bytes)} B`;
}

function trimFloat(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatThreadCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

/** 坐标轴上限：取数据最大值（及可选 floor，如 heap max）再向上取整到 1×10^n */
export function niceAxisMax(values: number[], floor?: number | null): number {
  const nums = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (floor != null && Number.isFinite(floor) && floor > 0) {
    nums.push(floor);
  }
  const max = nums.length === 0 ? 0 : Math.max(...nums);
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / exp) * exp;
}
