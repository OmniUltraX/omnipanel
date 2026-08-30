export const ACTION_DB_RESTART = "db.service.restart";
export const ACTION_DB_DROP_TABLE = "db.schema.drop_table";
export const ACTION_DB_DROP_DATABASE = "db.schema.drop_database";
export const ACTION_DB_DROP_USER = "db.user.drop";
export const ACTION_DB_ALTER_DROP = "db.schema.alter_drop";
export const ACTION_DB_TRUNCATE = "db.sql.truncate";
export const ACTION_DB_FLUSH = "db.redis.flush";
export const ACTION_DB_KILL = "db.session.kill";
export const ACTION_DOCKER_ENGINE_RESTART = "docker.engine.restart";
export const ACTION_DOCKER_CONTAINER_REMOVE = "docker.container.remove";
export const ACTION_DOCKER_COMPOSE_DOWN = "docker.compose.down";
export const ACTION_DOCKER_VOLUME_REMOVE = "docker.volume.remove";
export const ACTION_DOCKER_IMAGE_REMOVE = "docker.image.remove";
export const ACTION_DOCKER_NETWORK_REMOVE = "docker.network.remove";
export const ACTION_CLOUD_LIFECYCLE = "cloud.instance.lifecycle";
export const ACTION_SSH_EXEC = "ssh.exec";
export const ACTION_SSH_KILL = "ssh.process.kill";
export const ACTION_PANEL_DELETE = "panel.resource.delete";
export const ACTION_FILES_DELETE = "files.remote.delete";
export const ACTION_AI_TOOL = "ai.tool.write";
export const ACTION_PLUGIN_HOST = "plugin.host.privileged";

export function pipeTarget(...parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("|");
}

export function typedExpectation(action: string, target: string): string {
  if (action.endsWith(".restart") || action === ACTION_DOCKER_ENGINE_RESTART) {
    return "RESTART";
  }
  return (target.split("|").pop() ?? "").trim();
}

export function restartTarget(
  sshId: string,
  service: string,
  kind: string,
  location: string,
): string {
  return pipeTarget(sshId, service, kind, location);
}

export function dropTableTarget(connectionId: string, database: string, tables: string[]): string {
  const names = [...new Set(tables.map((n) => n.trim()).filter(Boolean))].sort();
  return `${connectionId.trim()}|${database.trim()}|${names.join(",")}`;
}

export function dropDatabaseTarget(connectionId: string, database: string): string {
  return pipeTarget(connectionId, database);
}

export function dropTableObjectsTarget(
  connectionId: string,
  objects: Array<{ database: string; name: string }>,
): string {
  const dbs = [...new Set(objects.map((o) => o.database.trim()))].sort();
  if (dbs.length <= 1) {
    return dropTableTarget(
      connectionId,
      dbs[0] ?? "",
      objects.map((o) => o.name),
    );
  }
  return dropTableTarget(
    connectionId,
    "*",
    objects.map((o) => `${o.database.trim()}.${o.name.trim()}`),
  );
}

export function filesDeleteTarget(connectionId: string, path: string): string {
  const leaf =
    path
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() ?? path;
  return pipeTarget(connectionId, leaf);
}

export function panelDeleteTarget(host: string, path: string): string {
  const leaf =
    path
      .split(/[/\\?&]/)
      .filter(Boolean)
      .pop() ?? path;
  return pipeTarget(host, leaf);
}

export function isPanelDestructive(path: string, body?: string | null): boolean {
  const hay = `${path} ${body ?? ""}`.toLowerCase();
  return [
    "/del",
    "delete",
    "uninstall",
    "destroysite",
    "deletesite",
    "deletedatabase",
    "deletecron",
    "deletessl",
    "removeapp",
    "uninstallapp",
    "action=del",
    "action=delete",
  ].some((k) => hay.includes(k));
}
