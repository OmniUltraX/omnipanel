import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { getModuleAiContextText, useAiContextRegistry } from "../../lib/ai/context";
import { parseModuleContextChipLabel } from "../../lib/ai/parseModuleContextChip";
import { resolveFocusModuleKey } from "../../lib/ai/resolveFocusModuleKey";
import { resolveResourceById } from "../../stores/connectionStore";
import { useAiStore } from "../../stores/aiStore";
import { useStatusBarActionBarStore } from "../../stores/statusBarActionBarStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

/**
 * Dock 现场摘要：仅展示与当前焦点模块相关的自动上下文（含钉住工作区）。
 */
export function AiContextStrip() {
  const { t } = useI18n();
  const revision = useAiContextRegistry((s) => s.revision);
  const activeDock = useStatusBarActionBarStore((s) => s.activeDock);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const conversations = useAiStore((s) => s.conversations);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const pinnedWorkspaceId = activeConv?.pinnedWorkspaceId ?? null;
  const pinnedWorkspace = pinnedWorkspaceId
    ? workspaces.find((w) => w.id === pinnedWorkspaceId)
    : null;

  const chips = useMemo(() => {
    void revision;
    const focusModule = resolveFocusModuleKey(activeDock?.dockScope);
    const out: { key: string; label: string }[] = [];

    if (focusModule === "terminal") {
      const tab = tabs.find((item) => item.id === activeTabId);
      if (tab) {
        const resource = resolveResourceById(tab.session.resourceId);
        const extra =
          tab.session.cwd?.trim() ||
          resource?.name ||
          resource?.subtitle ||
          null;
        const label = ["终端", tab.title, extra].filter(Boolean).join(" · ");
        out.push({ key: `terminal:${tab.id}`, label });
      }
      return out;
    }

    if (focusModule) {
      const text = getModuleAiContextText(focusModule);
      if (text) {
        const label = parseModuleContextChipLabel(text);
        if (label) {
          out.push({ key: `module:${focusModule}`, label });
        }
      }
    }

    return out;
  }, [revision, activeDock?.dockScope, activeTabId, tabs]);

  if (!pinnedWorkspace && chips.length === 0) {
    return (
      <div className="ai-context-strip ai-context-strip--empty">
        <span className="setting-hint">{t("ai.contextStrip.empty")}</span>
      </div>
    );
  }

  return (
    <div className="ai-context-strip">
      <span className="ai-context-strip__label">{t("ai.currentContext")}</span>
      <div className="ai-context-strip__chips">
        {pinnedWorkspace ? (
          <span className="ai-context-chip ai-context-chip--workspace">
            {t("ai.contextStrip.workspace", { name: pinnedWorkspace.name })}
          </span>
        ) : null}
        {chips.map((c) => (
          <span key={c.key} className="ai-context-chip">
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
