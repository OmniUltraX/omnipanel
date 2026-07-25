import { commands } from "../../ipc/bindings";
import type { DockerDaemonConfigFile } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { DOCKER_QUIET_IPC } from "./dockerConnectionOffline";
import { unwrap } from "./subwindows/dockerContainerApi";

/** 读 daemon.json：后台/页签预热路径，失败不打 IPC console.error。 */
export function readDockerDaemonConfig(connectionId: string): Promise<DockerDaemonConfigFile> {
  return unwrapCommand(commands.dockerReadDaemonConfig(connectionId), DOCKER_QUIET_IPC);
}

export async function writeDockerDaemonConfig(connectionId: string, content: string): Promise<void> {
  await unwrap(commands.dockerWriteDaemonConfig(connectionId, content));
}

export async function restartDockerDaemon(connectionId: string): Promise<void> {
  await unwrap(commands.dockerRestartDaemon(connectionId));
}
