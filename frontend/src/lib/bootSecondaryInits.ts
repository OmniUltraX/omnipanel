/**
 * 启动闪屏进门后的次要初始化：不挡 UI，进度进左下角后台任务。
 */
import { runLocalBackgroundTask } from "./localBackgroundTask";
import { initAiModelsStore } from "../stores/aiModelsStore";
import { initDbSqlFilesStore } from "../stores/dbSqlFileStore";
import { initDbTreeChartFilesStore } from "../stores/dbTreeChartFileStore";
import { initAgentSourcesStore } from "../stores/agentSourcesStore";
import { initBuiltinToolStore } from "../stores/builtinToolStore";

export type BootSecondaryLabels = {
  title: string;
  tools: string;
  aiModels: string;
  sqlFiles: string;
  treeCharts: string;
  agents: string;
  dbSchema: string;
  parallel: string;
  done: string;
  failed: string;
};

const BOOT_SECONDARY_TASK_ID = "boot-secondary-init";

/** 启动后后台跑 AI / Agent / SQL / 工具等；失败只打日志，不抛到调用方。 */
export function startBootSecondaryInits(labels: BootSecondaryLabels): void {
  void runLocalBackgroundTask<string>({
    id: BOOT_SECONDARY_TASK_ID,
    module: "system",
    kind: "boot-secondary",
    title: labels.title,
    progress: labels.parallel,
    successProgress: (message) => message,
    failureProgress: labels.failed,
    run: async ({ setProgress }) => {
      const errors: string[] = [];
      const total = 6;
      let completed = 0;

      const track = async (label: string, work: () => Promise<unknown>) => {
        setProgress(`${label} · ${completed}/${total}`);
        try {
          await work();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[boot] ${label}`, e);
          errors.push(msg);
        } finally {
          completed += 1;
          setProgress(`${label} · ${completed}/${total}`);
        }
      };

      await Promise.all([
        track(labels.tools, async () => {
          await initBuiltinToolStore();
          const { registerToolHandlers } = await import("./ai/toolHost");
          registerToolHandlers();
          const { syncGatewayConfig } = await import("./ai/gatewayConfig");
          void syncGatewayConfig();
        }),
        track(labels.aiModels, () => initAiModelsStore()),
        track(labels.sqlFiles, () => initDbSqlFilesStore()),
        track(labels.treeCharts, () => initDbTreeChartFilesStore()),
        track(labels.agents, () => initAgentSourcesStore()),
        track(labels.dbSchema, () =>
          import("../modules/database/schema/initDbSchemaUiStores").then((m) =>
            m.initDbSchemaUiStores(),
          ),
        ),
      ]);

      if (errors.length > 0) {
        return `${labels.done}（${errors.length} 项告警）`;
      }
      return labels.done;
    },
  }).catch((e) => {
    console.warn("[boot] secondary init task failed", e);
  });
}
