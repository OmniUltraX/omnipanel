export default {
    title: "通知中心",
    close: "关闭",
    clearAll: "一键清理",
    clearAllConfirm: "确定要清空全部通知吗？此操作不可恢复。",
    empty: "暂无通知",
    groups: {
      urgent: "紧急",
      today: "今日",
      yesterday: "昨日",
    },
    items: {
      disk: {
        title: "磁盘空间不足 — staging-worker",
        desc: "WAL 日志持续增长，当前使用率 92%。需要清理或扩容。",
        time: "30 分钟前",
      },
      ssl: {
        title: "SSL 证书即将过期",
        desc: "prod-web-01 · api.example.com 的证书将在 14 天后过期。",
        time: "1 小时前",
      },
      cpu: {
        title: "prod-db CPU 使用率偏高",
        desc: "过去 15 分钟 CPU 使用率维持在 67%，可能存在慢查询。",
        time: "2 小时前",
      },
      backup: {
        title: "数据库备份完成",
        desc: "prod-db-master 自动备份完成，已验证完整性。大小 2.3 GB。",
        time: "6 小时前",
      },
      container: {
        title: "容器 celery-worker 自动重启",
        desc: "celery-worker 因 OOM 被 kill 后自动重启，当前运行正常。",
        time: "8 小时前",
      },
      inspect: {
        title: "服务器巡检全部通过",
        desc: "6 台服务器例行巡检完成，无异常发现。",
        time: "10 小时前",
      },
      ratelimit: {
        title: "Rate limit 触发",
        desc: "45.33.32.0/24 子网在 5 分钟内发送 2,847 次请求，已触发限流。",
        time: "昨天 15:42",
      },
    },
  } as const;
