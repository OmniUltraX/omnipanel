import { useMemo, useState } from "react";
import type { CloudNetworkRule } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { WorkbenchPanelHeader } from "../../components/ui/primitives/WorkbenchPanelHeader";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
} from "../database/workspace/DbTablesPanelGrid";
import { TextInput } from "../../components/ui/form/TextInput";
import { Select } from "../../components/ui/form/Select";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { CloudPager } from "./CloudListPager";
import { useCloudPaging } from "./cloudPaging";

type RuleDirection = "ingress" | "egress";

export function CloudRuleEditor({
  rules,
  busy,
  onAuthorize,
  onRevoke,
  cidrOnly,
  loading = false,
  error,
}: {
  rules: CloudNetworkRule[];
  busy?: boolean;
  onAuthorize: (params: Record<string, string>) => Promise<void | boolean>;
  onRevoke: (rule: CloudNetworkRule) => Promise<void | boolean>;
  /** RDS 白名单只填 CIDR。 */
  cidrOnly?: boolean;
  loading?: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<RuleDirection>("ingress");
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<RuleDirection>("ingress");
  const [protocol, setProtocol] = useState(cidrOnly ? "all" : "TCP");
  const [portRange, setPortRange] = useState(cidrOnly ? "ALL" : "22/22");
  const [cidr, setCidr] = useState("0.0.0.0/0");
  const [policy, setPolicy] = useState("accept");
  const [priority, setPriority] = useState("1");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const grouped = useMemo(() => {
    const ingress = rules.filter((rule) => (rule.direction || "ingress") !== "egress");
    const egress = rules.filter((rule) => rule.direction === "egress");
    return { ingress, egress };
  }, [rules]);

  const rows = cidrOnly ? rules : grouped[tab];
  const paging = useCloudPaging(rows, cidrOnly ? "whitelist" : tab);
  const columns = useMemo<DbTablesPanelGridColumn<CloudNetworkRule>[]>(() => {
    const cols: DbTablesPanelGridColumn<CloudNetworkRule>[] = [
      {
        id: "protocol",
        header: t("cloud.rules.protocol"),
        defaultWidth: 90,
        render: (rule) => (rule.protocol || "—").toUpperCase(),
      },
      {
        id: "port",
        header: t("cloud.rules.portRange"),
        nameCell: true,
        defaultWidth: 110,
        render: (rule) => rule.portRange || "—",
      },
      {
        id: "cidr",
        header: t("cloud.rules.cidr"),
        nameCell: true,
        defaultWidth: 180,
        render: (rule) => rule.cidr || rule.sourceGroupId || "—",
      },
    ];
    if (!cidrOnly) {
      cols.push(
        {
          id: "policy",
          header: t("cloud.rules.policy"),
          defaultWidth: 90,
          render: (rule) =>
            rule.policy === "drop"
              ? t("cloud.rules.drop")
              : rule.policy === "accept"
                ? t("cloud.rules.accept")
                : rule.policy || "—",
        },
        {
          id: "priority",
          header: t("cloud.rules.priority"),
          defaultWidth: 80,
          render: (rule) => rule.priority || "—",
        },
      );
    }
    cols.push(
      {
        id: "description",
        header: t("cloud.rules.description"),
        defaultWidth: 220,
        render: (rule) => rule.description || "—",
      },
      {
        id: "actions",
        header: "",
        variant: "actions",
        defaultWidth: 72,
        render: (rule) => (
          <WorkbenchActionButton
            danger
            disabled={busy || submitting}
            onClick={(event) => {
              event.stopPropagation();
              void onRevoke(rule);
            }}
          >
            {t("cloud.rules.revoke")}
          </WorkbenchActionButton>
        ),
      },
    );
    return cols;
  }, [busy, cidrOnly, onRevoke, submitting, t]);

  const openAdd = () => {
    setDirection(tab);
    setProtocol(cidrOnly ? "all" : "TCP");
    setPortRange(cidrOnly ? "ALL" : "22/22");
    setCidr("0.0.0.0/0");
    setPolicy("accept");
    setPriority("1");
    setDescription("");
    setOpen(true);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const ok = await onAuthorize({
        direction,
        protocol,
        portRange,
        cidr,
        policy,
        priority,
        description,
      });
      if (ok !== false) setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const emptyTitle = loading
    ? t("cloud.rules.loading")
    : error?.trim()
      ? error
      : t("cloud.rules.empty");

  return (
    <div className="cloud-rules">
      <div className="cloud-resource-list">
        <WorkbenchPanelHeader
          label={cidrOnly ? t("cloud.rules.whitelist") : t("cloud.detail.slots.rules")}
          extra={
            cidrOnly ? (
              <span className="workbench-panel-header-tag">
                {t("cloud.rules.count", { count: String(rules.length) })}
              </span>
            ) : (
              <div className="cloud-detail__tabs" role="tablist">
                {(["ingress", "egress"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={tab === item}
                    className={`cloud-detail__tab${tab === item ? " is-active" : ""}`}
                    onClick={() => setTab(item)}
                  >
                    {t(`cloud.rules.${item}`)}
                    <span className="cloud-detail__tab-count">{grouped[item].length}</span>
                  </button>
                ))}
              </div>
            )
          }
          actions={
            <WorkbenchActionButton disabled={busy || submitting} onClick={openAdd}>
              {t("cloud.rules.add")}
            </WorkbenchActionButton>
          }
        />
        {rows.length === 0 ? (
          <div className="cloud-resource-list__empty">
            <p>{emptyTitle}</p>
            {!loading && !error?.trim() ? <p className="form-hint">{t("cloud.rules.emptyHint")}</p> : null}
          </div>
        ) : (
          <div className="cloud-resource-list__body">
            <DbTablesPanelGrid
              columns={columns}
              rows={paging.slice}
              rowKey={(rule, index) =>
                rule.id || `${rule.direction}-${rule.protocol}-${rule.portRange}-${rule.cidr}-${index}`
              }
              columnResizeStorageKey={cidrOnly ? "cloud-rules-whitelist" : "cloud-rules"}
            />
            <CloudPager
              page={paging.page}
              pageSize={paging.pageSize}
              total={paging.total}
              totalPages={paging.totalPages}
              from={paging.from}
              to={paging.to}
              disabled={busy || submitting}
              onPageChange={paging.setPage}
              onPageSizeChange={paging.setPageSize}
            />
          </div>
        )}
      </div>

      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("cloud.rules.add")}
        subtitle={t("cloud.rules.addHint")}
        size="md"
        cancelDisabled={submitting}
        primaryAction={{
          label: submitting ? t("common.saving") : t("cloud.rules.submit"),
          disabled: busy || submitting || !cidr.trim(),
          onClick: () => void submit(),
        }}
      >
        {cidrOnly ? null : (
          <>
            <FormField label={t("cloud.rules.direction")}>
              <Select
                value={direction}
                onChange={(value) => setDirection(value === "egress" ? "egress" : "ingress")}
                options={[
                  { value: "ingress", label: t("cloud.rules.ingress") },
                  { value: "egress", label: t("cloud.rules.egress") },
                ]}
              />
            </FormField>
            <FormField label={t("cloud.rules.protocol")}>
              <Select
                value={protocol}
                onChange={setProtocol}
                options={["TCP", "UDP", "ICMP", "ALL"].map((value) => ({ value, label: value }))}
              />
            </FormField>
            <FormField label={t("cloud.rules.portRange")}>
              <TextInput value={portRange} onChange={setPortRange} copyable={false} />
            </FormField>
          </>
        )}
        <FormField label={t("cloud.rules.cidr")}>
          <TextInput value={cidr} onChange={setCidr} copyable={false} />
        </FormField>
        {cidrOnly ? null : (
          <>
            <FormField label={t("cloud.rules.policy")}>
              <Select
                value={policy}
                onChange={setPolicy}
                options={[
                  { value: "accept", label: t("cloud.rules.accept") },
                  { value: "drop", label: t("cloud.rules.drop") },
                ]}
              />
            </FormField>
            <FormField label={t("cloud.rules.priority")}>
              <TextInput value={priority} onChange={setPriority} copyable={false} />
            </FormField>
          </>
        )}
        <FormField label={t("cloud.rules.description")}>
          <TextInput value={description} onChange={setDescription} copyable={false} />
        </FormField>
      </FormDialog>
    </div>
  );
}
