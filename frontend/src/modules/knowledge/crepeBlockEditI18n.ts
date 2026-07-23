import { CrepeFeature } from "@milkdown/crepe";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 斜杠菜单与代码块面板的 Crepe 文案配置（随应用语言切换）。 */
export function buildCrepeFeatureConfigs(t: TranslateFn) {
  return {
    [CrepeFeature.BlockEdit]: {
      textGroup: {
        label: t("knowledge.docEditor.slash.groups.text"),
        text: { label: t("knowledge.docEditor.slash.items.text") },
        h1: { label: t("knowledge.docEditor.slash.items.h1") },
        h2: { label: t("knowledge.docEditor.slash.items.h2") },
        h3: { label: t("knowledge.docEditor.slash.items.h3") },
        h4: { label: t("knowledge.docEditor.slash.items.h4") },
        h5: { label: t("knowledge.docEditor.slash.items.h5") },
        h6: { label: t("knowledge.docEditor.slash.items.h6") },
        quote: { label: t("knowledge.docEditor.slash.items.quote") },
        divider: { label: t("knowledge.docEditor.slash.items.divider") },
      },
      listGroup: {
        label: t("knowledge.docEditor.slash.groups.list"),
        bulletList: { label: t("knowledge.docEditor.slash.items.bulletList") },
        orderedList: { label: t("knowledge.docEditor.slash.items.orderedList") },
        taskList: { label: t("knowledge.docEditor.slash.items.taskList") },
      },
      advancedGroup: {
        label: t("knowledge.docEditor.slash.groups.advanced"),
        image: { label: t("knowledge.docEditor.slash.items.image") },
        codeBlock: { label: t("knowledge.docEditor.slash.items.codeBlock") },
        table: { label: t("knowledge.docEditor.slash.items.table") },
        // Latex 特性已关闭，隐藏公式入口避免插入后无法渲染
        math: null,
      },
    },
    [CrepeFeature.CodeMirror]: {
      searchPlaceholder: t("knowledge.docEditor.codeBlock.searchLanguage"),
      noResultText: t("knowledge.docEditor.codeBlock.noResult"),
      copyText: t("knowledge.docEditor.codeBlock.copy"),
      previewToggleText: (previewOnlyMode: boolean) =>
        previewOnlyMode
          ? t("knowledge.docEditor.codeBlock.edit")
          : t("knowledge.docEditor.codeBlock.hide"),
    },
  };
}
