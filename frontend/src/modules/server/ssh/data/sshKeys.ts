import type { SshKeyInfo } from "../types";

export const SSH_KEYS: SshKeyInfo[] = [
  { id: "mock-ed25519", name: "id_ed25519", meta: "ED25519 · Added 2025-12-01", usage: "Production hosts" },
  { id: "mock-rsa", name: "deploy_rsa", meta: "RSA 4096 · Added 2024-08-15", usage: "Legacy bastion" },
  { id: "mock-staging", name: "staging_ed25519", meta: "ED25519 · Added 2026-03-12", usage: "Staging cluster" },
];
