import { useMemo, useState } from "react";
import type { CloudChildRow } from "../../ipc/bindings";
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
  loading = false,
  error,
}: {
  rows: CloudChildRow[];
  kinds?: string[];
  busy?: boolean;
  onAdd?: (params: Record<string, string>) => Promise<void | boolean>;
  onUpdate?: (row: CloudChildRow, params: Record<string, string>) => Promise<void | boolean>;
  onDelete?: (row: CloudChildRow) => Promise<void | boolean>;
  onStart?: (row: CloudChildRow) => Promise<void | boolean>;
  onStop?: (row: CloudChildRow) => Promise<void | boolean>;
  loading?: boolean;
  error?: string;
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

  const fieldText = (row: CloudChildRow, key: string) =>
    formatCloudFieldValue(t, key, row.fields?.[key] ?? "") || "—";
  const hasRowActions = Boolean(onDelete || onStart || onStop || onUpdate);
  const columns = useMemo<DbTablesPanelGridColumn<CloudChildRow>[]>(() => {
    const cols: DbTablesPanelGridColumn<CloudChildRow>[] =
      activeKind === "dnsRecord"
        ? [
            {
              id: "rr",
              header: t("cloud.columns.rr"),
              nameCell: true,
              defaultWidth: 140,
              render: (row) => row.name || row.id || "—",
            },
            {
              id: "type",
              header: t("cloud.columns.type"),
              defaultWidth: 80,
              render: (row) => fieldText(row, "type"),
            },
            {
              id: "value",
              header: t("cloud.columns.value"),
              nameCell: true,
              defaultWidth: 240,
              render: (row) => fieldText(row, "value"),
            },
            {
              id: "ttl",
              header: t("cloud.columns.ttl"),
              defaultWidth: 80,
              render: (row) => fieldText(row, "ttl"),
            },
            {
              id: "line",
              header: t("cloud.columns.line"),
              defaultWidth: 100,
              render: (row) => fieldText(row, "line"),
            },
            {
              id: "status",
              header: t("cloud.columns.status"),
              defaultWidth: 90,
              render: (row) => formatCloudFieldValue(t, "status", row.status || "") || "—",
            },
          ]
        : [
            {
              id: "name",
              header: t("cloud.columns.name"),
              nameCell: true,
              defaultWidth: 180,
              render: (row) => row.name || row.id || "—",
            },
            {
              id: "status",
              header: t("cloud.columns.status"),
              defaultWidth: 100,
              render: (row) => formatCloudFieldValue(t, "status", row.status || "") || "—",
            },
            {
              id: "fields",
              header: t("cloud.children.fields"),
              defaultWidth: 320,
              render: (row) =>
                Object.entries(row.fields ?? {})
                  .filter(([, value]) => value)
                  .map(([key, value]) => `${t(`cloud.columns.${key}`)} ${formatCloudFieldValue(t, key, value)}`)
                  .join(" · ") || "—",
            },
          ];
    if (hasRowActions) {
      cols.push({
        id: "actions",
        header: "",
        variant: "actions",
        defaultWidth: 140,
        render: (row) => (
          <span className="cloud-children__row-actions">
            {onStart && activeKind === "listener" ? (
              <WorkbenchActionButton disabled={busy} onClick={() => void onStart(row)}>
                {t("cloud.actions.start")}
              </WorkbenchActionButton>
            ) : null}
            {onStop && activeKind === "listener" ? (
              <WorkbenchActionButton disabled={busy} onClick={() => void onStop(row)}>
                {t("cloud.actions.stop")}
              </WorkbenchActionButton>
            ) : null}
            {onUpdate && activeKind === "dnsRecord" ? (
              <WorkbenchActionButton disabled={busy} onClick={() => openEdit(row)}>
                {t("cloud.actions.updateRecord")}
              </WorkbenchActionButton>
            ) : null}
            {onDelete && activeKind === "dnsRecord" ? (
              <WorkbenchActionButton danger disabled={busy} onClick={() => void onDelete(row)}>
                {t("cloud.actions.deleteRecord")}
              </WorkbenchActionButton>
            ) : null}
          </span>
        ),
      });
    }
    return cols;
  }, [activeKind, busy, hasRowActions, onDelete, onStart, onStop, onUpdate, t]);
  const emptyTitle = loading
    ? t("cloud.children.loading")
    : error?.trim()
      ? error
      : t("cloud.children.empty");

  return (
    <div className="cloud-children">
      <div className="cloud-resource-list">
        <WorkbenchPanelHeader
          label={t(`cloud.children.kinds.${activeKind}`)}
          extra={
            groups.length > 1 ? (
              <div className="cloud-detail__tabs" role="tablist">
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
              <span className="workbench-panel-header-tag">
                {t("cloud.rules.count", { count: String(activeRows.length) })}
              </span>
            )
          }
          actions={
            canAddDns ? (
              <WorkbenchActionButton disabled={busy || submitting} onClick={openAdd}>
                {t("cloud.actions.addRecord")}
              </WorkbenchActionButton>
            ) : null
          }
        />
        {activeRows.length === 0 ? (
          <div className="cloud-resource-list__empty">
            <p>{emptyTitle}</p>
          </div>
        ) : (
          <div className="cloud-resource-list__body">
            <DbTablesPanelGrid
              columns={columns}
              rows={paging.slice}
              rowKey={(row, index) => row.id || `${row.kind}-${row.name}-${index}`}
              columnResizeStorageKey={`cloud-children-${activeKind}`}
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
