import {
  applyDatabaseSidebarTree,
  serializeDatabaseSidebarTree,
} from "../../stores/dbSchemaConnectionLayoutStore";
import {
  applyDockerSidebarTree,
  serializeDockerSidebarTree,
} from "../../stores/dockerSidebarTreeStore";
import {
  applyProtocolHttpLayout,
  serializeProtocolHttpLayout,
} from "../../stores/protocolHttpLayoutStore";

type FolderTreesPayload = {
  docker?: unknown;
  database?: unknown;
  protocol?: unknown;
};

/** 各模块侧栏文件夹布局（SSH 仍走独立的 sshSidebarTreeJson）。 */
export function collectFolderTreesJson(): string {
  return JSON.stringify({
    docker: serializeDockerSidebarTree(),
    database: serializeDatabaseSidebarTree(),
    protocol: serializeProtocolHttpLayout(),
  } satisfies FolderTreesPayload);
}

/**
 * 云端拉取后写入 Docker / 数据库 / 协议侧栏文件夹。
 * merge：旧快照无对应模块时保留本机；replace：切换团队时缺字段则清空。
 */
export function applyFolderTreesJson(
  raw: string | null | undefined,
  mode: "merge" | "replace" = "merge",
): void {
  if (!raw?.trim()) {
    if (mode === "replace") {
      applyDockerSidebarTree(null, "replace");
      applyDatabaseSidebarTree(null, "replace");
      applyProtocolHttpLayout(null, "replace");
    }
    return;
  }
  let payload: FolderTreesPayload;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (mode === "replace") {
        applyDockerSidebarTree(null, "replace");
        applyDatabaseSidebarTree(null, "replace");
        applyProtocolHttpLayout(null, "replace");
      }
      return;
    }
    payload = parsed as FolderTreesPayload;
  } catch {
    if (mode === "replace") {
      applyDockerSidebarTree(null, "replace");
      applyDatabaseSidebarTree(null, "replace");
      applyProtocolHttpLayout(null, "replace");
    }
    return;
  }

  applyDockerSidebarTree(payload.docker, mode);
  applyDatabaseSidebarTree(payload.database, mode);
  applyProtocolHttpLayout(payload.protocol, mode);
}
