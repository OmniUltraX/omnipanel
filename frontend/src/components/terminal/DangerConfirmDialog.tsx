import type { DangerCheckResult, DangerLevel } from "../../lib/commandGuard";
import { Modal } from "../ui/overlay/Modal";
import { Button } from "../ui/primitives/Button";

interface Props {
  command: string;
  result: DangerCheckResult;
  onConfirm: () => void;
  onCancel: () => void;
}

const LEVEL_STYLES: Record<DangerLevel, { bg: string; border: string; icon: string }> = {
  critical: { bg: "bg-danger/10", border: "border-danger", icon: "!!" },
  high: { bg: "bg-danger/10", border: "border-danger", icon: "!" },
  medium: { bg: "bg-warn/10", border: "border-warn", icon: "!" },
  low: { bg: "bg-surface", border: "border-border", icon: "i" },
};

export function DangerConfirmDialog({ command, result, onConfirm, onCancel }: Props) {
  const style = LEVEL_STYLES[result.level];

  return (
    <Modal open onClose={onCancel}>
      <div className="bg-bg-deeper border border-border rounded-lg shadow-2xl w-[480px] max-w-[90vw]">
        {/* Header */}
        <div className={`flex items-center gap-3 px-4 py-3 border-b border-border rounded-t-lg ${style.bg}`}>
          <div className={`w-8 h-8 rounded-full border-2 ${style.border} flex items-center justify-center text-sm font-bold text-danger`}>
            {style.icon}
          </div>
          <div>
            <div className="text-sm font-medium text-fg">检测到高风险操作</div>
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
          <Button variant="secondary" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            确认执行
          </Button>
        </div>
      </div>
    </Modal>
  );
}
