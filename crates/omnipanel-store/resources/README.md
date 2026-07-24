# Agent prompts & skills defaults

内置默认内容，首次启动写入用户目录（**已存在不覆盖**）：

| 内置路径 | 用户路径 |
|---------|---------|
| `resources/prompts/system-prompt.md` | `~/.omnipd/prompts/system-prompt.md` |
| `resources/skills/*/SKILL.md` | `~/.omnipd/skills/<id>/SKILL.md` |

仅一份系统提示词可配置。改用户目录文件后，下次对话按 mtime 生效。
