/** 托盘隐藏窗口追踪（跨 WebView 共享，整应用共用一个托盘图标）。 */

const RECENT_LABEL_KEY = "omnipanel.tray.recent-hidden-label";
const HIDDEN_LABELS_KEY = "omnipanel.tray.hidden-labels";

function readHiddenLabels(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_LABELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

function writeHiddenLabels(labels: string[]): void {
  localStorage.setItem(HIDDEN_LABELS_KEY, JSON.stringify([...new Set(labels)]));
}

export function markWindowHiddenToTray(label: string): void {
  localStorage.setItem(RECENT_LABEL_KEY, label);
  const next = readHiddenLabels();
  if (!next.includes(label)) next.push(label);
  writeHiddenLabels(next);
}

export function clearWindowHiddenToTray(label: string): void {
  writeHiddenLabels(readHiddenLabels().filter((id) => id !== label));
  if (localStorage.getItem(RECENT_LABEL_KEY) === label) {
    const remaining = readHiddenLabels();
    if (remaining.length > 0) {
      localStorage.setItem(RECENT_LABEL_KEY, remaining[remaining.length - 1]!);
    } else {
      localStorage.removeItem(RECENT_LABEL_KEY);
    }
  }
}

export function getRecentTrayHiddenLabel(): string | null {
  return localStorage.getItem(RECENT_LABEL_KEY);
}

export function getTrayHiddenLabels(): string[] {
  return readHiddenLabels();
}
