import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { fetchDevices, fetchDeviceIdentity, fetchPublicQrcodes, type AuthDevice } from "../../lib/auth/loginApi";
import { ensureSyncTeamKey, exportSyncTeamKeyForMiniapp } from "../../lib/auth/syncTeamKeyApi";
import { watchAssistantTeamKeyReceived } from "../../lib/auth/watchAssistantTeamKeyNotify";
import { useAssistantTeamBindingStore } from "../../stores/assistantTeamBindingStore";
import {
  getCurrentSyncTeamId,
  resolveCurrentSyncTeamId,
  useCurrentSyncTeamStore,
} from "../../stores/currentSyncTeamStore";
import { showToast } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { IconClose, IconMonitor, IconPhone, IconGlobe } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";
import { LocalQrCode } from "../user/LocalQrCode";

type MenuAction = "assistant" | "client" | "miniapp";

function isMiniappMenuNode(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".sidebar-miniapp-menu"));
}

function resolveTeamLabel(teamId: number | null, teams: { id: number; name: string }[]): string {
  if (!teamId || teamId <= 0) return "";
  return teams.find((t) => t.id === teamId)?.name?.trim() || "";
}

/** 侧栏手机图标：弹出菜单 → 当前组织助手授权 / 客户端设备 / 小程序码。 */
export function SidebarMiniappButton() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);
  const userCenterOpen = useUserCenterUiStore((s) => s.open);
  const selectedTeamId = useCurrentSyncTeamStore((s) => s.teamId);
  const teams = useUserProfileStore((s) => s.teams);
  const currentTeamId = resolveCurrentSyncTeamId(selectedTeamId, teams);
  const teamLabel = resolveTeamLabel(currentTeamId, teams);

  const markBound = useAssistantTeamBindingStore((s) => s.markBound);
  const unbindTeamAssistant = useAssistantTeamBindingStore((s) => s.unbind);
  const listForTeam = useAssistantTeamBindingStore((s) => s.listForTeam);

  const [menuOpen, setMenuOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [miniappUrl, setMiniappUrl] = useState("");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [assistantDevices, setAssistantDevices] = useState<AuthDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [teamKeyQrPayload, setTeamKeyQrPayload] = useState("");
  const [view, setView] = useState<"list" | "qr" | "keyQr">("qr");
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const loadQrcodes = useCallback(async () => {
    setLoadState("loading");
    try {
      const data = await fetchPublicQrcodes();
      setMiniappUrl(data.miniapp_url);
      setLoadState("ready");
    } catch (e) {
      console.warn("[sidebarMiniapp] load qrcodes failed", e);
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadQrcodes();
  }, [loadQrcodes]);

  /**
   * 拉取当前组织已授权助手：本机绑定表 ∩ 账号设备列表。
   * （/api/sync/peers/online 只返回 client，不能用来发现助手端）
   */
  const loadAssistantsForCurrentTeam = useCallback(async (): Promise<AuthDevice[]> => {
    const teamId = getCurrentSyncTeamId();
    if (!token || !teamId || teamId <= 0) {
      setAssistantDevices([]);
      return [];
    }
    setDevicesLoading(true);
    try {
      const devices = await fetchDevices(token, { quiet: true });
      const assistants = devices.filter((d) => d.role === "assistant");
      const boundIds = new Set(listForTeam(teamId).map((b) => b.deviceId));
      const boundAssistants = assistants.filter((d) => boundIds.has(d.deviceId));
      // 绑定表里有、但设备列表暂缺的（离线后仍保留展示）
      for (const binding of listForTeam(teamId)) {
        if (boundAssistants.some((d) => d.deviceId === binding.deviceId)) continue;
        boundAssistants.push({
          id: 0,
          deviceId: binding.deviceId,
          deviceName: binding.deviceName,
          osType: "",
          ip: "",
          lastLoginAt: "",
          lastLogoutAt: "",
          userAgent: "",
          createdAt: "",
          updatedAt: "",
          role: "assistant",
          appId: binding.appId,
          platform: "",
          loginStatus: "logged_out",
          online: false,
          syncTrusted: true,
        });
      }

      setAssistantDevices(boundAssistants);
      return boundAssistants;
    } catch (e) {
      console.warn("[sidebarMiniapp] load assistants for team failed", e);
      setAssistantDevices([]);
      return [];
    } finally {
      setDevicesLoading(false);
    }
  }, [token, listForTeam]);

  const loadTeamKey = useCallback(async (): Promise<string | null> => {
    const teamId = getCurrentSyncTeamId();
    if (!teamId || teamId <= 0) {
      setTeamKeyQrPayload("");
      return null;
    }
    try {
      // 确保本机有密钥
      await ensureSyncTeamKey(teamId);
      const exported = await exportSyncTeamKeyForMiniapp(teamId);
      const resolvedTeamId = exported.teamId || teamId;
      const keyB64 = String(exported.keyB64 || "").trim();
      if (!resolvedTeamId || !keyB64) {
        throw new Error("导出团队密钥失败");
      }
      // 小程序解密需要 32 字节密钥，仅 fingerprint 不够
      setTeamKeyQrPayload(
        `omnipanel://sync-key?team_id=${resolvedTeamId}&key=${encodeURIComponent(keyB64)}`,
      );
      return exported.fingerprint;
    } catch (e) {
      console.warn("[sidebarMiniapp] failed to get team key", e);
      setTeamKeyQrPayload("");
      return null;
    }
  }, []);

  const openKeyQrForCurrentTeam = useCallback(async () => {
    await Promise.all([loadTeamKey(), loadAssistantsForCurrentTeam()]);
    setView("keyQr");
  }, [loadTeamKey, loadAssistantsForCurrentTeam]);

  /**
   * 将账号下助手写入当前组织绑定表。
   * @returns 本次新写入数量
   */
  const syncAccountAssistantsToTeam = useCallback(
    async (opts?: { onlyOnline?: boolean }): Promise<number> => {
      const teamId = getCurrentSyncTeamId();
      if (!token || !teamId || teamId <= 0) return 0;
      const devices = await fetchDevices(token, { quiet: true });
      const assistants = devices.filter((d) => d.role === "assistant");
      // 账号下完全没有助手设备时，无法自动授权
      if (!opts?.onlyOnline && assistants.length === 0) return 0;
      const before = new Set(listForTeam(teamId).map((b) => b.deviceId));
      let added = 0;
      for (const device of assistants) {
        if (opts?.onlyOnline && !device.online) continue;
        const id = String(device.deviceId || "").trim();
        if (!id) continue;
        markBound(teamId, {
          deviceId: id,
          deviceName: device.deviceName || id,
          appId: device.appId || "omni-assistant",
        });
        if (!before.has(id)) {
          before.add(id);
          added += 1;
        }
      }
      await loadAssistantsForCurrentTeam();
      return added;
    },
    [token, markBound, listForTeam, loadAssistantsForCurrentTeam],
  );

  const handleUnbind = useCallback(
    async (device: AuthDevice) => {
      const teamId = getCurrentSyncTeamId();
      if (!teamId || teamId <= 0) return;
      const name = device.deviceName || device.deviceId;
      const confirmed = await appConfirm(
        t("shell.miniapp.assistantUnbindConfirm", {
          name,
          team: teamLabel || String(teamId),
        }),
        t("shell.miniapp.assistantUnbind"),
        { kind: "warning", confirmLabel: t("shell.miniapp.assistantUnbind") },
      );
      if (!confirmed) return;
      try {
        // 仅解除当前组织的密钥授权记录，不影响账号级设备绑定及其他组织
        unbindTeamAssistant(teamId, device.deviceId);
        setAssistantDevices((prev) => prev.filter((d) => d.deviceId !== device.deviceId));
        showToast(t("shell.miniapp.assistantUnbindSuccess"));
      } catch (e) {
        console.warn("[sidebarMiniapp] unbind failed", e);
        showToast(t("shell.miniapp.assistantUnbindFailed"));
      }
    },
    [t, teamLabel, unbindTeamAssistant],
  );

  const updateMenuPosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 220;
    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - menuWidth - gap);
    }
    setMenuStyle({
      position: "fixed",
      left,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      width: menuWidth,
      zIndex: "var(--z-subwindow-popover, 1400)",
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (isMiniappMenuNode(event.target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onResize = () => updateMenuPosition();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, updateMenuPosition]);

  const handleMenuAction = async (action: MenuAction) => {
    setMenuOpen(false);
    if (action === "assistant") {
      if (!token) {
        showToast(t("shell.miniapp.assistantNeedLogin"));
        return;
      }
      const teamId = getCurrentSyncTeamId();
      if (!teamId || teamId <= 0) {
        showToast(t("shell.miniapp.assistantNeedTeam"));
        return;
      }
      // 始终展示传钥二维码；已绑定助手列在二维码下方
      await openKeyQrForCurrentTeam();
      setQrModalOpen(true);
      return;
    }
    if (action === "miniapp") {
      setView("qr");
      if (loadState === "error" || loadState === "idle") {
        void loadQrcodes();
      }
      setQrModalOpen(true);
      return;
    }
    openUserCenter("devices", { devicesClientOnly: true });
  };

  const closeQrModal = useCallback(() => setQrModalOpen(false), []);

  const active = menuOpen || qrModalOpen || userCenterOpen;

  const menuItems: { id: MenuAction; label: string; icon: ReactNode }[] = [
    {
      id: "assistant",
      label: t("shell.miniapp.menuAssistant"),
      icon: <IconPhone size={14} />,
    },
    {
      id: "client",
      label: t("shell.miniapp.menuClient"),
      icon: <IconMonitor size={14} />,
    },
    {
      id: "miniapp",
      label: t("shell.miniapp.menuMiniapp"),
      icon: <IconGlobe size={14} />,
    },
  ];

  const switchToKeyQr = useCallback(() => {
    void openKeyQrForCurrentTeam();
  }, [openKeyQrForCurrentTeam]);

  // 传钥二维码打开期间：轮询在线助手并写入绑定表（不依赖浏览器 SSE）
  useEffect(() => {
    if (!qrModalOpen || view !== "keyQr" || !token) return;
    let cancelled = false;
    let toasted = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        // 优先收录在线助手（扫码后小程序会心跳在线）
        let added = await syncAccountAssistantsToTeam({ onlyOnline: true });
        // 若仍为空，再尝试收录账号下全部助手（兼容 presence 延迟）
        if (!cancelled && added === 0) {
          const teamId = getCurrentSyncTeamId();
          const existing = teamId ? listForTeam(teamId).length : 0;
          if (existing === 0) {
            added = await syncAccountAssistantsToTeam({ onlyOnline: false });
          }
        }
        if (!cancelled && added > 0 && !toasted) {
          toasted = true;
          showToast(t("shell.miniapp.assistantConfirmBoundDone"));
        }
      } catch (e) {
        console.warn("[sidebarMiniapp] poll assistants failed", e);
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2000);

    // 可选：SSE 通知（失败不影响轮询主路径）
    const abort = new AbortController();
    void (async () => {
      try {
        const identity = await fetchDeviceIdentity();
        const deviceId = String(identity?.deviceId || "").trim();
        if (!deviceId || cancelled) return;
        await watchAssistantTeamKeyReceived({
          token,
          deviceId,
          signal: abort.signal,
          onEvent: (payload) => {
            const currentTeamId = getCurrentSyncTeamId();
            if (!currentTeamId || payload.teamId !== currentTeamId) return;
            markBound(currentTeamId, {
              deviceId: payload.assistantDeviceId,
              deviceName: payload.assistantDeviceName || payload.assistantDeviceId,
              appId: payload.appId || "omni-assistant",
            });
            void loadAssistantsForCurrentTeam().then((list) => {
              if (!cancelled && list.length > 0 && !toasted) {
                toasted = true;
                showToast(t("shell.miniapp.assistantConfirmBoundDone"));
              }
            });
          },
        });
      } catch (e) {
        if (abort.signal.aborted || cancelled) return;
        console.warn("[sidebarMiniapp] watch team-key notify failed", e);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [
    qrModalOpen,
    view,
    token,
    syncAccountAssistantsToTeam,
    listForTeam,
    markBound,
    loadAssistantsForCurrentTeam,
    t,
  ]);

  const listTitle = teamLabel
    ? t("shell.miniapp.assistantListTitleWithTeam", { team: teamLabel })
    : t("shell.miniapp.assistantListTitle");
  const keyQrTitle = teamLabel
    ? t("shell.miniapp.teamKeyQrTitleWithTeam", { team: teamLabel })
    : t("shell.miniapp.teamKeyQrTitle");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`sidebar-item${active ? " active" : ""}`}
        aria-label={t("shell.miniapp.menuLabel")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <IconPhone size={20} />
      </button>

      {menuOpen
        ? createPortal(
            <div
              className="sidebar-user-menu sidebar-miniapp-menu"
              style={menuStyle}
              role="menu"
              aria-label={t("shell.miniapp.menuLabel")}
            >
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="sidebar-user-menu__item"
                  onClick={() => void handleMenuAction(item.id)}
                >
                  <span className="sidebar-user-menu__icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="sidebar-user-menu__label">{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      <Modal open={qrModalOpen} onClose={closeQrModal}>
        <div
          className="sidebar-miniapp-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-miniapp-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="sidebar-miniapp-dialog__header">
            <h3 id="sidebar-miniapp-title">
              {view === "list" ? listTitle : view === "keyQr" ? keyQrTitle : t("shell.miniapp.title")}
            </h3>
            <button
              type="button"
              className="sidebar-miniapp-dialog__close"
              onClick={closeQrModal}
              aria-label={t("shell.topbar.close")}
            >
              <IconClose size={16} />
            </button>
          </div>

          {view === "list" ? (
            <div className="sidebar-miniapp-assistant-list">
              {devicesLoading ? (
                <p className="sidebar-miniapp-qr-status">{t("shell.miniapp.assistantLoading")}</p>
              ) : assistantDevices.length === 0 ? (
                <p className="sidebar-miniapp-qr-status">{t("shell.miniapp.assistantListEmpty")}</p>
              ) : (
                <>
                  {assistantDevices.map((device) => (
                    <div key={device.deviceId} className="sidebar-miniapp-assistant-item">
                      <span className="sidebar-miniapp-assistant-name">
                        {device.deviceName || device.deviceId}
                      </span>
                      <button
                        type="button"
                        className="sidebar-miniapp-assistant-unbind"
                        onClick={() => void handleUnbind(device)}
                      >
                        {t("shell.miniapp.assistantUnbind")}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="sidebar-miniapp-assistant-bind-new"
                    onClick={switchToKeyQr}
                  >
                    {t("shell.miniapp.assistantBindNew")}
                  </button>
                </>
              )}
            </div>
          ) : view === "keyQr" ? (
            <div className="sidebar-miniapp-key-qr">
              {teamKeyQrPayload ? (
                <>
                  <LocalQrCode
                    payload={teamKeyQrPayload}
                    size={220}
                    className="sidebar-miniapp-dialog__qr"
                    alt={t("shell.miniapp.teamKeyQrAlt")}
                  />
                  <div className="sidebar-miniapp-bound-section">
                    <p className="sidebar-miniapp-bound-title">
                      {t("shell.miniapp.assistantBoundBelow")}
                    </p>
                    {devicesLoading && assistantDevices.length === 0 ? (
                      <p className="sidebar-miniapp-qr-status">
                        {t("shell.miniapp.assistantLoading")}
                      </p>
                    ) : assistantDevices.length === 0 ? (
                      <p className="sidebar-miniapp-qr-status">
                        {t("shell.miniapp.assistantListEmpty")}
                      </p>
                    ) : (
                      <div className="sidebar-miniapp-assistant-list sidebar-miniapp-assistant-list--below-qr">
                        {assistantDevices.map((device) => (
                          <div key={device.deviceId} className="sidebar-miniapp-assistant-item">
                            <span className="sidebar-miniapp-assistant-name">
                              {device.deviceName || device.deviceId}
                              {device.online ? (
                                <span className="sidebar-miniapp-assistant-online">
                                  {t("shell.miniapp.assistantOnline")}
                                </span>
                              ) : null}
                            </span>
                            <button
                              type="button"
                              className="sidebar-miniapp-assistant-unbind"
                              onClick={() => void handleUnbind(device)}
                            >
                              {t("shell.miniapp.assistantUnbind")}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="sidebar-miniapp-qr-status sidebar-miniapp-qr-status--dialog">
                  {t("shell.miniapp.loading")}
                </div>
              )}
            </div>
          ) : (
            <>
              {loadState === "ready" && miniappUrl ? (
                <img
                  className="sidebar-miniapp-dialog__qr"
                  src={miniappUrl}
                  alt={t("shell.miniapp.qrAlt")}
                  draggable={false}
                />
              ) : (
                <div className="sidebar-miniapp-qr-status sidebar-miniapp-qr-status--dialog">
                  {loadState === "error" || (!miniappUrl && loadState !== "loading" && loadState !== "idle") ? (
                    <>
                      <p>{t("shell.miniapp.loadFailed")}</p>
                      <button
                        type="button"
                        className="sidebar-miniapp-qr-retry"
                        onClick={() => void loadQrcodes()}
                      >
                        {t("shell.miniapp.retry")}
                      </button>
                    </>
                  ) : (
                    t("shell.miniapp.loading")
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
