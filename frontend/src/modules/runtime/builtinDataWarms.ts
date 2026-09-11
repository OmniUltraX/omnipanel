import { registerModuleDataWarm } from "../../lib/moduleDataWarm";

let builtinsRegistered = false;

/**
 * 内建模块数据静默预热注册（幂等）。
 * 仅含本地安全项（见 moduleDataWarm 安全合同）：schema 快照/树状态/过滤器/
 * 连接布局（database）与任务历史（tasks）。live 网络拉取（docker 引擎、
 * SSH/DB/云/SFTP、监控轮询）一律不进后台，由各模块 live 侧负责。
 * 回调内动态 import，避免把 store 图提前拉进主 chunk。
 */
export function ensureBuiltinDataWarmsRegistered(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;

  registerModuleDataWarm("database", async () => {
    const [
      { useDbSchemaCacheStore },
      { useDbSchemaFilterStore },
      { useDbSchemaTreeExpandedStore },
      { useDbSchemaConnectionLayoutStore },
    ] = await Promise.all([
      import("../../stores/dbSchemaCacheStore"),
      import("../../stores/dbSchemaFilterStore"),
      import("../../stores/dbSchemaTreeExpandedStore"),
      import("../../stores/dbSchemaConnectionLayoutStore"),
    ]);
    useDbSchemaConnectionLayoutStore.getState().hydrate();
    await Promise.all([
      useDbSchemaCacheStore.getState().hydrate(),
      useDbSchemaFilterStore.getState().hydrate(),
      useDbSchemaTreeExpandedStore.getState().hydrate(),
    ]);
  });

  registerModuleDataWarm("tasks", async () => {
    const { useBgTaskHistoryStore } = await import("../../stores/bgTaskHistoryStore");
    await useBgTaskHistoryStore.getState().hydrateFromBackend();
  });
}

/** 仅测试：重置注册标志（需配合 resetModuleDataWarmForTests）。 */
export function resetBuiltinDataWarmsRegistrationForTests(): void {
  builtinsRegistered = false;
}
