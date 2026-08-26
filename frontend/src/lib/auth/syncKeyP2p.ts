/**
 * 团队同步密钥 WebRTC P2P 传钥（信令待 omniserver 实现后接入）。
 */
import {
  createSyncKeyP2pRtcConfiguration,
  SYNC_KEY_P2P_DATA_CHANNEL_LABEL,
} from "./syncP2pConfig";

export {
  createSyncKeyP2pRtcConfiguration,
  DEFAULT_SYNC_STUN_URL,
  getSyncKeyP2pIceServers,
  resolveSyncStunUrls,
  SYNC_KEY_P2P_DATA_CHANNEL_LABEL,
} from "./syncP2pConfig";

/** 当前运行环境是否支持 WebRTC P2P（Tauri WebView / 现代浏览器）。 */
export function isSyncKeyP2pSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined";
}

/** 创建用于同步密钥传输的 `RTCPeerConnection`（已注入 STUN ICE servers）。 */
export function createSyncKeyPeerConnection(
  init?: RTCConfiguration,
): RTCPeerConnection {
  if (!isSyncKeyP2pSupported()) {
    throw new Error("当前环境不支持 WebRTC P2P");
  }
  return new RTCPeerConnection(createSyncKeyP2pRtcConfiguration(init));
}

/** 在已建立的 P2P 连接上创建传钥 DataChannel（发起方调用）。 */
export function createSyncKeyDataChannel(
  pc: RTCPeerConnection,
  label: string = SYNC_KEY_P2P_DATA_CHANNEL_LABEL,
): RTCDataChannel {
  return pc.createDataChannel(label, {
    ordered: true,
    negotiated: false,
  });
}
