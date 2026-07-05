import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "../../i18n";
import { Select } from "../ui/form/Select";
import type { ModuleKey } from "../../lib/paths";
import {
  type UserAppModuleStatus,
  useAppModuleStore,
} from "../../stores/appModuleStore";

const MODULE_LABEL_KEYS: Record<ModuleKey, string> = {
  terminal: "routes.terminal",
  database: "routes.database",
  ssh: "routes.ssh",
  docker: "routes.docker",
  server: "routes.server",
  files: "routes.files",
  protocol: "routes.protocol",
  workflow: "routes.workflow",
  knowledge: "routes.knowledge",
};

const USER_STATUS_OPTIONS: UserAppModuleStatus[] = ["open", "closed"];

export function ModulesSettingsSection() {
  const { t } = useI18n();
  const modules = useAppModuleStore((s) => s.modules);
  const hydrate = useAppModuleStore((s) => s.hydrate);
  const setStatus = useAppModuleStore((s) => s.setStatus);
  const getStatus = useAppModuleStore((s) => s.getStatus);

  useEffect(() => {
    if (modules.length === 0) {
      void hydrate();
    }
  }, [hydrate, modules.length]);

  const sorted = useMemo(
    () =>
      [...modules].sort(
        (a, b) => a.sort_order - b.sort_order || a.module_key.localeCompare(b.module_key),
      ),
    [modules],
  );

  const handleStatusChange = useCallback(
    async (key: ModuleKey, status: UserAppModuleStatus) => {
      if (status === "closed") {
        const openCount = sorted.filter(
          (m) =>
            m.module_key !== key &&
            getStatus(m.module_key as ModuleKey) === "open",
        ).length;
        if (openCount === 0) return;
      }
      await setStatus(key, status);
    },
    [getStatus, setStatus, sorted],
  );

  return (
    <>
      {sorted.map((mod) => {
        const key = mod.module_key as ModuleKey;
        const labelKey = MODULE_LABEL_KEYS[key];
        if (!labelKey) return null;

        const status = getStatus(key);
        const isDevLocked = status === "disabled";
        const openOthers = sorted.filter(
          (m) =>
            m.module_key !== key &&
            getStatus(m.module_key as ModuleKey) === "open",
        ).length;
        const closeLocked = status === "open" && openOthers === 0;

        return (
          <div className="setting-row" key={mod.module_key}>
            <div className="setting-label">
              <h4>{t(labelKey)}</h4>
              {isDevLocked && (
                <p className="setting-hint">{t("settings.modules.devLockedHint")}</p>
              )}
              {closeLocked && (
                <p className="setting-hint">{t("settings.modules.lastOpenHint")}</p>
              )}
            </div>
            {isDevLocked ? (
              <span className="module-status-badge module-status-badge--disabled">
                {t("settings.modules.status.disabled")}
              </span>
            ) : (
              <Select
                className="setting-select module-status-select"
                size="sm"
                value={status}
                onChange={(v) => void handleStatusChange(key, v as UserAppModuleStatus)}
                searchable={false}
                options={USER_STATUS_OPTIONS.map((value) => ({
                  value,
                  label: t(`settings.modules.status.${value}`),
                  disabled: value === "closed" && closeLocked,
                }))}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
