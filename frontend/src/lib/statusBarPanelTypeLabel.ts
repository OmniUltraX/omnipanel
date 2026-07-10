import type { createTranslator } from "../i18n";

type Translator = ReturnType<typeof createTranslator>;

/** 解析状态栏 ActionBar 上展示的面板类型标签（非 Tab 名称） */
export function resolveStatusBarPanelTypeLabel(
  panelType: string | null | undefined,
  t: Translator,
): string {
  const prefix = "shell.statusbar.panelType.";
  if (!panelType) {
    return t("shell.statusbar.panelActions");
  }

  const exactKey = `${prefix}${panelType}`;
  const exact = t(exactKey);
  if (exact !== exactKey) {
    return exact;
  }

  if (panelType.startsWith("protocol-")) {
    const protocol = panelType.slice("protocol-".length);
    const genericKey = `${prefix}protocol`;
    const generic = t(genericKey, { protocol });
    if (generic !== genericKey) {
      return generic;
    }
    return protocol.toUpperCase();
  }

  return panelType;
}
