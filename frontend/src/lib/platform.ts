/** macOS / iOS 类平台（修饰键为 ⌘） */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** 使用 macOS 左上角红绿灯窗口控件（无边框自绘标题栏） */
export function usesMacTrafficLights(): boolean {
  return isMacOS();
}

/**
 * 主壳左侧栏是否托管红绿灯。
 * 独立模块窗 / 工作区窗没有 `.app > .sidebar`，改由 dock 前缀区托管。
 */
export function hostsMacTrafficLightsInSidebar(): boolean {
  if (!usesMacTrafficLights() || typeof document === "undefined") return false;
  return Boolean(document.querySelector(".app > aside.sidebar"));
}

/** 当前平台的主修饰键是否按下：macOS 为 Cmd，其它为 Ctrl */
export function isModKeyPressed(e: KeyboardEvent): boolean {
  return isMacOS() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 修饰键展示标签：macOS 为 ⌘，其它为 Ctrl */
export function modKeyLabel(): string {
  return isMacOS() ? "⌘" : "Ctrl";
}

/** 格式化带主修饰键的快捷键，如 L → ⌘L / Ctrl+L */
export function formatModShortcut(key: string): string {
  return isMacOS() ? `${modKeyLabel()}${key}` : `Ctrl+${key}`;
}
