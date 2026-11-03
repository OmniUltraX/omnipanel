import { useCallback, useSyncExternalStore } from "react";
import { useI18n } from "../../i18n";
import { formatTeamSyncError, pushTeamModules } from "../../lib/auth/teamSyncApi";
import { isAuthSessionError } from "../../lib/auth/loginApi";
import {
  getSpaceSyncPrefs,
  setSpaceSyncPrefs,
  spaceSyncLastAt,
  subscribeSpaceSyncPrefs,
  type SpaceSyncCatchup,
} from "../../modules/clientSync/spaceSyncPrefs";
import { showToast } from "../../stores/toastStore";
import { WorkbenchActionButton } from "../ui/primitives";

const CATCHUPS: SpaceSyncCatchup[] = ["off", "15m", "1h"];

function formatLast(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

/** 空间仓库同步。本机改动稍后合并；定时再和云端仓库对齐一次。 */
export function TeamSpaceSync({
  teamId,
  token,
  onSessionExpired,
}: {
  teamId: number;
  token: string;
  onSessionExpired: () => void;
}) {
  const { t } = useI18n();
  const prefs = useSyncExternalStore(subscribeSpaceSyncPrefs, getSpaceSyncPrefs, getSpaceSyncPrefs);
  const lastAt = useSyncExternalStore(subscribeSpaceSyncPrefs, spaceSyncLastAt, spaceSyncLastAt);
  const syncing = useSyncExternalStore(subscribeSyncing, getSyncing, getSyncing);

  const syncNow = useCallback(async () => {
    if (!token.trim() || teamId <= 0 || getSyncing()) return;
    setSyncing(true);
    try {
      const result = await pushTeamModules(token, teamId);
      const chunks = result.bytes ?? 0;
      showToast(
        chunks > 0
          ? t("userCenter.teams.syncNowDoneChunks", { count: chunks })
          : t("userCenter.teams.syncNowDone"),
      );
    } catch (err) {
      if (isAuthSessionError(err)) onSessionExpired();
      else showToast(formatTeamSyncError(err));
    } finally {
      setSyncing(false);
    }
  }, [onSessionExpired, t, teamId, token]);

  return (
    <section className="space-sync">
      <div>
        <h4 className="user-center-teams-detail__subtitle">{t("userCenter.teams.syncTitle")}</h4>
        <p className="space-sync__note">{t("userCenter.teams.syncDesc")}</p>
      </div>

      <div className="space-sync__panel">
        <div className="space-sync__setting">
          <div>
            <div className="space-sync__label">{t("userCenter.teams.syncAuto")}</div>
            <p className="space-sync__note">{t("userCenter.teams.syncAutoHint")}</p>
          </div>
          <div className="space-sync__segments" role="group" aria-label={t("userCenter.teams.syncAuto")}>
            <button
              type="button"
              className={`space-sync__segment${prefs.auto ? " is-selected" : ""}`}
              aria-pressed={prefs.auto}
              onClick={() => setSpaceSyncPrefs({ auto: true })}
            >
              {t("userCenter.teams.syncAutoOn")}
            </button>
            <button
              type="button"
              className={`space-sync__segment${!prefs.auto ? " is-selected" : ""}`}
              aria-pressed={!prefs.auto}
              onClick={() => setSpaceSyncPrefs({ auto: false })}
            >
              {t("userCenter.teams.syncAutoOff")}
            </button>
          </div>
        </div>

        <div className="space-sync__setting">
          <div>
            <div className="space-sync__label">{t("userCenter.teams.syncCatchup")}</div>
            <p className="space-sync__note">{t("userCenter.teams.syncCatchupHint")}</p>
          </div>
          <div className="space-sync__segments" role="group" aria-label={t("userCenter.teams.syncCatchup")}>
            {CATCHUPS.map((value) => (
              <button
                key={value}
                type="button"
                className={`space-sync__segment${prefs.catchup === value ? " is-selected" : ""}`}
                aria-pressed={prefs.catchup === value}
                disabled={!prefs.auto}
                onClick={() => setSpaceSyncPrefs({ catchup: value })}
              >
                {t(
                  value === "15m"
                    ? "userCenter.teams.syncCatchup15m"
                    : value === "1h"
                      ? "userCenter.teams.syncCatchup1h"
                      : "userCenter.teams.syncCatchupOff",
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="space-sync__footer">
          <p className="space-sync__note">
            {lastAt
              ? t("userCenter.teams.syncLast", { time: formatLast(lastAt) })
              : t("userCenter.teams.syncLastNever")}
          </p>
          <WorkbenchActionButton onClick={() => void syncNow()} disabled={syncing || !token.trim() || teamId <= 0}>
            {syncing ? t("userCenter.teams.syncNowBusy") : t("userCenter.teams.syncNow")}
          </WorkbenchActionButton>
        </div>
      </div>
    </section>
  );
}

let syncing = false;
const syncingListeners = new Set<() => void>();

function subscribeSyncing(listener: () => void): () => void {
  syncingListeners.add(listener);
  return () => syncingListeners.delete(listener);
}

function getSyncing(): boolean {
  return syncing;
}

function setSyncing(next: boolean): void {
  syncing = next;
  for (const listener of syncingListeners) listener();
}
