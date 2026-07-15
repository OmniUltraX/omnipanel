import { listConnections, type DbConnectionConfig } from "../api";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useDbSchemaTreeExpandedStore } from "../../../stores/dbSchemaTreeExpandedStore";
import { useDbSchemaFilterStore } from "../../../stores/dbSchemaFilterStore";

/** Splash 阶段预取的连接列表，进入模块时可同步首屏渲染 */
let bootstrappedDbConnections: DbConnectionConfig[] | null = null;

export function takeBootstrappedDbConnections(): DbConnectionConfig[] | null {
  return bootstrappedDbConnections;
}

/**
 * 启动期预热数据库侧栏本地状态：Schema 缓存、展开记忆、过滤器、连接列表。
 * 本地缓存只用于渲染树，不代表在线；绿点由 Tab 按需 probe 后设置。
 */
export async function initDbSchemaUiStores(): Promise<void> {
  const [, , , list] = await Promise.all([
    useDbSchemaCacheStore.getState().hydrate(),
    useDbSchemaTreeExpandedStore.getState().hydrate(),
    useDbSchemaFilterStore.getState().hydrate(),
    listConnections().catch(() => [] as DbConnectionConfig[]),
  ]);

  bootstrappedDbConnections = list;
}
