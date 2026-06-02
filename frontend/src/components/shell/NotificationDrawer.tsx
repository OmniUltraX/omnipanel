import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../../i18n";

type Tone = "danger" | "warn" | "success" | "accent";
type IconToken = "alert" | "server" | "activity" | "check" | "boxes" | "clipboard" | "zap";

interface NotifItem {
  key: string;
  tone: Tone;
  icon: IconToken;
  unread?: boolean;
}

interface NotifGroup {
  groupKey: string;
  items: NotifItem[];
}

const NOTIF_GROUPS: NotifGroup[] = [
  {
    groupKey: "urgent",
    items: [
      { key: "disk", tone: "danger", icon: "alert", unread: true },
      { key: "ssl", tone: "warn", icon: "server" },
      { key: "cpu", tone: "warn", icon: "activity", unread: true },
    ],
  },
  {
    groupKey: "today",
    items: [
      { key: "backup", tone: "success", icon: "check" },
      { key: "container", tone: "accent", icon: "boxes" },
      { key: "inspect", tone: "success", icon: "clipboard" },
    ],
  },
  {
    groupKey: "yesterday",
    items: [{ key: "ratelimit", tone: "accent", icon: "zap" }],
  },
];

function NotifIcon({ token }: { token: IconToken }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;
  switch (token) {
    case "alert":
      return (
        <svg {...common}>
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
      );
    case "server":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <circle cx="6" cy="6" r="1" fill="currentColor" />
          <circle cx="6" cy="18" r="1" fill="currentColor" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
          <path d="M22 4L12 14.01l-3-3" />
        </svg>
      );
    case "boxes":
      return (
        <svg {...common}>
          <rect x="2" y="7" width="6" height="5" rx="1" />
          <rect x="10" y="7" width="6" height="5" rx="1" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...common}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
      );
    case "zap":
      return (
        <svg {...common}>
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      );
  }
}

export function NotificationDrawer() {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    const toggleHandler = () => toggle();
    window.addEventListener("toggle-notif-drawer", toggleHandler);
    return () => window.removeEventListener("toggle-notif-drawer", toggleHandler);
  }, [toggle]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen]);

  return (
    <>
      <div
        className={`notif-drawer-overlay${isOpen ? " open" : ""}`}
      />
      <div className={`notif-drawer${isOpen ? " open" : ""}`}>
        <div className="notif-drawer-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" width="16" height="16">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          <h3>{t("notifications.title")}</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => setIsOpen(false)} title={t("notifications.close")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="notif-drawer-body">
          {NOTIF_GROUPS.map((group) => (
            <div key={group.groupKey}>
              <div className="notif-group-title">{t(`notifications.groups.${group.groupKey}`)}</div>
              {group.items.map((item) => (
                <div key={item.key} className={`notif-item${item.unread ? " unread" : ""}`}>
                  <div
                    className="notif-icon"
                    style={{ background: `var(--${item.tone}-soft)`, color: `var(--${item.tone})` }}
                  >
                    <NotifIcon token={item.icon} />
                  </div>
                  <div className="notif-content">
                    <div className="notif-title">{t(`notifications.items.${item.key}.title`)}</div>
                    <div className="notif-desc">{t(`notifications.items.${item.key}.desc`)}</div>
                    <div className="notif-time">{t(`notifications.items.${item.key}.time`)}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
