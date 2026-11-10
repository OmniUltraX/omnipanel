import type { LocalShellSpec } from "../stores/terminalTypes";

export function localShellPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? navigator.platform ?? "";
}

/** Labels are presentation, not an explicit shell selection. Legacy Windows
 * defaults must never become a Windows-only executable on Linux/macOS. */
export function resolveLocalTerminalShell(
  spec: LocalShellSpec | null | undefined,
  label: string | null | undefined,
  platform = localShellPlatform(),
): LocalShellSpec | null {
  const windows = /^win/i.test(platform);
  if (spec) {
    if (!windows && ["powershell5", "cmd", "wsl"].includes(spec.kind)) return null;
    return spec.kind === "cmd"
      ? { kind: "powershell5", path: null, wslDistro: null }
      : spec;
  }
  const text = (label ?? "").toLowerCase();
  if (/\bwsl\b/.test(text)) {
    if (!windows) return null;
    return { kind: "wsl", path: null, wslDistro: label?.match(/^([^(]+)/)?.[1].trim() ?? null };
  }
  if (text.includes("pwsh") || text.includes("powershell 7") || text.includes("powershell core")) {
    return { kind: "powershell", path: null, wslDistro: null };
  }
  if (windows && (text.includes("powershell") || text === "cmd" || text === "cmd.exe" || text.includes("命令提示符"))) {
    return { kind: "powershell5", path: null, wslDistro: null };
  }
  // null deliberately delegates default detection to the native backend ($SHELL
  // or /bin/bash on Unix), including fresh UI sessions and legacy "PowerShell" labels.
  return null;
}

export function normalizeLegacyLocalShellLabel(label: string, spec: LocalShellSpec | null): string {
  return !spec && !/^win/i.test(localShellPlatform()) && label === "PowerShell" ? "Shell" : label;
}
