import { useMemo, useState } from "react";
import type { CloudNetworkRule } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { TextInput } from "../../components/ui/form/TextInput";
import { Select } from "../../components/ui/form/Select";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { cloudPolicyTone } from "./cloudDetailUi";
import { CloudPager } from "./CloudListPager";
import { useCloudPaging } from "./cloudPaging";

type RuleDirection = "ingress" | "egress";

export function CloudRuleEditor({
  rules,
  busy,
  onAuthorize,
  onRevoke,
  cidrOnly,
}: {
  rules: CloudNetworkRule[];
  busy?: boolean;
  onAuthorize: (params: Record<string, string>) => Promise<void | boolean>;
  onRevoke: (rule: CloudNetworkRule) => Promise<void | boolean>;
  /** RDS 白名单只填 CIDR。 */
  cidrOnly?: boolean;
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

  return (
    <div className="cloud-rules">
      <section className="cloud-subpanel">
        <div className="cloud-subpanel__bar">
          {cidrOnly ? (
            <span className="cloud-subpanel__title">
              {t("cloud.rules.whitelist")}
              <span className="cloud-chip">{t("cloud.rules.count", { count: String(rules.length) })}</span>
            </span>
          ) : (
            <div className="cloud-detail__tabs cloud-subpanel__tabs" role="tablist">
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
          )}
          <Button type="button" size="sm" disabled={busy || submitting} onClick={openAdd}>
            {t("cloud.rules.add")}
          </Button>
        </div>
        <div className="cloud-table-wrap">
        {rows.length === 0 ? (
          <div className="cloud-empty">
            <strong>{t("cloud.rules.empty")}</strong>
            <p>{t("cloud.rules.emptyHint")}</p>
          </div>
        ) : (
            <table className="cloud-table">
              <thead>
                <tr>
                  <th>{t("cloud.rules.protocol")}</th>
                  <th>{t("cloud.rules.portRange")}</th>
                  <th>{t("cloud.rules.cidr")}</th>
                  {cidrOnly ? null : <th>{t("cloud.rules.policy")}</th>}
                  {cidrOnly ? null : <th>{t("cloud.rules.priority")}</th>}
                  <th>{t("cloud.rules.description")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((rule, index) => {
                  const policyTone = cloudPolicyTone(rule.policy);
                  return (
                    <tr key={rule.id || `${rule.direction}-${rule.protocol}-${rule.portRange}-${rule.cidr}-${index}`}>
                      <td>
                        <span className="cloud-chip">{(rule.protocol || "—").toUpperCase()}</span>
                      </td>
                      <td className="cloud-table__mono">{rule.portRange || "—"}</td>
                      <td className="cloud-table__mono">{rule.cidr || rule.sourceGroupId || "—"}</td>
                      {cidrOnly ? null : (
                        <td>
                          <span className={`cloud-pill cloud-pill--${policyTone}`}>
                            {rule.policy === "drop"
                              ? t("cloud.rules.drop")
                              : rule.policy === "accept"
                                ? t("cloud.rules.accept")
                                : rule.policy || "—"}
                          </span>
                        </td>
                      )}
                      {cidrOnly ? null : <td>{rule.priority || "—"}</td>}
                      <td className="cloud-table__desc">{rule.description || "—"}</td>
                      <td className="cloud-table__actions">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy || submitting}
                          onClick={() => void onRevoke(rule)}
                        >
                          {t("cloud.rules.revoke")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        )}
        </div>
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
      </section>

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
