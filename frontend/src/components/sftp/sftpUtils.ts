export type SftpEntry = { name: string; isDir: boolean; size: number };

export function formatSftpSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtSftpError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const err = e as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
    if (typeof err.cause === "string") return err.cause;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
