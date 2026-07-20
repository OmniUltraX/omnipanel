import { IconQuote } from "../../components/ui/icons/Icons";
import { useI18n } from "../../i18n";
import type { TerminalBlock } from "../../stores/blocksStore";
import { showToast } from "../../stores/toastStore";
import { promoteTerminalInlineToDock } from "../../lib/ai/promoteInlineThread";
import { attachBlockToAiInput } from "./terminalBlockAiAttach";
import { scrollTerminalBlockIntoView } from "./scrollTerminalBlockIntoView";

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

  const handleAttach = () => {
    const result = attachBlockToAiInput(sessionId, block, onFocusInput);
    if (result === "empty") {
      showToast(t("terminal.command.attachEmpty"));
      return;
    }
    if (result === "duplicate") {
      scrollTerminalBlockIntoView(sessionId, block.id);
      onFocusInput?.();
      showToast(t("terminal.command.attachDuplicate"));
      return;
    }
    showToast(t("terminal.command.attachSuccess"));
  };

  const handlePromote = () => {
    const id = promoteTerminalInlineToDock({ sessionId, blockId: block.id });
    if (id) {
      showToast(t("ai.promote.done"));
    }
  };

  const isAi = block.kind === "ai";

  return (
    <button
      type="button"
      className={className}
      title={isAi ? t("ai.promote.toDock") : t("terminal.command.attachToAi")}
      aria-label={isAi ? t("ai.promote.toDock") : t("terminal.command.attachToAi")}
      onClick={(e) => {
        e.stopPropagation();
        if (isAi) handlePromote();
        else handleAttach();
      }}
    >
      <IconQuote size={14} />
    </button>
  );
}
