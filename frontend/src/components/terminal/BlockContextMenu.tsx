import { useCallback, useMemo } from "react";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { useAiStore } from "../../stores/aiStore";
import type { TerminalBlock } from "../../stores/blocksStore";
import { getAiBlockTextForContext, getResolvedAiThread } from "../../modules/terminal/aiThreadBridge";

interface Props {
  block: TerminalBlock;
  position: { x: number; y: number };
  onClose: () => void;
  onRunCommand?: (command: string) => void;
}

export function BlockContextMenu({ block, position, onClose, onRunCommand }: Props) {
  const createConversation = useAiStore((s) => s.createConversation);
  const addMessage = useAiStore((s) => s.addMessage);
  const openDrawer = useAiStore((s) => s.openDrawer);
  const addContext = useAiStore((s) => s.addContext);

  const sendToAI = useCallback(
    (prompt: string) => {
      const convId = createConversation();
      addContext(convId, { type: "terminal", label: "Terminal" });
      addMessage(convId, { role: "user", content: prompt });
      openDrawer();
      onClose();
    },
    [createConversation, addMessage, openDrawer, addContext, onClose],
  );

  const hasError = block.exitCode !== null && block.exitCode !== 0;
  const isAiBlock = block.kind === "ai";
  const aiContext = isAiBlock ? getAiBlockTextForContext(block) : "";
  const hasOutput = isAiBlock ? aiContext.trim().length > 0 : block.output.trim().length > 0;

  const items = useMemo((): ContextMenuItem[] => {
    const menu: ContextMenuItem[] = [
      {
        id: "explain-command",
        label: "解释命令",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </svg>
        ),
        onClick: () =>
          sendToAI(`Explain what this terminal command does:\n\`\`\`\n${block.command}\n\`\`\``),
      },
    ];

    if (isAiBlock) {
      menu.push({
        id: "continue-in-sidebar",
        label: "在侧栏继续",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        ),
        onClick: () => {
          const convId = createConversation();
          addContext(convId, { type: "terminal", label: "终端 AI 卡片" });
          const thread = getResolvedAiThread(block);
          for (const item of thread) {
            if (item.kind === "message") {
              addMessage(convId, {
                role: item.role,
                content: item.content,
              });
            }
          }
          openDrawer();
          onClose();
        },
      });
    }

    if (hasError && hasOutput && !isAiBlock) {
      menu.push(
        {
          id: "explain-error",
          label: "解释错误",
          icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          ),
          onClick: () =>
            sendToAI(
              `Explain this terminal error:\n\nCommand: \`${block.command}\`\nExit code: ${block.exitCode}\n\nOutput:\n\`\`\`\n${block.output.slice(-1000)}\n\`\`\``,
            ),
        },
        {
          id: "fix-error",
          label: "修复错误",
          icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
            </svg>
          ),
          onClick: () =>
            sendToAI(
              `Fix this terminal error. Suggest the correct command:\n\nCommand: \`${block.command}\`\nExit code: ${block.exitCode}\n\nOutput:\n\`\`\`\n${block.output.slice(-1000)}\n\`\`\``,
            ),
        },
      );
    }

    menu.push(
      { id: "sep-ai", separator: true, label: "" },
      {
        id: "send-to-ai",
        label: "发送给 AI",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
            <circle cx="18" cy="14" r="0.5" fill="currentColor" />
            <circle cx="6" cy="14" r="0.5" fill="currentColor" />
            <path d="M12 17v4" />
            <path d="M8 21h8" />
          </svg>
        ),
        onClick: () =>
          sendToAI(
            isAiBlock
              ? `分析以下终端 AI 对话：\n\n${aiContext}`
              : `Analyze this terminal block:\n\nCommand: \`${block.command}\`\n${block.exitCode !== null ? `Exit code: ${block.exitCode}` : "Status: running"}\n${block.cwd ? `Directory: ${block.cwd}` : ""}\n${hasOutput ? `\nOutput:\n\`\`\`\n${(isAiBlock ? aiContext : block.output).slice(-1500)}\n\`\`\`` : ""}`,
          ),
      },
    );

    if (block.command) {
      menu.push(
        { id: "sep-run", separator: true, label: "" },
        {
          id: "run-again",
          label: "重新执行",
          icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 17l6-6-6-6" />
              <path d="M12 19h8" />
            </svg>
          ),
          onClick: () => {
            onRunCommand?.(block.command);
            onClose();
          },
        },
      );
    }

    menu.push({
      id: "copy-command",
      label: "复制命令",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      ),
      onClick: () => {
        void navigator.clipboard.writeText(block.command);
        onClose();
      },
    });

    return menu;
  }, [block, hasError, hasOutput, isAiBlock, aiContext, onClose, onRunCommand, sendToAI]);

  return (
    <ContextMenu
      items={items}
      position={position}
      onClose={onClose}
      className="context-menu--wide"
    />
  );
}
