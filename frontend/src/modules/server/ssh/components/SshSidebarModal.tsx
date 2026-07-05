import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../../components/ui/primitives/Button";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  maxWidth?: number;
};

/** SSH 侧栏内弹窗：挂载到 body，避免被侧栏 overflow 裁剪 */
export function SshSidebarModal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 380,
}: Props) {
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-overlay show ssh-sidebar-modal-overlay" onClick={onClose} />
      <div className="confirm-modal ssh-sidebar-modal" style={{ maxWidth }}>
        <h3>{title}</h3>
        {children}
        <div className="ssh-sidebar-modal__footer">{footer}</div>
      </div>
    </>,
    document.body,
  );
}

type IconBtnProps = {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
};

export function SshSidebarHeaderIconBtn({ title, active, disabled, onClick, children }: IconBtnProps) {
  return (
    <Button
      variant="icon"
      size="icon-xs"
      title={title}
      aria-label={title}
      className={active ? "ssh-sidebar-header-btn--active" : undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Button>
  );
}
