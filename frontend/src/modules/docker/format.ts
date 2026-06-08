/** 后端混用秒 / 毫秒，统一格式化为本地时间 */
export function formatDockerTime(value: number | null | undefined): string {
  if (!value) return "-";
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleString();
}
