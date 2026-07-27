import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useActionDraftStore } from "../../stores/actionDraftStore";
import { filterAiDockDrafts } from "../../lib/ai/approvalSurface";
import { ApprovalActionBar } from "./ApprovalActionBar";
import { useAiStore } from "../../stores/aiStore";
import { useTerminalStore } from "../../stores/terminalStore";

/** AI 侧栏内嵌审批条：交互对齐终端 ToolCallBar */
export function AiApprovalDock() {
  const drafts = useActionDraftStore((s) => s.drafts);
  const focusId = useActionDraftStore((s) => s.focusId);
  const setFocusId = useActionDraftStore((s) => s.setFocusId);
  const focusNext = useActionDraftStore((s) => s.focusNext);
  // 订阅可见性依赖，确保路由/侧栏/终端 tab 变化时重新过滤
  useAiStore((s) => s.drawerOpen);
  useTerminalStore((s) => s.activeTabId);
  const locationPath = useLocation().pathname;

  const visible = useMemo(
    () => filterAiDockDrafts(drafts),
    [drafts, locationPath],
  );

  const current = useMemo(() => {
    if (visible.length === 0) return null;
    return visible.find((d) => d.id === focusId) ?? visible[0];
  }, [visible, focusId]);

  useEffect(() => {
    if (current && focusId !== current.id) {
      setFocusId(current.id);
    }
  }, [current, focusId, setFocusId]);

  if (!current) return null;

  const moreCount = Math.max(0, visible.length - 1);

  return (
    <div className="ai-approval-dock">
      <ApprovalActionBar
        draft={current}
        variant="dock"
        showMoreHint={moreCount > 0}
        moreCount={moreCount}
        onFocusNext={() => focusNext(current.id)}
      />
    </div>
  );
}
