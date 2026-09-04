export default {
    title: "Notifications",
    close: "Close",
    clearAll: "Clear all",
    clearAllConfirm: "Clear all notifications? This cannot be undone.",
    empty: "No notifications",
    groups: {
      urgent: "Urgent",
      today: "Today",
      yesterday: "Yesterday",
    },
    items: {
      disk: {
        title: "Low disk space — staging-worker",
        desc: "WAL logs keep growing, currently at 92% usage. Cleanup or scale up needed.",
        time: "30 minutes ago",
      },
      ssl: {
        title: "SSL certificate expiring soon",
        desc: "Certificate for prod-web-01 · api.example.com expires in 14 days.",
        time: "1 hour ago",
      },
      cpu: {
        title: "prod-db high CPU usage",
        desc: "CPU held at 67% over the last 15 minutes, possible slow queries.",
        time: "2 hours ago",
      },
      backup: {
        title: "Database backup completed",
        desc: "prod-db-master auto backup finished and verified. Size 2.3 GB.",
        time: "6 hours ago",
      },
      container: {
        title: "Container celery-worker auto-restarted",
        desc: "celery-worker was OOM-killed then auto-restarted, now running normally.",
        time: "8 hours ago",
      },
      inspect: {
        title: "All server inspections passed",
        desc: "Routine inspection of 6 servers completed, no issues found.",
        time: "10 hours ago",
      },
      ratelimit: {
        title: "Rate limit triggered",
        desc: "Subnet 45.33.32.0/24 sent 2,847 requests in 5 minutes, rate limiting applied.",
        time: "Yesterday 15:42",
      },
    },
  } as const;
