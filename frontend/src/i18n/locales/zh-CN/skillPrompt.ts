export default {
    title: "Skill 自我进化",
    bodyHardRecall: "检测到 AI 召回了相似 Skill，看起来你在重复解决同类问题。要把这次经验沉淀为新的 Skill 吗？",
    bodyHardExtracted: "刚刚已沉淀一条经验到 Skill。建议补充上下文，让下次召回更精准。",
    bodyHardRefined: "一个 Skill 刚刚被改进，要不要顺手把本次会话的相关经验也关联进去？",
    bodySoftBatch: "近期的操作可能值得沉淀为可复用的 Skill。要不要让 AI 帮你提取一下？",
    extractAction: "提取为 Skill",
    dismissLater: "稍后提醒",
    dismissWeek: "本周不再提醒",
    dismissRemaining: "本周还可忽略 {count} 次",
    extractPromptText: "请帮我把最近的操作经验提取为可复用的 Skill：先总结关键步骤、适用场景、注意事项，然后调用 omni_skill_extract_experience 工具创建。如果有相关的知识库条目，请一并关联。之后若在相似资源上复用，请用 omni_skill_recall 召回并用 omni_skill_report_outcome 回写结果。",
  } as const;
