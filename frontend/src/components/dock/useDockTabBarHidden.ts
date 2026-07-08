import { useLayoutEffect, useRef } from "react";

/** 在 Tab 栏隐藏指定 panel 的标签（panel 仍保持挂载） */
export function useDockTabBarHidden(tabId: string, hidden: boolean) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const tabEl =
      (el.closest(".dv-tab") as HTMLElement | null) ??
      (el
        .closest(".dockable-workspace__dockview")
        ?.querySelector<HTMLElement>(
          `.dv-default-tab[data-dock-tab-id="${CSS.escape(tabId)}"]`,
        )
        ?.closest(".dv-tab") as HTMLElement | null);
    if (!tabEl) return;
    tabEl.classList.toggle("dock-tab--bar-hidden", hidden);
    tabEl.setAttribute("data-tab-id", tabId);
  }, [hidden, tabId]);

  return rootRef;
}
