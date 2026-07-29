export type DashboardSuggestionKind = "draft" | "task" | "finding" | "starter";

export interface DashboardSuggestionChip {
  id: string;
  kind: DashboardSuggestionKind;
  label: string;
  /** 填入 Composer / 直发的提示文案 */
  prompt: string;
}

export interface DashboardSuggestionInput {
  drafts?: Array<{ id: string; title: string }>;
  tasks?: Array<{ id: string; name: string; info?: string }>;
  findings?: Array<{ id: string; title: string; summary?: string }>;
  /** 上下文不足时的兜底引导 */
  starters?: Array<{ id: string; label: string; prompt: string }>;
  /** 默认 5 */
  limit?: number;
}

/** 从首页/任务投影构建建议芯片（纯函数） */
export function buildDashboardSuggestionChips(
  input: DashboardSuggestionInput,
): DashboardSuggestionChip[] {
  const limit = input.limit ?? 5;
  const chips: DashboardSuggestionChip[] = [];

  for (const d of input.drafts ?? []) {
    if (chips.length >= limit) break;
    const title = d.title.trim() || d.id;
    chips.push({
      id: `draft:${d.id}`,
      kind: "draft",
      label: title,
      prompt: `请帮我审阅并推进这份待确认草稿：「${title}」。说明风险与建议下一步。`,
    });
  }

  for (const task of input.tasks ?? []) {
    if (chips.length >= limit) break;
    const name = task.name.trim() || task.id;
    const info = task.info?.trim();
    chips.push({
      id: `task:${task.id}`,
      kind: "task",
      label: name,
      prompt: info
        ? `请关注当前活跃任务「${name}」（${info}），分析状态并给出建议。`
        : `请关注当前活跃任务「${name}」，分析状态并给出建议。`,
    });
  }

  for (const f of input.findings ?? []) {
    if (chips.length >= limit) break;
    const title = f.title.trim() || f.id;
    const summary = f.summary?.trim();
    chips.push({
      id: `finding:${f.id}`,
      kind: "finding",
      label: title,
      prompt: summary
        ? `请处理巡检发现「${title}」：\n${summary}\n给出排查与修复建议。`
        : `请处理巡检发现「${title}」，给出排查与修复建议。`,
    });
  }

  if (chips.length === 0) {
    for (const s of input.starters ?? []) {
      if (chips.length >= limit) break;
      chips.push({
        id: `starter:${s.id}`,
        kind: "starter",
        label: s.label,
        prompt: s.prompt,
      });
    }
  }

  return chips.slice(0, limit);
}
