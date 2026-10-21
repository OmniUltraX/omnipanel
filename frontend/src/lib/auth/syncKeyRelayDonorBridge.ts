/** 密钥落地或清除后通知传钥兜底重新评估，避免密钥模块和收件循环互相引用。 */
let refresh: (() => void) | null = null;

export function bindSyncKeyRelayDonorRefresh(fn: (() => void) | null): void {
  refresh = fn;
}

export function noteSyncTeamKeyChanged(): void {
  refresh?.();
}
