import { commands } from "../../ipc/bindings";
import type { DockerDaemonConfigFile } from "../../ipc/bindings";
import { unwrap } from "./subwindows/dockerContainerApi";

export function readDockerDaemonConfig(connectionId: string): Promise<DockerDaemonConfigFile> {
  return unwrap(commands.dockerReadDaemonConfig(connectionId));
}

export async function writeDockerDaemonConfig(connectionId: string, content: string): Promise<void> {
  await unwrap(commands.dockerWriteDaemonConfig(connectionId, content));
}

export async function restartDockerDaemon(connectionId: string): Promise<void> {
  await unwrap(commands.dockerRestartDaemon(connectionId));
}
