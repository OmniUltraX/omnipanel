import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import { TextInput } from "../../../components/ui/form/TextInput";
import { WorkbenchActionButton } from "../../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../../components/ui/primitives/WorkbenchPanelHeader";
import { invokePanelMethod, panelConnectionCtx } from "../../../lib/panelDriverRegistry";
import type { ServerEntry } from "./serverConnection";
import { canonicalPanelPluginId, panelTabCreateSpec, panelTabDecl } from "./panelPlugin";
import { panelDockTabLabel } from "./panelTabIds";

type Props = {
  server: ServerEntry;
  tabId: string;
};

function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 未知 panelTabs id：表单 + plugin_invoke，不写插件 ID 特判。 */
export function GenericPanelTabPane({ server, tabId }: Props) {
  const { t } = useI18n();
  const pluginId = canonicalPanelPluginId(server.serviceType);
  const decl = panelTabDecl(server.serviceType, tabId);
  const create = panelTabCreateSpec(server.serviceType, tabId);
  const fields = decl?.formFields ?? create?.formFields ?? [];
  const method = create?.method?.trim() || decl?.listMethod?.trim() || "";
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string>("");

  const title = useMemo(
    () => panelDockTabLabel(tabId, undefined, decl?.label),
    [decl?.label, tabId],
  );

  return (
    <div className="server-panel-tab-pane">
      <WorkbenchPanelHeader
        label={t("server.pluginTab.label")}
        tags={[{ text: title, emphasis: true }]}
        actions={
          <WorkbenchActionButton
            disabled={busy || !method}
            onClick={() => {
              if (!method) return;
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  const payload = {
                    ...panelConnectionCtx(server),
                    ...draft,
                  };
                  const res = await invokePanelMethod(pluginId, method, payload);
                  setResult(formatResult(res));
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {busy ? t("common.saving") : t("server.pluginTab.invoke")}
          </WorkbenchActionButton>
        }
      />
      {!method ? <p className="setting-hint">{t("server.pluginTab.noMethod")}</p> : null}
      {fields.map((field) => (
        <label key={field.key} className="module-host-field">
          <span>{field.label?.trim() || field.key}</span>
          <TextInput
            value={draft[field.key] ?? ""}
            onChange={(value) => setDraft((cur) => ({ ...cur, [field.key]: value }))}
            disabled={busy}
          />
        </label>
      ))}
      {error ? (
        <p className="setting-hint" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <pre className="setting-hint" style={{ whiteSpace: "pre-wrap" }}>
          {result}
        </pre>
      ) : null}
    </div>
  );
}
