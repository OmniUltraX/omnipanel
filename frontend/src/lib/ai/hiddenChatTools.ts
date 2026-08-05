/**
 * 聊天流中不展示的工具调用（仍写入 message parts，供 dispatcher 定位父消息）。
 * Plan 工具只更新待办列表（PlanView）；ask_user 只展示澄清表单。
 */

export const PLAN_TOOL_NAMES = [
  "omni_plan_create",
  "omni_plan_add_step",
  "omni_plan_update_step",
] as const;

export type PlanToolName = (typeof PLAN_TOOL_NAMES)[number];

const PLAN_TOOL_SET: ReadonlySet<string> = new Set(PLAN_TOOL_NAMES);

export function isPlanToolName(name: string): boolean {
  return PLAN_TOOL_SET.has(name);
}

/** 聊天记录 / OSS 分片中隐藏的工具名 */
export function isHiddenChatToolName(name: string): boolean {
  return name === "omni_ask_user" || isPlanToolName(name);
}
