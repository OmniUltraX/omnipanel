---
name: SSH 主机巡检
description: SSH 主机只读巡检：磁盘/负载/关键服务；危险命令需审批；召回与 outcome。
enabled: true
---

# SSH 主机巡检

## 流程
1. `omni_skill_recall`（resource_type=ssh）。
2. 优先 `omni_ssh_get_stats`；必要时 `omni_ssh_exec` 执行只读命令（df、uptime、free）。
3. 危险命令（rm、mkfs、reboot 等）必须审批。
4. `omni_skill_report_outcome`。
