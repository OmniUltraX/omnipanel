import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";

const unwrap = unwrapCommand;

export async function runDockerContainerAction(
  connectionId: string,
  containerId: string,
  action: DockerContainerLifecycleAction,
): Promise<void> {
  await unwrap(commands.dockerContainerAction(connectionId, containerId, action));
}
