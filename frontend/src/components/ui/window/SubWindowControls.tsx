import { useI18n } from "../../../i18n";
import { usesMacTrafficLights } from "../../../lib/platform";

interface SubWindowControlsProps {
  isMaximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  /** 当提供时，最大化按钮改为切换到全屏工作区模式 */
  onMaximizeToWorkspace?: () => void;
}

function TrafficLightIcon({ kind }: { kind: "close" | "minimize" | "zoom" }) {
  if (kind === "close") {
    return (
      <svg className="win-btn__glyph" width="6" height="6" viewBox="0 0 6 6" fill="none" aria-hidden>
        <path d="M1 1l4 4M5 1L1 5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "minimize") {
    return (
      <svg className="win-btn__glyph" width="6" height="6" viewBox="0 0 6 6" fill="none" aria-hidden>
        <path d="M1 3h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="win-btn__glyph" width="6" height="6" viewBox="0 0 6 6" fill="none" aria-hidden>
      <path
        d="M2.2 1.2H4.8V3.8M3.8 2.2H1.2V4.8"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** SubWindow 内嵌窗口控制（最小化 / 最大化 / 关闭） */
export function SubWindowControls({
  isMaximized,
  onMinimize,
  onToggleMaximize,
  onClose,
  onMaximizeToWorkspace,
}: SubWindowControlsProps) {
  const { t } = useI18n();
  const mac = usesMacTrafficLights();

  const handleMaximize = onMaximizeToWorkspace ?? onToggleMaximize;
  // 当 onMaximizeToWorkspace 存在时始终显示「最大化」图标（不会处于已最大化状态）
  const showRestoreIcon = !onMaximizeToWorkspace && isMaximized;

  const closeBtn = (
    <button
      type="button"
      className="win-btn close"
      title={t("shell.topbar.close")}
      aria-label={t("shell.topbar.close")}
      onClick={onClose}
    >
      {mac ? (
        <TrafficLightIcon kind="close" />
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );

  const minimizeBtn = (
    <button
      type="button"
      className="win-btn minimize"
      title={t("shell.topbar.minimize")}
      aria-label={t("shell.topbar.minimize")}
      onClick={onMinimize}
    >
      {mac ? (
        <TrafficLightIcon kind="minimize" />
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );

  const maximizeBtn = (
    <button
      type="button"
      className="win-btn maximize"
      title={showRestoreIcon ? t("shell.topbar.restore") : t("shell.topbar.maximize")}
      aria-label={showRestoreIcon ? t("shell.topbar.restore") : t("shell.topbar.maximize")}
      onClick={handleMaximize}
    >
      {mac ? (
        <TrafficLightIcon kind="zoom" />
      ) : showRestoreIcon ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <rect x="0.5" y="0.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="4" y="4" width="5.5" height="5.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );

  return (
    <div
      className={`win-controls subwindow-win-controls${mac ? " win-controls--mac" : " win-controls--windows"}`}
    >
      {mac ? (
        <>
          {closeBtn}
          {minimizeBtn}
          {maximizeBtn}
        </>
      ) : (
        <>
          {minimizeBtn}
          {maximizeBtn}
          {closeBtn}
        </>
      )}
    </div>
  );
}
