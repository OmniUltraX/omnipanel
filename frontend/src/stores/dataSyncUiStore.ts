import { useUserCenterUiStore } from "./userCenterUiStore";

/** 打开个人中心并切到「数据同步」（兼容旧入口）。 */
export function openDataSync(): void {
  useUserCenterUiStore.getState().openUserCenter("dataSync");
}

/** 关闭个人中心窗口（兼容旧入口）。 */
export function closeDataSync(): void {
  useUserCenterUiStore.getState().closeUserCenter();
}
