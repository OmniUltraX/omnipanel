import { useEffect, useMemo, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui/form/Select";
import { TextInput } from "../../../components/ui/form/TextInput";
import { commands } from "../../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../../ipc/result";
import { useI18n } from "../../../i18n";
import type { HomeCustomPanelWidgetTarget } from "./types";
import "./springBootAdmin/SpringBootAdminView.css";

export type SpringBootAdminTargetSelectProps = {
  value: HomeCustomPanelWidgetTarget | null | undefined;
  onChange: (target: HomeCustomPanelWidgetTarget | null) => void;
  className?: string;
  disabled?: boolean;
  borderless?: boolean;
};

function emitTarget(
  adminUrl: string,
  instanceId: string,
  application: string,
  onChange: (target: HomeCustomPanelWidgetTarget | null) => void,
): void {
  const url = adminUrl.trim();
  if (!url) {
    onChange(null);
    return;
  }
  onChange({
    kind: "spring-boot-admin",
    adminUrl: url,
    instanceId: instanceId.trim(),
    application: application.trim(),
  });
}

/** Spring Boot Admin 地址 + Java 实例二级目标 */
export function SpringBootAdminTargetSelect({
  value,
  onChange,
  className,
  disabled,
  borderless = false,
}: SpringBootAdminTargetSelectProps) {
  const { t } = useI18n();
  const current = value?.kind === "spring-boot-admin" ? value : null;
  const [urlDraft, setUrlDraft] = useState(current?.adminUrl ?? "");
  const [instances, setInstances] = useState<
    { id: string; application: string; status: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrlDraft(current?.adminUrl ?? "");
  }, [current?.adminUrl]);

  useEffect(() => {
    const url = urlDraft.trim();
    if (!url) {
      const timer = window.setTimeout(() => onChange(null), 400);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      emitTarget(
        url,
        current?.instanceId ?? "",
        current?.application ?? "",
        onChange,
      );
    }, 400);
    return () => window.clearTimeout(timer);
    // 仅在地址草稿变化时回写 URL，避免覆盖正在选择的实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDraft]);

  useEffect(() => {
    const url = urlDraft.trim();
    let cancelled = false;
    if (!url) {
      setInstances([]);
      setError(null);
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const list = await unwrapCommand(
            commands.springBootAdminListInstances(url),
          );
          if (cancelled) return;
          setInstances(list);
          const still = list.find((i) => i.id === current?.instanceId);
          if (current?.instanceId && !still) {
            emitTarget(url, "", "", onChange);
          }
        } catch (err) {
          if (cancelled) return;
          setInstances([]);
          setError(formatIpcError(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDraft]);

  const options = useMemo<SelectOption[]>(() => {
    return instances.map((inst) => ({
      value: inst.id,
      label: inst.application || inst.id,
      subtitle: `${inst.status}${inst.id.length > 8 ? ` · ${inst.id.slice(0, 8)}` : ` · ${inst.id}`}`,
    }));
  }, [instances]);

  const selected = current?.instanceId ?? "";

  return (
    <div className={["sc-sba-target", className].filter(Boolean).join(" ")}>
      <TextInput
        size="sm"
        disabled={disabled}
        value={urlDraft}
        onChange={setUrlDraft}
        placeholder={t(
          "homeWorkspace.customPanel.target.placeholderSpringBootAdmin",
        )}
        aria-label={t("homeWorkspace.customPanel.target.springBootAdmin")}
        copyable={false}
      />
      <Select
        size="sm"
        borderless={borderless}
        searchable
        disabled={disabled || loading || !urlDraft.trim()}
        className="home-custom-panel-widget__source"
        value={selected}
        onChange={(next) => {
          const id = next.trim();
          const inst = instances.find((i) => i.id === id);
          emitTarget(urlDraft, id, inst?.application ?? "", onChange);
        }}
        placeholder={
          loading
            ? t("homeWorkspace.widgets.springBootAdmin.loadingInstances")
            : t("homeWorkspace.customPanel.target.placeholderJavaInstance")
        }
        emptyText={
          error
            ? error
            : t("homeWorkspace.customPanel.target.emptyJavaInstance")
        }
        aria-label={t("homeWorkspace.customPanel.target.javaInstance")}
        options={options}
        panelMinWidth={240}
      />
      {error ? <p className="sc-sba-target__hint">{error}</p> : null}
    </div>
  );
}
