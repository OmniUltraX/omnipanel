export default {
    title: "Skill Self-Evolution",
    bodyHardRecall: "AI just recalled a similar Skill — looks like you're solving the same kind of problem again. Distill this session into a new Skill?",
    bodyHardExtracted: "A new experience has just been captured into a Skill. Add more context to make future recalls sharper.",
    bodyHardRefined: "A Skill was just refined — want to link related experiences from this session as well?",
    bodySoftBatch: "Recent activity looks worth turning into a reusable Skill. Want AI to extract it for you?",
    extractAction: "Extract as Skill",
    dismissLater: "Remind later",
    dismissWeek: "Don't remind this week",
    dismissRemaining: "You can dismiss {count} more time(s) this week",
    extractPromptText: "Please help me extract recent activity into a reusable Skill: summarize the key steps, applicable scenarios, and caveats, then call omni_skill_extract_experience. Link related knowledge if any. When reusing on similar resources, call omni_skill_recall and then omni_skill_report_outcome.",
  } as const;
