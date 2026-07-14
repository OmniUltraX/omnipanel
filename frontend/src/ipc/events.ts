/**
 * App Event 名称常量（`listen` / `emit`）。
 *
 * ## Event vs Channel
 * - **App Event**：长生命周期、可跨 remount、一对多订阅（终端输出、日志流、后台任务进度）。
 * - **Channel**：与单次 invoke 请求绑定的回调（镜像 pull 进度、AI stream 等）；不要再发明
 *   `docker-pull-${Date.now()}` 这类字符串事件名作为公共 API——动态名留在调用方局部。
 *
 * 新事件 payload 优先 camelCase。兼容旧字段（如 `session_id`）时在适配层同时读两种。
 */

/** 终端 / Docker exec / 宿主机 shell 输出（payload: session_id + data base64） */
export const TERMINAL_OUTPUT = "terminal-output" as const;

/** 终端会话生命周期（payload: session_id + event，如 exited） */
export const TERMINAL_EVENT = "terminal-event" as const;

/** Docker 容器日志流行（payload: streamId / stream / message） */
export const DOCKER_LOG = "docker-log" as const;

/** Docker 日志流结束（payload: streamId + error?） */
export const DOCKER_LOG_END = "docker-log-end" as const;

/** Docker 容器 stats 流 */
export const DOCKER_STATS = "docker-stats" as const;

/** Docker stats 流结束 */
export const DOCKER_STATS_END = "docker-stats-end" as const;

/** SSH 连接池会话变更 */
export const SSH_POOL_SESSION = "ssh-pool-session" as const;

/** SSH 连接池状态变更 */
export const SSH_POOL_STATUS = "ssh-pool-status" as const;

/** SSH 宿主机系统监控采样 */
export const SSH_SYSTEM_STATS = "ssh-system-stats" as const;

/** 后台任务列表/状态更新 */
export const BG_TASK_UPDATE = "bg-task-update" as const;

/** 数据库同步后台任务细事件 */
export const BG_TASK_DB_EVENT = "bg-task-db-event" as const;

/** Schema 缓存刷新后台事件 */
export const BG_TASK_SCHEMA_CACHE_EVENT = "bg-task-schema-cache-event" as const;

/** MySQL 导出后台事件 */
export const BG_TASK_MYSQL_EXPORT_EVENT = "bg-task-mysql-export-event" as const;

/** 知识库向量化后台事件 */
export const BG_TASK_KNOWLEDGE_EVENT = "bg-task-knowledge-event" as const;

/** 文件索引进度 */
export const FILE_INDEX_PROGRESS = "file-index-progress" as const;

/** 动作执行进度 */
export const ACTION_PROGRESS = "action-progress" as const;

/** 任务输出 / 状态 */
export const TASK_OUTPUT = "task-output" as const;
export const TASK_STATUS = "task-status" as const;

/** 工作流执行完成 */
export const WORKFLOW_EXECUTION_COMPLETE = "workflow-execution-complete" as const;

/** 更新下载相关 */
export const UPDATE_DOWNLOAD_COMPLETE = "update-download-complete" as const;

export type IpcEventName =
  | typeof TERMINAL_OUTPUT
  | typeof TERMINAL_EVENT
  | typeof DOCKER_LOG
  | typeof DOCKER_LOG_END
  | typeof DOCKER_STATS
  | typeof DOCKER_STATS_END
  | typeof SSH_POOL_SESSION
  | typeof SSH_POOL_STATUS
  | typeof SSH_SYSTEM_STATS
  | typeof BG_TASK_UPDATE
  | typeof BG_TASK_DB_EVENT
  | typeof BG_TASK_SCHEMA_CACHE_EVENT
  | typeof BG_TASK_MYSQL_EXPORT_EVENT
  | typeof BG_TASK_KNOWLEDGE_EVENT
  | typeof FILE_INDEX_PROGRESS
  | typeof ACTION_PROGRESS
  | typeof TASK_OUTPUT
  | typeof TASK_STATUS
  | typeof WORKFLOW_EXECUTION_COMPLETE
  | typeof UPDATE_DOWNLOAD_COMPLETE;
