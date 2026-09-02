import { commands } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { requireStepUp } from "../../lib/stepUp";
import { pipeTarget } from "../../lib/presenceTargets";
import { isProdEnvTag } from "../../lib/envTag";
import type { Connection } from "../../ipc/bindings";

export const ACTION_MODULE_CONFIG_PUBLISH = "module.config.publish";
export const ACTION_MODULE_CONFIG_DELETE = "module.config.delete";
export const ACTION_MODULE_CONFIG_ROLLBACK = "module.config.rollback";
export const ACTION_MODULE_NAMESPACE_WRITE = "module.namespace.write";
export const ACTION_MODULE_DISCOVERY_UPDATE = "module.discovery.update";

const WRITE_METHODS: Record<string, string> = {
  publishConfig: ACTION_MODULE_CONFIG_PUBLISH,
  deleteConfig: ACTION_MODULE_CONFIG_DELETE,
  rollbackConfig: ACTION_MODULE_CONFIG_ROLLBACK,
  createNamespace: ACTION_MODULE_NAMESPACE_WRITE,
  updateNamespace: ACTION_MODULE_NAMESPACE_WRITE,
  deleteNamespace: ACTION_MODULE_NAMESPACE_WRITE,
  updateInstance: ACTION_MODULE_DISCOVERY_UPDATE,
};

export async function invokeModuleMethod<T = unknown>(
  pluginId: string,
  method: string,
  args: Record<string, unknown>,
  opts?: { connection?: Connection; title?: string; message?: string },
): Promise<T> {
  const payload: Record<string, unknown> = { ...args };
  if (opts?.connection && !payload.connectionId) {
    payload.connectionId = opts.connection.id;
  }
  const action = WRITE_METHODS[method];
  if (action) {
    const target = pipeTarget(pluginId, String(payload.connectionId ?? ""), method);
    const token = await requireStepUp({
      action,
      target,
      title: opts?.title ?? method,
      message:
        opts?.message ??
        (isProdEnvTag(opts?.connection?.envTag)
          ? `生产环境将执行 ${method}，确认后继续。`
          : `确认执行 ${method}？`),
      reason: method,
    });
    if (!token) {
      throw new Error("cancelled");
    }
    payload.presenceToken = token;
    payload.presenceTarget = target;
  }
  try {
    return (await unwrapCommand(commands.pluginInvoke(pluginId, method, payload as never))) as T;
  } catch (err) {
    const message = formatIpcError(err);
    throw new Error(message);
  }
}
