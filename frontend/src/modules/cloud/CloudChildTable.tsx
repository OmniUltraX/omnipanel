import { useMemo, useState } from "react";
import type { CloudChildRow } from "../../ipc/bindings";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import { TextInput } from "../../components/ui/form/TextInput";
import { Select } from "../../components/ui/form/Select";
import { FormDialog, FormField } from "../../components/ui/form/FormDialog";
import { formatCloudFieldValue } from "./cloudForm";
import { CloudPager } from "./CloudListPager";
import { useCloudPaging } from "./cloudPaging";

const KIND_ORDER = ["disk", "snapshot", "backup", "dnsRecord", "listener", "backend", "account", "database", "parameter"];
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"];

export function CloudChildTable({
  rows,
  kinds,
  busy,
  onAdd,
  onUpdate,
  onDelete,
  onStart,
  onStop,
}: {
  rows: CloudChildRow[];
  kinds?: string[];
  busy?: boolean;
  onAdd?: (params: Record<string, string>) => Promise<void | boolean>;
  onUpdate?: (row: CloudChildRow, params: Record<string, string>) => Promise<void | boolean>;
  onDelete?: (row: CloudChildRow) => Promise<void | boolean>;
  onStart?: (row: CloudChildRow) => Promise<void | boolean>;
  onStop?: (row: CloudChildRow) => Promise<void | boolean>;
}) {
  const { t } = useI18n();
  const filtered = useMemo(() => {
    const wanted = kinds?.length ? new Set(kinds) : null;
    return rows.filter((row) => !wanted || wanted.has(row.kind ?? ""));
  }, [kinds, rows]);
  const groups = useMemo(() => {
    const map = new Map<string, CloudChildRow[]>();
    for (const row of filtered) {
      const kind = row.kind || "other";
      const list = map.get(kind) ?? [];
      list.push(row);
      map.set(kind, list);
    }
    return KIND_ORDER.filter((kind) => map.has(kind))
      .concat([...map.keys()].filter((kind) => !KIND_ORDER.includes(kind)))
      .map((kind) => ({ kind, rows: map.get(kind) ?? [] }));
  }, [filtered]);
  const canAddDns = Boolean(onAdd) && (kinds?.includes("dnsRecord") || filtered.some((r) => r.kind === "dnsRecord") || kinds == null);
  const [tab, setTab] = useState<string | null>(null);
  const activeKind = (groups.some((group) => group.kind === tab) ? tab : groups[0]?.kind) ?? "dnsRecord";
  const activeRows = groups.find((group) => group.kind === activeKind)?.rows ?? [];
  const paging = useCloudPaging(activeRows, activeKind);
  const [dialog, setDialog] = useState<"add" | "edit" | null>(null);
  const [editRow, setEditRow] = useState<CloudChildRow | null>(null);
  const [rr, setRr] = useState("@");
  const [type, setType] = useState("A");
  const [value, setValue] = useState("");
  const [ttl, setTtl] = useState("600");
  const [submitting, setSubmitting] = useState(false);

  const openAdd = () => {
    setEditRow(null);
    setRr("@");
    setType("A");
    setValue("");
    setTtl("600");
    setDialog("add");
  };

  const openEdit = (row: CloudChildRow) => {
    setEditRow(row);
    setRr(row.name || "@");
    setType(row.fields?.type ?? "A");
    setValue(row.fields?.value ?? "");
    setTtl(row.fields?.ttl ?? "600");
    setDialog("edit");
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      let ok: void | boolean = true;
      if (dialog === "edit" && editRow && onUpdate) {
        ok = await onUpdate(editRow, {
          recordId: editRow.id ?? "",
          rr,
          type,
          value,
          ttl,
        });
      } else if (onAdd) {
        ok = await onAdd({ rr, type, value, ttl });
      }
      if (ok !== false) setDialog(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (groups.length === 0 && !canAddDns) {
    return (
      <div className="cloud-children">
        <div className="cloud-table-wrap">
          <div className="cloud-empty">
            <strong>{t("cloud.children.empty")}</strong>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cloud-children">
      <section className="cloud-subpanel">
        <div className="cloud-subpanel__bar">
          {groups.length > 1 ? (
            <div className="cloud-detail__tabs cloud-subpanel__tabs" role="tablist">
              {groups.map((group) => (
                <button
                  key={group.kind}
                  type="button"
                  role="tab"
                  aria-selected={activeKind === group.kind}
                  className={`cloud-detail__tab${activeKind === group.kind ? " is-active" : ""}`}
                  onClick={() => setTab(group.kind)}
                >
                  {t(`cloud.children.kinds.${group.kind}`)}
                  <span className="cloud-detail__tab-count">{group.rows.length}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="cloud-subpanel__title">
              {t(`cloud.children.kinds.${activeKind}`)}
              <span className="cloud-chip">{t("cloud.rules.count", { count: String(activeRows.length) })}</span>
            </span>
          )}
          {canAddDns ? (
            <Button type="button" size="sm" disabled={busy || submitting} onClick={openAdd}>
              {t("cloud.actions.addRecord")}
            </Button>
          ) : null}
        </div>
        <div className="cloud-table-wrap">
        {activeRows.length === 0 ? (
          <div className="cloud-empty">
            <strong>{t("cloud.children.empty")}</strong>
          </div>
        ) : (
            <table className="cloud-table">
              <thead>
                <tr>
                  <th>{t("cloud.columns.name")}</th>
                  <th>{t("cloud.columns.status")}</th>
                  <th>{t("cloud.children.fields")}</th>
                  {onDelete || onStart || onStop || onUpdate ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((row, index) => (
                  <tr key={row.id || `${row.kind}-${row.name}-${index}`}>
                    <td>{row.name || row.id || "—"}</td>
                    <td>{formatCloudFieldValue(t, "status", row.status || "") || "—"}</td>
                    <td className="cloud-children__fields">
                      {Object.entries(row.fields ?? {})
                        .filter(([, v]) => v)
                        .map(([key, val]) => `${t(`cloud.columns.${key}`)} ${formatCloudFieldValue(t, key, val)}`)
                        .join(" · ") || "—"}
                    </td>
                    {onDelete || onStart || onStop || onUpdate ? (
                      <td>
                        <div className="cloud-children__row-actions">
                          {onStart && activeKind === "listener" ? (
                            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void onStart(row)}>
                              {t("cloud.actions.start")}
                            </Button>
                          ) : null}
                          {onStop && activeKind === "listener" ? (
                            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void onStop(row)}>
                              {t("cloud.actions.stop")}
                            </Button>
                          ) : null}
                          {onUpdate && activeKind === "dnsRecord" ? (
                            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => openEdit(row)}>
                              {t("cloud.actions.updateRecord")}
                            </Button>
                          ) : null}
                          {onDelete && activeKind === "dnsRecord" ? (
                            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void onDelete(row)}>
                              {t("cloud.actions.deleteRecord")}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
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
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === "edit" ? t("cloud.actions.updateRecord") : t("cloud.actions.addRecord")}
        size="md"
        cancelDisabled={submitting}
        primaryAction={{
          label: submitting ? t("common.saving") : dialog === "edit" ? t("common.save") : t("cloud.rules.submit"),
          disabled: busy || submitting || !value.trim(),
          onClick: () => void submit(),
        }}
      >
        <FormField label={t("cloud.columns.rr")}>
          <TextInput value={rr} onChange={setRr} copyable={false} />
        </FormField>
        <FormField label={t("cloud.columns.type")}>
          <Select
            value={type}
            onChange={setType}
            options={DNS_TYPES.map((item) => ({ value: item, label: item }))}
          />
        </FormField>
        <FormField label={t("cloud.columns.value")}>
          <TextInput value={value} onChange={setValue} copyable={false} />
        </FormField>
        <FormField label={t("cloud.columns.ttl")}>
          <TextInput value={ttl} onChange={setTtl} copyable={false} />
        </FormField>
      </FormDialog>
    </div>
  );
}
