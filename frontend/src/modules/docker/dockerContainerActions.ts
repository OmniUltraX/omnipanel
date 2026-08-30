import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { ACTION_DOCKER_CONTAINER_REMOVE, pipeTarget } from "../../lib/presenceTargets";
import { requireStepUp } from "../../lib/stepUp";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { runWithDockerBoundSsh } from "./ensureDockerBoundSsh";

const unwrap = unwrapCommand;

export async function runDockerContainerAction(
  connectionId: string,
  containerId: string,
  action: DockerContainerLifecycleAction,
  options?: { skipPresence?: boolean; label?: string },
): Promise<boolean> {
  let token: string | null = null;
  if (action === "remove" && !options?.skipPresence) {
    const issued = await requireStepUp({
      action: ACTION_DOCKER_CONTAINER_REMOVE,
      target: pipeTarget(connectionId, containerId),
      title: "删除容器",
      message: `即将删除容器 ${options?.label ?? containerId}`,
      reason: `remove ${containerId}`,
    });
    if (!issued) return false;
    token = issued;
  }
  await runWithDockerBoundSsh(connectionId, () =>
    unwrap(commands.dockerContainerAction(connectionId, containerId, action, token)),
  );
  return true;
}
