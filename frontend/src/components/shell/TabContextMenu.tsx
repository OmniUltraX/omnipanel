import { useI18n } from "../../i18n";

interface TabContextMenuProps {
  x: number;
  y: number;
  tabCount: number;
  tabIndex: number;
  onClose: (action: "close" | "closeLeft" | "closeRight" | "closeOthers" | "closeAll") => void;
  onDismiss: () => void;
}

export function TabContextMenu({ x, y, tabCount, tabIndex, onClose, onDismiss }: TabContextMenuProps) {
  const { t } = useI18n();

  return (
    <>
      <div className="fixed inset-0 z-[90]" onClick={onDismiss} onContextMenu={(e) => { e.preventDefault(); onDismiss(); }} />
      <div className="tab-context-menu" style={{ left: x, top: y }}>
        <button className="tab-context-menu-item" onClick={() => onClose("close")}>
          {t("shell.topbar.closeCurrent")}
        </button>
        <div className="tab-context-menu-sep" />
        <button className="tab-context-menu-item" disabled={tabIndex <= 0} onClick={() => onClose("closeLeft")}>
          {t("shell.topbar.closeLeft")}
        </button>
        <button className="tab-context-menu-item" disabled={tabIndex >= tabCount - 1} onClick={() => onClose("closeRight")}>
          {t("shell.topbar.closeRight")}
        </button>
        <div className="tab-context-menu-sep" />
        <button className="tab-context-menu-item" disabled={tabCount <= 1} onClick={() => onClose("closeOthers")}>
          {t("shell.topbar.closeOthers")}
        </button>
        <button className="tab-context-menu-item" disabled={tabCount <= 0} onClick={() => onClose("closeAll")}>
          {t("shell.topbar.closeAll")}
        </button>
      </div>
    </>
  );
}
