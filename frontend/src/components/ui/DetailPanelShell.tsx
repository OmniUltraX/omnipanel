import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button } from "./Button";
import { SubWindow } from "./SubWindow";

export type DetailPanelVariant = "drawer" | "docker-drawer";

export interface DetailPanelShellProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  floatingTitle: string;
  children: ReactNode;
  variant?: DetailPanelVariant;
  drawerClassName?: string;
  widthRatio?: number;
  heightRatio?: number;
  /** 浮动 SubWindow 标题栏附加控件（抽屉模式请放在子内容 header 内） */
  floatingHeaderExtra?: ReactNode;
}

function PopoutIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="2" y="2" width="9" height="9" rx="1" />
      <path d="M5 11v2.5A1.5 1.5 0 0 0 6.5 15H12a1 1 0 0 0 1-1V8.5A1.5 1.5 0 0 0 11.5 7H11" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M11 2v12" />
    </svg>
  );
}

const DetailPanelShellContext = createContext({ showInlineModeToggle: true });

/** 全局详情面板模式切换（右侧抽屉 ↔ 浮动窗口），偏好持久化于 settingsStore。 */
export function DetailPanelModeToggle({ placement = "inline" }: { placement?: "inline" | "header" }) {
  const { t } = useI18n();
  const { showInlineModeToggle } = useContext(DetailPanelShellContext);
  const mode = useSettingsStore((s) => s.detailPanelMode);
  const setDetailPanelMode = useSettingsStore((s) => s.setDetailPanelMode);

  if (placement === "inline" && !showInlineModeToggle) return null;

  const label =
    mode === "drawer"
      ? t("shell.detailPanel.modeFloating")
      : t("shell.detailPanel.modeDrawer");

  return (
    <Button
      variant="icon"
      title={label}
      aria-label={label}
      onClick={() => setDetailPanelMode(mode === "drawer" ? "floating" : "drawer")}
    >
      {mode === "drawer" ? <PopoutIcon /> : <DockIcon />}
    </Button>
  );
}

function resolveDrawerClass(
  variant: DetailPanelVariant,
  drawerClassName: string | undefined,
  opts: { floating: boolean; entered: boolean },
) {
  const showClass = opts.floating || opts.entered;
  if (variant === "drawer") {
    const base = showClass ? "drawer show" : "drawer";
    return drawerClassName ? `${base} ${drawerClassName}` : base;
  }
  const base = showClass ? "docker-drawer show" : "docker-drawer";
  return drawerClassName ? `${base} ${drawerClassName}` : base;
}

/** 与 global.css 中 drawer / docker-drawer 的 transition 时长一致 */
const DRAWER_ANIMATION_MS = 300;

/**
 * 详情面板壳层：根据全局配置在「右侧抽屉」与「浮动 SubWindow」间切换。
 * 子内容在各模块内定义；头部请自行放入 DetailPanelModeToggle 与关闭按钮。
 */
export function DetailPanelShell({
  open,
  onClose,
  ariaLabel,
  floatingTitle,
  children,
  variant = "docker-drawer",
  drawerClassName,
  widthRatio = 0.55,
  heightRatio = 0.85,
  floatingHeaderExtra,
}: DetailPanelShellProps) {
  const mode = useSettingsStore((s) => s.detailPanelMode);
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const contentRef = useRef(children);

  if (open || mounted) {
    contentRef.current = children;
  }

  useEffect(() => {
    if (mode === "floating") {
      setMounted(open);
      setEntered(open);
      return;
    }

    if (open) {
      setMounted(true);
      let enterFrame = 0;
      const primingFrame = requestAnimationFrame(() => {
        enterFrame = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(primingFrame);
        cancelAnimationFrame(enterFrame);
      };
    }

    setEntered(false);
    const exitTimer = window.setTimeout(() => setMounted(false), DRAWER_ANIMATION_MS);
    return () => clearTimeout(exitTimer);
  }, [open, mode]);

  if (mode === "floating") {
    if (!open) return null;

    return (
      <DetailPanelShellContext.Provider value={{ showInlineModeToggle: false }}>
        <SubWindow
          open
          title={floatingTitle}
          onClose={onClose}
          widthRatio={widthRatio}
          heightRatio={heightRatio}
          headerExtra={
            <>
              {floatingHeaderExtra}
              <DetailPanelModeToggle placement="header" />
            </>
          }
          className="detail-panel-subwindow"
        >
          <div
            className={`detail-panel-floating-inner ${resolveDrawerClass(variant, drawerClassName, { floating: true, entered: true })}`}
          >
            {children}
          </div>
        </SubWindow>
      </DetailPanelShellContext.Provider>
    );
  }

  if (!mounted) return null;

  const panelContent = contentRef.current;

  return createPortal(
    <DetailPanelShellContext.Provider value={{ showInlineModeToggle: true }}>
      <>
        <div
          className={`drawer-overlay${entered ? " show" : ""}`}
          onClick={onClose}
          aria-hidden="false"
        />
        <aside
          className={resolveDrawerClass(variant, drawerClassName, { floating: false, entered })}
          role="dialog"
          aria-label={ariaLabel}
          onClick={(e) => e.stopPropagation()}
        >
          {panelContent}
        </aside>
      </>
    </DetailPanelShellContext.Provider>,
    document.body,
  );
}
