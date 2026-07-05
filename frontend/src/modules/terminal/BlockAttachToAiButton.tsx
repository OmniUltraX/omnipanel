import { IconQuote } from "../../components/ui/icons/Icons";
import { useI18n } from "../../i18n";
import type { TerminalBlock } from "../../stores/blocksStore";
import { showToast } from "../../stores/toastStore";
import { attachBlockToAiInput } from "./terminalBlockAiAttach";

type BlockAttachToAiButtonProps = {
  block: TerminalBlock;
  sessionId: string;
  onFocusInput?: () => void;
  className?: string;
};

export function BlockAttachToAiButton({
  block,
  sessionId,
  onFocusInput,
  className = "term-warp-block__toolbar-btn",
}: BlockAttachToAiButtonProps) {
  const { t } = useI18n();

  const handleClick = () => {
    const result = attachBlockToAiInput(sessionId, block, onFocusInput);
    if (result === "empty") {
      showToast(t("terminal.command.attachEmpty"));
      return;
    }
    if (result === "duplicate") {
      showToast(t("terminal.command.attachDuplicate"));
      return;
    }
    showToast(t("terminal.command.attachSuccess"));
  };

  return (
    <button
      type="button"
      className={className}
      title={t("terminal.command.attachToAi")}
      aria-label={t("terminal.command.attachToAi")}
      onClick={handleClick}
    >
      <IconQuote size={14} />
    </button>
  );
}
