export interface NavicatRawConnection {
  name: string;
  connType: string;
  host: string;
  port: number;
  user: string;
  encryptedPassword: string;
  savePassword: boolean;
  database: string;
  ssl: boolean;
  remarks: string;
}

export type NavicatImportIssue =
  | "unsupported_engine"
  | "duplicate_name"
  | "duplicate_fingerprint"
  | "password_decrypt_failed"
  | "missing_host";

export interface NavicatImportPreviewItem {
  id: string;
  raw: NavicatRawConnection;
  engine: string | null;
  password: string;
  issues: NavicatImportIssue[];
  importable: boolean;
}
