import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { buildHarnessInventory } from "../../lib/ai/harness";
import { HARNESS_WRITE_ENTRIES } from "../../lib/ai/harness/writeEntries";
import { useAiStore } from "../../stores/aiStore";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";

/** 设置页：Harness 只读清单（当前侧栏会话） */
export function HarnessInventoryPanel() {
  const { t } = useI18n();
  const activeId = useAiStore((s) => s.activeConversationId);
  const plans = useAiOrchestrationStore((s) => s.plans);
  const clusters = useAiOrchestrationStore((s) => s.clusters);

  const inventory = useMemo(
    () => buildHarnessInventory(activeId),
    // plans/clusters 变更时重算
    [activeId, plans, clusters],
  );

  return (
    <div className="settings-subsection harness-inventory-panel">
      <p className="setting-hint settings-subsection-desc">
        {t("settings.agent.harness.desc")}
      </p>
      <dl className="harness-inventory-dl">
        <div>
          <dt>{t("settings.agent.harness.conversation")}</dt>
          <dd>
            <code>{inventory.conversationId ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>{t("settings.agent.harness.agent")}</dt>
          <dd>{inventory.agentId ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("settings.agent.harness.toolsMode")}</dt>
          <dd>
            <code>{inventory.toolsModeSummary}</code>
            <div className="setting-hint">{inventory.toolFamilySummary}</div>
          </dd>
        </div>
        <div>
          <dt>{t("settings.agent.harness.skills")}</dt>
          <dd>
            {inventory.skillIds.length > 0
              ? inventory.skillIds.join(", ")
              : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("settings.agent.harness.activePlans")}</dt>
          <dd>
            {inventory.activePlans.length === 0
              ? "—"
              : inventory.activePlans.map((p) => (
                  <div key={p.planId}>
                    {p.title} · {p.status} · {p.doneSteps}/{p.totalSteps}
                  </div>
                ))}
          </dd>
        </div>
        <div>
          <dt>{t("settings.agent.harness.activeClusters")}</dt>
          <dd>
            {inventory.activeClusters.length === 0
              ? "—"
              : inventory.activeClusters.map((c) => (
                  <div key={c.clusterId}>
                    {c.title} · {c.status} · {c.completedChildren}/
                    {c.childCount}
                  </div>
                ))}
          </dd>
        </div>
      </dl>
      <details className="harness-inventory-entries">
        <summary>{t("settings.agent.harness.writeEntries")}</summary>
        <ul>
          {HARNESS_WRITE_ENTRIES.map((e) => (
            <li key={e.id}>
              <strong>{e.id}</strong> — {e.role}
              <br />
              <code>{e.path}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
