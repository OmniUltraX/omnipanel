import type { SshKeyInfo } from "../types";

export const SSH_KEYS: SshKeyInfo[] = [
  { name: "id_ed25519", meta: "ED25519 · Added 2025-12-01", usage: "Production hosts" },
  { name: "deploy_rsa", meta: "RSA 4096 · Added 2024-08-15", usage: "Legacy bastion" },
  { name: "staging_ed25519", meta: "ED25519 · Added 2026-03-12", usage: "Staging cluster" },
];
