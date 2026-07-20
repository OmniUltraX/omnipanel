import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { collectAllModuleAiContextText, useAiContextRegistry } from "../../lib/ai/context";
import { useAiStore } from "../../stores/aiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

/**
 * Dock 现场摘要：仅展示上下文芯片（跟随等操作已聚合到上方工具栏）。
 */
export function AiContextStrip() {
  const { t } = useI18n();
  const revision = useAiContextRegistry((s) => s.revision);
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
    const text = collectAllModuleAiContextText(["module:terminal"]) ?? "";
    const terminalText = collectAllModuleAiContextText([]) ?? "";
    const out: { key: string; label: string }[] = [];
    const sections = `${text}\n\n${terminalText}`.split(/\n---\n|\n## /);
    for (const section of sections) {
      const title = section.match(/^(Docker|数据库|文件|SSH|终端)[^\n]*/)?.[0];
      if (!title) continue;
      const conn =
        section.match(/连接名称[：:]\s*(.+)/)?.[1]?.trim() ||
        section.match(/连接 ID[：:]\s*(.+)/)?.[1]?.trim();
      const extra =
        section.match(/当前数据库[：:]\s*(.+)/)?.[1]?.trim() ||
        section.match(/容器名称[：:]\s*(.+)/)?.[1]?.trim() ||
        section.match(/当前路径[：:]\s*(.+)/)?.[1]?.trim() ||
        section.match(/主机[：:]\s*(.+)/)?.[1]?.trim();
      const label = [title.replace(/^#+ /, ""), conn, extra].filter(Boolean).join(" · ");
      if (label && !out.some((c) => c.label === label)) {
        out.push({ key: label, label });
      }
    }
    return out.slice(0, 6);
  }, [revision]);

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
