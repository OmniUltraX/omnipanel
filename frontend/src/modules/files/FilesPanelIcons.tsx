type IconProps = { className?: string };

export function IconLocalConn({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M5 6h6M5 8h4" />
    </svg>
  );
}

export function IconFtpConn({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M5 7h6M5 9h4" />
    </svg>
  );
}

export function IconSftpConn({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="5" width="10" height="8" rx="1" />
      <path d="M5 5V4a3 3 0 016 0v1" />
      <circle cx="8" cy="10" r="1" />
    </svg>
  );
}

export function IconS3Conn({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 2L2 5v6l6 3 6-3V5z" />
      <path d="M2 5l6 3 6-3" />
    </svg>
  );
}

export function ConnProtocolIcon({ protocol }: { protocol: string }) {
  const cls = `conn-icon conn-icon--${protocol}`;
  if (protocol === "local") {
    return (
      <span className={cls}>
        <IconLocalConn />
      </span>
    );
  }
  if (protocol === "ftp") {
    return (
      <span className={cls}>
        <IconFtpConn />
      </span>
    );
  }
  if (protocol === "sftp") {
    return (
      <span className={cls}>
        <IconSftpConn />
      </span>
    );
  }
  return (
    <span className={cls}>
      <IconS3Conn />
    </span>
  );
}

export function IconUpload({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 10V3M5 5l3-3 3 3" />
      <path d="M3 12h10" />
    </svg>
  );
}

export function IconDownload({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M3 12h10" />
    </svg>
  );
}

export function IconDetailPanel({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M10 3v10" />
    </svg>
  );
}

export function IconNewFolder({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 13a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h3l1.5 2H13a1 1 0 011 1z" />
      <path d="M8 7v4M6 9h4" />
    </svg>
  );
}

export function IconListView({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 3h12M2 7h12M2 11h12" />
    </svg>
  );
}

export function IconGridView({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="0.5" />
      <rect x="9" y="2" width="5" height="5" rx="0.5" />
      <rect x="2" y="9" width="5" height="5" rx="0.5" />
      <rect x="9" y="9" width="5" height="5" rx="0.5" />
    </svg>
  );
}

export function IconNavBack({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

export function IconNavForward({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

export function IconNavUp({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 10l5-5 5 5" />
    </svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 8a6 6 0 0111.3-2.7M14 8a6 6 0 01-11.3 2.7" />
      <path d="M14 2v4h-4M2 14v-4h4" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="5" />
      <path d="M14 14l-3.5-3.5" />
    </svg>
  );
}

export function IconQuickDesktop({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="9" rx="1" />
      <path d="M5 14h6" />
    </svg>
  );
}

export function IconQuickDocuments({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 2h5l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

export function IconQuickDownloads({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M3 12h10" />
    </svg>
  );
}

export function IconQuickHome({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 8l6-5 6 5" />
      <path d="M4 7v6h8V7" />
    </svg>
  );
}
