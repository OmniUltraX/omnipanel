import { useI18n } from "../../i18n";
import { useAppUpdateStore } from "../../stores/appUpdateStore";
import { IconClose } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";
import { WorkbenchActionButton } from "../ui/primitives/WorkbenchActionButton";

/** 版本更新弹窗：展示 changelog，提供立即更新 / 暂时跳过。 */
export function AppUpdateDialog() {
  const { t } = useI18n();
  const dialogOpen = useAppUpdateStore((s) => s.dialogOpen);
  const updateInfo = useAppUpdateStore((s) => s.updateInfo);
  const checking = useAppUpdateStore((s) => s.checking);
  const updating = useAppUpdateStore((s) => s.updating);
  const downloadPercent = useAppUpdateStore((s) => s.downloadPercent);
  const error = useAppUpdateStore((s) => s.error);
  const closeDialog = useAppUpdateStore((s) => s.closeDialog);
  const skipForNow = useAppUpdateStore((s) => s.skipForNow);
  const installNow = useAppUpdateStore((s) => s.installNow);
  const checkOnce = useAppUpdateStore((s) => s.checkOnce);
  const available = Boolean(updateInfo?.available);

  return (
    <Modal open={dialogOpen} onClose={closeDialog}>
      <div
        className="app-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-update-dialog__header">
          <h3 id="app-update-dialog-title">{t("userCenter.update.title")}</h3>
          <button
            type="button"
            className="app-update-dialog__close"
            onClick={closeDialog}
            disabled={updating}
            aria-label={t("shell.topbar.close")}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="app-update-dialog__meta">
          <p>
            {t("settings.update.currentVersion", {
              version: updateInfo?.current_version ?? "—",
            })}
          </p>
          {available ? (
            <p className="app-update-dialog__new">
              {t("settings.update.newVersion", { version: updateInfo!.version })}
            </p>
          ) : null}
          {!available && !checking && updateInfo ? (
            <p className="app-update-dialog__ok">{t("settings.update.upToDate")}</p>
          ) : null}
          {checking ? <p className="muted">{t("settings.update.checking")}</p> : null}
        </div>

        {available && updateInfo?.body ? (
          <div className="app-update-dialog__changelog">
            <h4>{t("settings.update.releaseNotes")}</h4>
            <pre className="app-update-dialog__changelog-body">{updateInfo.body}</pre>
          </div>
        ) : null}

        {error ? <p className="app-update-dialog__error">{error}</p> : null}

        {updating ? (
          <div className="app-update-dialog__progress">
            <div className="update-progress-bar">
              <div
                className="update-progress-fill"
                style={{ width: `${downloadPercent ?? 0}%` }}
              />
            </div>
            <span>
              {downloadPercent != null
                ? t("settings.update.downloadProgress", { percent: downloadPercent })
                : t("settings.update.installing")}
            </span>
          </div>
        ) : null}

        <div className="app-update-dialog__actions">
          {available ? (
            <>
              <WorkbenchActionButton disabled={updating} onClick={skipForNow}>
                {t("userCenter.update.skip")}
              </WorkbenchActionButton>
              <WorkbenchActionButton
                disabled={updating}
                onClick={() => void installNow()}
              >
                {t("userCenter.update.installNow")}
              </WorkbenchActionButton>
            </>
          ) : (
            <>
              <WorkbenchActionButton
                disabled={checking || updating}
                onClick={() => void checkOnce()}
              >
                {checking ? t("settings.update.checking") : t("settings.update.checkBtn")}
              </WorkbenchActionButton>
              <WorkbenchActionButton disabled={updating} onClick={closeDialog}>
                {t("userCenter.update.close")}
              </WorkbenchActionButton>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
