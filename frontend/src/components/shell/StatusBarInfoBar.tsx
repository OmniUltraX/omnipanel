import { useStatusBarInfoBarRegistryRev, getStatusBarInfoBarContent } from "../../hooks/useStatusBarInfoBar";
import { useStatusBarActionBarStore } from "../../stores/statusBarActionBarStore";

/**
 * 状态栏右侧 InfoBar：根据当前激活的 dock panel 展示对应面板的独有信息。
 * 各面板通过 `useStatusBarInfoBar(panelId, () => ...)` 注册内容。
 */
export function StatusBarInfoBar() {
  const activePanelId = useStatusBarActionBarStore(
    (state) => state.activeDock?.panelId ?? null,
  );
  useStatusBarInfoBarRegistryRev();

  const content = getStatusBarInfoBarContent(activePanelId);
  if (!content) return null;

  return (
    <div className="statusbar-info-bar" data-panel-id={activePanelId ?? undefined}>
      {content}
    </div>
  );
}
