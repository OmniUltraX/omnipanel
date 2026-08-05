import { WarnAlert } from "./WarnAlert";
import { useAppDialogStore } from "../../../stores/appDialogStore";
import { useI18n } from "../../../i18n";

/** 全局 confirm / alert / choose 宿主；`App.tsx` 根节点必须挂载，勿移除*/
export function AppDialogHost() {
  const { t } = useI18n();
  const request = useAppDialogStore((state) => state.request);
  const confirm = useAppDialogStore((state) => state.confirm);
  const cancel = useAppDialogStore((state) => state.cancel);
  const choose = useAppDialogStore((state) => state.choose);

  if (!request) {
    return null;
  }

  const isAlert = request.kind === "alert";
  const hasActions = Array.isArray(request.actions) && request.actions.length > 0;

  return (
    <WarnAlert
      open
      title={request.title ?? "OmniPanel"}
      message={request.message}
      alertOnly={isAlert}
      confirmLabel={request.confirmLabel ?? t("common.confirm")}
      cancelLabel={request.cancelLabel ?? t("common.cancel")}
      closeOnConfirm={false}
      onConfirm={confirm}
      onClose={isAlert ? confirm : cancel}
      actions={hasActions ? request.actions : undefined}
      onChoose={hasActions ? (id) => choose(id) : undefined}
    />
  );
}
