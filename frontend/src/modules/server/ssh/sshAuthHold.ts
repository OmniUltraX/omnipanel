/**
 * 兼容 re-export：实现已迁至 `lib/sshAuthHold`，供 connectionStore 等不经 modules 引用。
 */
export {
  noteSshAuthFailure,
  sshAuthHeldMessage,
  isSshAuthHeld,
  clearSshAuthHold,
} from "../../../lib/sshAuthHold";
