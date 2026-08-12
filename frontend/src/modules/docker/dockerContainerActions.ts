import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { runWithDockerBoundSsh } from "./ensureDockerBoundSsh";

const unwrap = unwrapCommand;

export async function runDockerContainerAction(
  connectionId: string,
  containerId: string,
  action: DockerContainerLifecycleAction,
): Promise<void> {
  await runWithDockerBoundSsh(connectionId, () =>
    unwrap(commands.dockerContainerAction(connectionId, containerId, action)),
  );
}
