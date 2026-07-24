/**
 * 运维 Skill 种子：后端已在启动时写入 ~/.omnipd/skills（见 ensure_agent_defaults）。
 * 保留此入口以便前端启动时再兜底一次（非 Tauri 环境跳过）。
 */
import { commands } from "../../ipc/bindings";
import { isTauriRuntime } from "../isTauriRuntime";

let seeded = false;

/** @deprecated 默认 Skill 由 Rust `ensure_agent_defaults` 写入；此函数仅作兜底空操作兼容。 */
export async function ensureOpsSkillSeeds(): Promise<void> {
  if (seeded || !isTauriRuntime()) return;
  seeded = true;
  // 后端已 seed；此处仅确认 skillList 可调用（失败忽略）。
  try {
    await commands.skillList();
  } catch (e) {
    console.warn("[opsSkills] skillList 兜底检查失败", e);
  }
}
