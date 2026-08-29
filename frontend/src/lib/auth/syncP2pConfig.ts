/**
 * 团队同步密钥 P2P / WebRTC ICE 配置。
 *
 * 信令仍走 omniserver；STUN 仅用于 NAT 打洞，不传业务数据。
 * 可通过 `VITE_OMNIPANEL_STUN_URL` 覆盖（多个地址用逗号分隔）。
 */

/** 未配置环境变量时的 STUN 回退（现网已停用 coturn；mesh TCP 为主路径）。 */
export const DEFAULT_SYNC_STUN_URL = "";

/** 同步密钥 DataChannel 标签（WebRTC 传钥时使用）。 */
export const SYNC_KEY_P2P_DATA_CHANNEL_LABEL = "omnipanel-sync-key-v1";

function parseStunUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 解析 STUN URL 列表；未配置环境变量时返回空（WebRTC 传钥未启用）。 */
export function resolveSyncStunUrls(): string[] {
  const fromEnv = parseStunUrls(import.meta.env.VITE_OMNIPANEL_STUN_URL as string | undefined);
  if (fromEnv.length > 0) return fromEnv;
  const fallback = DEFAULT_SYNC_STUN_URL.trim();
  return fallback ? [fallback] : [];
}

/** 构建 `RTCPeerConnection` 使用的 ICE servers（当前仅 STUN，无 TURN）。 */
export function getSyncKeyP2pIceServers(): RTCIceServer[] {
  return resolveSyncStunUrls().map((url) => ({ urls: url }));
}

/** 构建同步密钥 P2P 用的 `RTCConfiguration`。 */
export function createSyncKeyP2pRtcConfiguration(
  init?: RTCConfiguration,
): RTCConfiguration {
  return {
    ...init,
    iceServers: init?.iceServers ?? getSyncKeyP2pIceServers(),
  };
}
