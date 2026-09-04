import type { DangerCheckResult, DangerLevel } from "../../lib/commandGuard";
import { Modal } from "../ui/overlay/Modal";
import { WorkbenchActionButton } from "../ui/primitives/WorkbenchActionButton";

interface Props {
  command: string;
  result: DangerCheckResult;
  onConfirm: () => void;
  onCancel: () => void;
}

const LEVEL_STYLES: Record<DangerLevel, { bg: string; border: string; icon: string; title: string }> = {
  critical: { bg: "bg-danger/10", border: "border-danger", icon: "!!", title: "检测到高风险操作" },
  high: { bg: "bg-danger/10", border: "border-danger", icon: "!", title: "检测到高风险操作" },
  medium: { bg: "bg-warn/10", border: "border-warn", icon: "!", title: "检测到风险操作" },
  low: { bg: "bg-surface", border: "border-border", icon: "i", title: "需要确认后执行" },
};

export function DangerConfirmDialog({ command, result, onConfirm, onCancel }: Props) {
  const style = LEVEL_STYLES[result.level];
  const confirmDanger = result.level !== "low" && result.level !== "medium";

  return (
    <Modal open onClose={onCancel}>
      <div className="bg-bg-deeper border border-border rounded-lg shadow-2xl w-[480px] max-w-[90vw]">
        {/* Header */}
        <div className={`flex items-center gap-3 px-4 py-3 border-b border-border rounded-t-lg ${style.bg}`}>
          <div className={`w-8 h-8 rounded-full border-2 ${style.border} flex items-center justify-center text-sm font-bold text-danger`}>
            {style.icon}
          </div>
          <div>
            <div className="text-sm font-medium text-fg">{style.title}</div>
            <div className="text-xs text-muted capitalize">风险等级：{result.level}</div>
          </div>
        </div>

        {/* Command */}
        <div className="px-4 py-3">
          <div className="text-xs text-meta mb-1">操作内容：</div>
          <pre className="bg-bg rounded-md px-3 py-2 text-sm text-fg font-mono overflow-x-auto break-all">
            {command}
          </pre>
        </div>

        {/* Warnings */}
        <div className="px-4 pb-3 space-y-1">
          {result.matches.map((m, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-danger mt-0.5">*</span>
              <span className="text-fg-2">{m.desc}</span>
              <span className="text-muted capitalize ml-auto shrink-0">[{m.level}]</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <WorkbenchActionButton onClick={onCancel}>
            取消
          </WorkbenchActionButton>
          <WorkbenchActionButton danger={confirmDanger} onClick={onConfirm}>
            确认执行
          </WorkbenchActionButton>
        </div>
      </div>
    </Modal>
  );
}
