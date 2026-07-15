import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "../primitives/Button";
import { useI18n } from "../../../i18n";
import { useCloseBehaviorDialogStore } from "../../../stores/closeBehaviorDialogStore";

/** 关闭窗口：托盘 / 退出；勾选记住后写入设置。 */
export function CloseBehaviorDialogHost() {
  const { t } = useI18n();
  const request = useCloseBehaviorDialogStore((s) => s.request);
  const choose = useCloseBehaviorDialogStore((s) => s.choose);
  const cancel = useCloseBehaviorDialogStore((s) => s.cancel);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (request) setRemember(false);
  }, [request]);

  if (!request) return null;

  return (
    <Modal open onClose={cancel}>
      <div
        className="warn-alert-dialog close-behavior-dialog"
        role="alertdialog"
        aria-labelledby="close-behavior-title"
        aria-describedby="close-behavior-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="warn-alert-header">
          <h3 id="close-behavior-title" className="warn-alert-title">
            {t("shell.closeBehavior.title")}
          </h3>
        </div>
        <div className="warn-alert-body">
          <p id="close-behavior-desc" className="warn-alert-message">
            {t("shell.closeBehavior.message")}
          </p>
          <label className="close-behavior-dialog__remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>{t("shell.closeBehavior.remember")}</span>
          </label>
        </div>
        <div className="warn-alert-footer close-behavior-dialog__footer">
          <Button type="button" variant="secondary" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => choose("tray", remember)}>
            {t("shell.closeBehavior.toTray")}
          </Button>
          <Button type="button" variant="warn" onClick={() => choose("quit", remember)}>
            {t("shell.closeBehavior.quit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
