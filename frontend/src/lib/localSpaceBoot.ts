import { commands } from "../ipc/bindings";

/** 完成标志没打过就出现首次导航。已有连接或已登录都不跳过。 */
export async function resolveFirstRun(): Promise<"wizard" | "app"> {
  try {
    const res = await commands.localSpaceStatus();
    if (res.status !== "ok") return "app";
    return res.data.space?.onboarded ? "app" : "wizard";
  } catch {
    return "app";
  }
}
