import { commands } from "../../../ipc/bindings";
import type { DockerContainerDetail, DockerFileEntry, DockerLogLine } from "../../../ipc/bindings";

export async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export function inspectDockerContainer(connectionId: string, containerId: string): Promise<DockerContainerDetail> {
  return unwrap(commands.dockerInspectContainer(connectionId, containerId));
}

export function fetchDockerContainerLogs(
  connectionId: string,
  containerId: string,
  tail = 500,
  since: string | null = null,
): Promise<DockerLogLine[]> {
  return unwrap(commands.dockerContainerLogs(connectionId, containerId, tail, since));
}

export async function clearDockerContainerLogs(connectionId: string, containerId: string): Promise<void> {
  await unwrap(commands.dockerClearContainerLogs(connectionId, containerId));
}

export function startDockerContainerLogStream(
  connectionId: string,
  containerId: string,
  tail: number,
  since: string | null,
  follow: boolean,
): Promise<string> {
  return unwrap(commands.dockerStreamContainerLogs(connectionId, containerId, tail, since, follow));
}

export async function stopDockerContainerLogStream(streamId: string): Promise<void> {
  await unwrap(commands.dockerStopLogStream(streamId));
}

export function listDockerContainerDir(
  connectionId: string,
  containerId: string,
  path: string,
): Promise<DockerFileEntry[]> {
  return unwrap(commands.dockerListContainerDir(connectionId, containerId, path));
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatOctalMode(mode: number): string {
  if (!mode) return "—";
  return (mode & 0o7777).toString(8).padStart(4, "0");
}
