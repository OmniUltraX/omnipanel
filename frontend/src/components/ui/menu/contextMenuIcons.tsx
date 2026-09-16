import type { ReactNode } from "react";

/** 右键菜单统一图标壳：与数据库模块 12px stroke 风格对齐。 */
export function ContextMenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** 各模块右键菜单共用图标集，保持视觉统一。 */
export const contextMenuIcons = {
  copy: (
    <ContextMenuIcon>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
    </ContextMenuIcon>
  ),
  cut: (
    <ContextMenuIcon>
      <circle cx="4.5" cy="4.5" r="1.8" />
      <circle cx="4.5" cy="11.5" r="1.8" />
      <path d="M6 5.5 12.5 12M6 10.5 12.5 4" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  paste: (
    <ContextMenuIcon>
      <path d="M5.5 3.5h5v2h-5z" />
      <rect x="3.5" y="4.5" width="9" height="9" rx="1" />
      <path d="M6 8.5h4M6 11h3" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  delete: (
    <ContextMenuIcon>
      <path d="M2 4h12" />
      <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M6 7v5M10 7v5" />
      <path d="M3 4l.7 9.1a1 1 0 0 0 1 .9h6.6a1 1 0 0 0 1-.9L13 4" />
    </ContextMenuIcon>
  ),
  edit: (
    <ContextMenuIcon>
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
      <path d="M2 14h12" />
    </ContextMenuIcon>
  ),
  rename: (
    <ContextMenuIcon>
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
      <path d="M2 14h12" />
    </ContextMenuIcon>
  ),
  plus: (
    <ContextMenuIcon>
      <path d="M8 3v10M3 8h10" />
    </ContextMenuIcon>
  ),
  open: (
    <ContextMenuIcon>
      <path d="M2.5 4.5h4l1.5 1.5H13.5v7H2.5z" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  openExternal: (
    <ContextMenuIcon>
      <path d="M6.5 3H3.5v10h10V9.5" strokeLinejoin="round" />
      <path d="M9 3h4v4M13 3 7.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  close: (
    <ContextMenuIcon>
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  refresh: (
    <ContextMenuIcon>
      <path d="M2 8a6 6 0 0 1 10.5-3.9" />
      <path d="M14 2v3h-3" />
      <path d="M14 8a6 6 0 0 1-10.5 3.9" />
      <path d="M2 14v-3h3" />
    </ContextMenuIcon>
  ),
  share: (
    <ContextMenuIcon>
      <circle cx="12" cy="3.5" r="1.8" />
      <circle cx="3.5" cy="8" r="1.8" />
      <circle cx="12" cy="12.5" r="1.8" />
      <path d="M5.2 7.1l5.2-2.5M5.2 8.9l5.2 2.5" />
    </ContextMenuIcon>
  ),
  export: (
    <ContextMenuIcon>
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <path d="M3 14h10" />
    </ContextMenuIcon>
  ),
  import: (
    <ContextMenuIcon>
      <path d="M8 10V2" />
      <path d="M5 5l3-3 3 3" />
      <path d="M3 14h10" />
    </ContextMenuIcon>
  ),
  download: (
    <ContextMenuIcon>
      <path d="M8 2v8" />
      <path d="M5 7l3 3 3-3" />
      <path d="M3 14h10" />
    </ContextMenuIcon>
  ),
  upload: (
    <ContextMenuIcon>
      <path d="M8 10V2" />
      <path d="M5 5l3-3 3 3" />
      <path d="M3 14h10" />
    </ContextMenuIcon>
  ),
  folder: (
    <ContextMenuIcon>
      <path d="M2.5 4.5h4l1.5 1.5H13.5v7H2.5z" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  file: (
    <ContextMenuIcon>
      <path d="M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9.5 2.5V6H13" />
    </ContextMenuIcon>
  ),
  play: (
    <ContextMenuIcon>
      <path d="M5 3.5v9l8-4.5z" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  stop: (
    <ContextMenuIcon>
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </ContextMenuIcon>
  ),
  info: (
    <ContextMenuIcon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7v4.5M8 5.2h.01" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  tags: (
    <ContextMenuIcon>
      <path d="M2.5 8.5V3.5H7.5l6 6-4 4z" strokeLinejoin="round" />
      <circle cx="5.2" cy="5.8" r="0.9" />
    </ContextMenuIcon>
  ),
  expand: (
    <ContextMenuIcon>
      <path d="M3 6l5 4 5-4" strokeLinecap="round" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  collapse: (
    <ContextMenuIcon>
      <path d="M3 10l5-4 5 4" strokeLinecap="round" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  clipboard: (
    <ContextMenuIcon>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
    </ContextMenuIcon>
  ),
  duplicate: (
    <ContextMenuIcon>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1" />
      <path d="M3.5 10.5V3.5A1 1 0 0 1 4.5 2.5H10" />
    </ContextMenuIcon>
  ),
  connect: (
    <ContextMenuIcon>
      <path d="M6.5 9.5 4 12a2.2 2.2 0 0 1-3.1-3.1L3.5 6.3" strokeLinecap="round" />
      <path d="M9.5 6.5 12 4a2.2 2.2 0 0 1 3.1 3.1L12.5 9.7" strokeLinecap="round" />
      <path d="M6.5 9.5l3-3" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  disconnect: (
    <ContextMenuIcon>
      <path d="M6.5 9.5 4 12a2.2 2.2 0 0 1-3.1-3.1L3.5 6.3" strokeLinecap="round" />
      <path d="M9.5 6.5 12 4a2.2 2.2 0 0 1 3.1 3.1L12.5 9.7" strokeLinecap="round" />
      <path d="M5 5l6 6M11 5l-6 6" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  terminal: (
    <ContextMenuIcon>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M5 7l2 1.5L5 10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 10h2.5" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  properties: (
    <ContextMenuIcon>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.5v1.8M8 11.7v1.8M2.5 8h1.8M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M4.1 11.9l1.3-1.3M10.6 5.4l1.3-1.3" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  star: (
    <ContextMenuIcon>
      <path
        d="M8 2.5l1.5 3.2 3.5.4-2.6 2.4.7 3.5L8 10.5 4.9 12l.7-3.5L3 6.1l3.5-.4z"
        strokeLinejoin="round"
      />
    </ContextMenuIcon>
  ),
  pin: (
    <ContextMenuIcon>
      <path d="M6 2.5h4l.5 4 2 2v1.5H3.5V8.5l2-2z" strokeLinejoin="round" />
      <path d="M8 10v3.5" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  unpin: (
    <ContextMenuIcon>
      <path d="M6 2.5h4l.5 4 2 2v1.5H3.5V8.5l2-2z" strokeLinejoin="round" />
      <path d="M8 10v3.5M3.5 3.5l9 9" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  move: (
    <ContextMenuIcon>
      <path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />
      <path d="M5.5 5 8 2.5 10.5 5M5.5 11 8 13.5 10.5 11M5 5.5 2.5 8 5 10.5M11 5.5 13.5 8 11 10.5" strokeLinecap="round" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  chmod: (
    <ContextMenuIcon>
      <rect x="3" y="7" width="10" height="6.5" rx="1" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </ContextMenuIcon>
  ),
  ai: (
    <ContextMenuIcon>
      <path d="M8 2.5a3 3 0 0 1 3 3v.8a3 3 0 0 1-6 0V5.5a3 3 0 0 1 3-3z" />
      <circle cx="11.5" cy="9.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="9.5" r="0.6" fill="currentColor" stroke="none" />
      <path d="M8 11.5v2M5.5 13.5h5" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  profile: (
    <ContextMenuIcon>
      <path d="M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9.5 2.5V6H13" />
      <circle cx="7.5" cy="9" r="1.4" />
      <path d="M5.2 12.5c0-1.1 1-1.8 2.3-1.8s2.3.7 2.3 1.8" />
    </ContextMenuIcon>
  ),
  list: (
    <ContextMenuIcon>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  clear: (
    <ContextMenuIcon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  design: (
    <ContextMenuIcon>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8h6M8 5v6" />
    </ContextMenuIcon>
  ),
  docker: (
    <ContextMenuIcon>
      <rect x="3" y="6" width="2.2" height="2.2" rx="0.3" />
      <rect x="5.9" y="6" width="2.2" height="2.2" rx="0.3" />
      <rect x="8.8" y="6" width="2.2" height="2.2" rx="0.3" />
      <rect x="5.9" y="3.2" width="2.2" height="2.2" rx="0.3" />
      <path d="M2.5 9.5h11v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
    </ContextMenuIcon>
  ),
  panel: (
    <ContextMenuIcon>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M2.5 6h11M6 6v7" />
    </ContextMenuIcon>
  ),
  sftp: (
    <ContextMenuIcon>
      <path d="M3 3.5h6.5L12.5 6.5v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z" />
      <path d="M9.5 3.5V6.5H12.5" />
      <path d="M5 10h5M5 12h3" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  window: (
    <ContextMenuIcon>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M2.5 6h11" />
    </ContextMenuIcon>
  ),
  test: (
    <ContextMenuIcon>
      <path d="M6 2.5h4v4.5L12.5 13H3.5L6 7z" strokeLinejoin="round" />
      <path d="M6.5 2.5h3" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  vectorize: (
    <ContextMenuIcon>
      <path d="M3 12.5 8 3.5 13 12.5z" strokeLinejoin="round" />
      <path d="M5.5 9.5h5" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  image: (
    <ContextMenuIcon>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <circle cx="5.5" cy="6.5" r="1.2" />
      <path d="M2.5 11.5 6 8.5l2 2 2.5-3 3 4" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  save: (
    <ContextMenuIcon>
      <path d="M3 2.5h8.5L13.5 5.5v8H3z" strokeLinejoin="round" />
      <path d="M5 2.5v4h5.5v-4M5 13.5v-4h6v4" />
    </ContextMenuIcon>
  ),
  widget: (
    <ContextMenuIcon>
      <rect x="2.5" y="2.5" width="5" height="5" rx="0.8" />
      <rect x="8.5" y="2.5" width="5" height="5" rx="0.8" />
      <rect x="2.5" y="8.5" width="5" height="5" rx="0.8" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="0.8" />
    </ContextMenuIcon>
  ),
  closeLeft: (
    <ContextMenuIcon>
      <path d="M8 3v10M4 8h8" strokeLinecap="round" />
      <path d="M6 6 4 8l2 2" strokeLinecap="round" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  closeRight: (
    <ContextMenuIcon>
      <path d="M8 3v10M4 8h8" strokeLinecap="round" />
      <path d="M10 6l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
    </ContextMenuIcon>
  ),
  closeOthers: (
    <ContextMenuIcon>
      <rect x="5" y="3.5" width="6" height="9" rx="1" />
      <path d="M3 5.5v5M13 5.5v5" strokeLinecap="round" />
    </ContextMenuIcon>
  ),
  closeAll: (
    <ContextMenuIcon>
      <rect x="3" y="3.5" width="4.5" height="9" rx="0.8" />
      <rect x="8.5" y="3.5" width="4.5" height="9" rx="0.8" />
    </ContextMenuIcon>
  ),
} as const;
