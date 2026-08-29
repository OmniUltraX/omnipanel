import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { t } from "../i18n";
import { appConfirm } from "./appConfirm";
import { appPrompt } from "./appPrompt";
import { showToast } from "../stores/toastStore";
import { useSettingsStore } from "../stores/settingsStore";

export type StepUpRequest = {
  action: string;
  target: string;
  title: string;
  message: string;
  reason: string;
  confirmLabel?: string;
};

/**
 * 统一 step-up：说明影响 → 系统验证或打字证明 → token。
 * 取消或失败返回 null，不抛给调用方（已 toast 输错）。
 */
export async function requireStepUp(request: StepUpRequest): Promise<string | null> {
  const ok = await appConfirm(request.message, request.title, {
    kind: "warning",
    confirmLabel: request.confirmLabel,
  });
  if (!ok) return null;

  const preferOs = useSettingsStore.getState().osPresenceEnabled !== false;
  let status: { available: boolean; osEnabled: boolean } | null = null;
  try {
    status = await unwrapCommand(commands.presenceStatus());
  } catch {
    status = { available: false, osEnabled: false };
  }

  if (preferOs && status.available && status.osEnabled) {
    try {
      const issued = await unwrapCommand(
        commands.presenceVerify(request.action, request.target, request.reason),
      );
      return issued.token;
    } catch {
      return null;
    }
  }

  const expected =
    request.action === "db.service.restart"
      ? "RESTART"
      : (request.target.split("|").pop() ?? "").trim();
  const typed = await appPrompt(
    t("stepUp.typedPrompt", { token: expected }),
    "",
    t("stepUp.typedTitle"),
  );
  if (typed == null) return null;
  try {
    const issued = await unwrapCommand(
      commands.presenceIssueTyped(request.action, request.target, typed),
    );
    return issued.token;
  } catch {
    showToast(t("stepUp.mismatch"));
    return null;
  }
}
