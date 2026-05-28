import { useAiStore } from "../../stores/aiStore";
import { useActionStore } from "../../stores/actionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { workspaceResources, getResourceById, type EnvironmentTag } from "../../lib/resourceRegistry";
import { useI18n } from "../../i18n";

export function StatusBar() {
  const { t } = useI18n();
  const currentModel = useAiStore((s) => s.currentModel);
  const openDrawer = useAiStore((s) => s.openDrawer);
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const actions = useActionStore((s) => s.actions);

  const onlineCount = workspaceResources.filter((r) => ["online", "running"].includes(r.status)).length;
  const blockedCount = actions.filter((a) => a.status === "blocked").length;
  const runningCount = actions.filter((a) => a.status === "running").length;
  const activeResource = getResourceById(activeResourceId);
  const environment = activeResource?.environment ?? "unknown";

  return (
    <div className="statusbar">
      <span className="statusbar-item">
        <span className="statusbar-dot green"></span>
        {t("shell.statusbar.resourcesOnline", { count: onlineCount })}
      </span>
      <span className="statusbar-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <rect x="2" y="7" width="6" height="5" rx="1" />
          <rect x="10" y="7" width="6" height="5" rx="1" />
        </svg>
        {t("shell.statusbar.current", {
          name: activeResource?.name ?? t("shell.statusbar.noResource"),
        })}
      </span>
      <span className="statusbar-item">
        {t("shell.statusbar.environment", { env: t(`env.${environment as EnvironmentTag}`) })}
      </span>
      <span className="statusbar-item">{t("shell.statusbar.runningTasks", { count: runningCount })}</span>
      <span className="statusbar-item">{t("shell.statusbar.pendingConfirm", { count: blockedCount })}</span>
      <span className="statusbar-spacer"></span>
      <button
        className="statusbar-item cursor-pointer hover:text-accent transition-colors"
        onClick={openDrawer}
        title={t("shell.statusbar.openAi")}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
          <path d="M12 17v4" />
          <path d="M8 21h8" />
        </svg>
        AI: {currentModel}
      </button>
      <span className="statusbar-item" style={{ color: "var(--meta)" }}>
        {t("shell.statusbar.commandPaletteHint")}
      </span>
    </div>
  );
}
