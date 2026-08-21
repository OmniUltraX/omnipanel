import type { ReactNode } from "react";
import { MODULE_PATHS } from "./paths";
import { getPluginModule, pluginModulePath } from "./pluginModuleRegistry";

export type SidebarNavGroup = "primary" | "util";

export type SidebarNavItem = {
  key: string;
  path: string;
  i18nKey: string;
  group: SidebarNavGroup;
  icon: ReactNode;
};

const strokeIcon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    {d}
  </svg>
);

/** 侧栏图标/文案注册表。可见性由 `getNavVisibleModuleKeys` 决定，不再作为唯一来源写死路径列表。 */
export const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
  {
    key: "terminal",
    path: MODULE_PATHS.terminal,
    i18nKey: "shell.nav.terminal",
    group: "primary",
    icon: strokeIcon(
      <>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </>,
    ),
  },
  {
    key: "ssh",
    path: MODULE_PATHS.ssh,
    i18nKey: "shell.nav.ssh",
    group: "primary",
    icon: strokeIcon(
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </>,
    ),
  },
  {
    key: "database",
    path: MODULE_PATHS.database,
    i18nKey: "shell.nav.database",
    group: "primary",
    icon: strokeIcon(
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      </>,
    ),
  },
  {
    key: "docker",
    path: MODULE_PATHS.docker,
    i18nKey: "shell.nav.docker",
    group: "primary",
    icon: strokeIcon(
      <>
        <rect x="2" y="7" width="6" height="5" rx="1" />
        <rect x="10" y="7" width="6" height="5" rx="1" />
        <rect x="18" y="7" width="4" height="5" rx="1" />
        <rect x="6" y="2" width="6" height="5" rx="1" />
        <path d="M2 17h20c0 2.76-4.48 5-10 5S2 19.76 2 17z" />
      </>,
    ),
  },
  {
    key: "server",
    path: MODULE_PATHS.server,
    i18nKey: "shell.nav.server",
    group: "primary",
    icon: strokeIcon(
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </>,
    ),
  },
  {
    key: "cloud",
    path: MODULE_PATHS.cloud,
    i18nKey: "shell.nav.cloud",
    group: "primary",
    icon: strokeIcon(
      <>
        <path d="M7 18h10a4 4 0 000-8 5.5 5.5 0 00-10.6-1.5A3.5 3.5 0 007 18z" />
      </>,
    ),
  },
  {
    key: "files",
    path: MODULE_PATHS.files,
    i18nKey: "shell.nav.files",
    group: "primary",
    icon: strokeIcon(
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />,
    ),
  },
  {
    key: "protocol",
    path: MODULE_PATHS.protocol,
    i18nKey: "shell.nav.protocol",
    group: "util",
    icon: strokeIcon(
      <>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </>,
    ),
  },
  {
    key: "workflow",
    path: MODULE_PATHS.workflow,
    i18nKey: "shell.nav.workflow",
    group: "util",
    icon: strokeIcon(
      <>
        <path d="M12 3v18M3 12h18" />
        <circle cx="12" cy="12" r="3" />
      </>,
    ),
  },
  {
    key: "knowledge",
    path: MODULE_PATHS.knowledge,
    i18nKey: "shell.nav.knowledge",
    group: "util",
    icon: strokeIcon(
      <>
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </>,
    ),
  },
  {
    key: "tasks",
    path: MODULE_PATHS.tasks,
    i18nKey: "shell.nav.tasks",
    group: "util",
    icon: strokeIcon(
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </>,
    ),
  },
];

const NAV_BY_KEY = Object.fromEntries(SIDEBAR_NAV_ITEMS.map((item) => [item.key, item]));

function pluginModuleNavItem(key: string): SidebarNavItem | undefined {
  const desc = getPluginModule(key);
  if (!desc) return undefined;
  return {
    key: desc.moduleKey,
    path: pluginModulePath(desc.moduleKey),
    i18nKey: desc.labelI18nKey,
    group: desc.group,
    icon: strokeIcon(
      <>
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
        <path d="M12 12l8-4.5" />
        <path d="M12 12v9" />
        <path d="M12 12L4 7.5" />
      </>,
    ),
  };
}

export function sidebarNavItem(key: string): SidebarNavItem | undefined {
  return NAV_BY_KEY[key] ?? pluginModuleNavItem(key);
}

export function sidebarItemsForVisible(
  visibleKeys: string[],
  group: SidebarNavGroup,
): SidebarNavItem[] {
  return visibleKeys
    .map((key) => sidebarNavItem(key))
    .filter((item): item is SidebarNavItem => !!item && item.group === group);
}
