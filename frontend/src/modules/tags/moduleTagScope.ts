import { DOCKER_LOCAL_CONNECTION_ID } from "../docker/constants";
import { LOCAL_CONNECTION_ID } from "../files/utils";
import { KNOWLEDGE_TAG_KINDS, PROTOCOL_TAG_KINDS } from "./tagKinds";

/**
 * 模块筛选弹窗的标签作用域：只展示该模块资源上已用过的标签。
 * 资源编辑（GlobalTagEditor）不受此限制，始终全局。
 */
export interface ModuleTagFilterScope {
  resourceKinds?: string[];
  connectionKinds?: string[];
  extraResourceIds?: string[];
}

/** 连接类模块的通用 resource_kind */
const CONNECTION = ["connection"] as const;

/**
 * 有配置则筛选面板按范围裁剪；无配置则展示全局标签树。
 * key 与各模块 `tagModuleKey` 对齐。
 */
export const MODULE_TAG_FILTER_SCOPE: Record<string, ModuleTagFilterScope> = {
  terminal: {
    resourceKinds: [...CONNECTION],
    connectionKinds: ["ssh"],
    extraResourceIds: ["local-terminal"],
  },
  ssh: {
    resourceKinds: [...CONNECTION],
    connectionKinds: ["ssh"],
  },
  database: {
    resourceKinds: [...CONNECTION],
    connectionKinds: ["database"],
  },
  docker: {
    resourceKinds: [...CONNECTION],
    connectionKinds: ["docker"],
    extraResourceIds: [DOCKER_LOCAL_CONNECTION_ID],
  },
  files: {
    resourceKinds: [...CONNECTION],
    connectionKinds: ["file"],
    extraResourceIds: [LOCAL_CONNECTION_ID],
  },
  server: {
    resourceKinds: [...CONNECTION],
    connectionKinds: ["panel"],
  },
  knowledge: {
    resourceKinds: [...KNOWLEDGE_TAG_KINDS],
  },
  protocol: {
    resourceKinds: [...PROTOCOL_TAG_KINDS],
  },
};
