import { useCallback, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import type { ModuleKey } from "../../lib/paths";
import {
  askAiFromSurface,
  defaultModuleAskPrompt,
} from "../../lib/ai/surfaces";
import { Button } from "../ui/primitives/Button";
import { cn } from "../../lib/utils";
import { showToast } from "../../stores/toastStore";
import { errorToString } from "../../lib/errorToString";

export interface ModuleAskAiButtonProps {
  moduleKey: ModuleKey;
  className?: string;
  /** 覆盖默认引导 prompt */
  prompt?: string;
}

/** 模块侧栏顶栏「问 AI」紧凑按钮 */
export function ModuleAskAiButton({
  moduleKey,
  className,
  prompt,
}: ModuleAskAiButtonProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const key = `ai.surfaces.modulePrompt.${moduleKey}`;
      const translated = t(key);
      const text =
        prompt?.trim() ||
        (translated === key ? defaultModuleAskPrompt(moduleKey) : translated);
      await askAiFromSurface({
        prompt: text,
        surface: "module",
        moduleKey,
        newConversation: true,
      });
    } catch (e) {
      showToast(errorToString(e));
    } finally {
      setBusy(false);
    }
  }, [busy, moduleKey, prompt, t]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("module-ask-ai-btn window-drag-surface--interactive", className)}
      title={t("ai.surfaces.askAi")}
      aria-label={t("ai.surfaces.askAi")}
      disabled={busy}
      onClick={() => void onClick()}
    >
      <SparklesIcon className="h-3.5 w-3.5" />
      <span className="module-ask-ai-btn__label">{t("ai.surfaces.askAi")}</span>
    </Button>
  );
}
