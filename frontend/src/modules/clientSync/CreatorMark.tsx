import { useSyncExternalStore } from "react";
import { useI18n } from "../../i18n";
import {
  deviceNameForId,
  getCachedDeviceId,
  getCachedDeviceName,
  getDeviceIdentityRevision,
  subscribeDeviceIdentity,
} from "../../lib/deviceIdentity";
import { getResourceTagValue } from "../../lib/resourceTags";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDbConnectionListStore } from "../../stores/dbConnectionListStore";
import "./SpaceConflictMark.css";

const UNKNOWN_CREATOR = "\u0000other";

/** 不是本机创建的资源才返回创建者名称。本机、或还看不出是谁创建的，返回 null。 */
export function resolveCreatorLabel(
  tags: readonly string[] | undefined | null,
  originDeviceId: string | null | undefined,
): string | null {
  const creator = getResourceTagValue(tags ? [...tags] : undefined, "creator")?.trim() ?? "";
  const origin = originDeviceId?.trim() ?? "";
  if (!creator && !origin) return null;
  const myId = getCachedDeviceId()?.trim() ?? "";
  const myName = getCachedDeviceName()?.trim() ?? "";
  if (!myId && !myName) return null;
  if (origin && myId) {
    if (origin === myId) return null;
    return creator || deviceNameForId(origin) || UNKNOWN_CREATOR;
  }
  if (creator && myName && creator.toLowerCase() === myName.toLowerCase()) return null;
  if (creator) return creator;
  return null;
}

export function CreatorMark({
  connectionId,
  tags,
  originDeviceId,
}: {
  connectionId?: string;
  tags?: readonly string[] | null;
  originDeviceId?: string | null;
}) {
  const { t } = useI18n();
  useSyncExternalStore(subscribeDeviceIdentity, getDeviceIdentityRevision, getDeviceIdentityRevision);
  const connection = useConnectionStore((state) =>
    connectionId ? state.connections.find((item) => item.id === connectionId) : undefined,
  );
  const database = useDbConnectionListStore((state) =>
    connectionId ? state.connections.find((item) => item.id === connectionId) : undefined,
  );
  const label = resolveCreatorLabel(
    tags ?? connection?.tags ?? database?.tags,
    originDeviceId ?? connection?.originDeviceId ?? database?.origin_device_id,
  );
  if (!label) return null;
  const text = label === UNKNOWN_CREATOR ? t("app.creator.other") : label;
  return (
    <span className="sidebar-tag-chip creator-mark" title={t("app.creator.hint", { name: text })}>
      {text}
    </span>
  );
}
