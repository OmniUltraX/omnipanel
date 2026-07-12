import { commands } from "../../ipc/bindings";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export async function runDockerContainerAction(
  connectionId: string,
  containerId: string,
  action: DockerContainerLifecycleAction,
): Promise<void> {
  await unwrap(commands.dockerContainerAction(connectionId, containerId, action));
}
