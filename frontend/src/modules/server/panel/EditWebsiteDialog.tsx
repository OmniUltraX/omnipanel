import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { FormDialog, FormField } from "@/components/ui/form/FormDialog";
import { TextInput } from "@/components/ui/form/TextInput";
import {
  createOnePanelClient,
  type OnePanelGroup,
  type OnePanelWebsiteUpdate,
} from "@/lib/onepanel";
import { showToast } from "@/stores/toastStore";
import { useServerPanelCacheStore } from "@/stores/serverPanelCacheStore";
import type { ServerEntry } from "./serverConnection";

type EditWebsiteDialogProps = {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  onClose: () => void;
  onUpdated?: () => void;
};

function formatEditError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

export function EditWebsiteDialog({
  open,
  server,
  websiteId,
  onClose,
  onUpdated,
}: EditWebsiteDialogProps) {
  const { t } = useI18n();
  const refreshServer = useServerPanelCacheStore((s) => s.refreshServer);

  const [primaryDomain, setPrimaryDomain] = useState("");
  const [remark, setRemark] = useState("");
  const [groupId, setGroupId] = useState(0);
  const [ipv6, setIpv6] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [expireDate, setExpireDate] = useState("");

  const [groups, setGroups] = useState<OnePanelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPrimaryDomain("");
    setRemark("");
    setGroupId(0);
    setIpv6(false);
    setFavorite(false);
    setExpireDate("");
    setError(null);
    setBusy(false);
    setLoading(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  useEffect(() => {
    if (!open || websiteId == null || server.serviceType !== "1panel") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const [detail, groupList] = await Promise.all([
          client.getWebsite(websiteId),
          client.searchGroups("website").catch(() => [] as OnePanelGroup[]),
        ]);
        if (cancelled) return;
        setGroups(groupList);
        setPrimaryDomain(
          asString(detail.primaryDomain ?? detail.primary_domain ?? detail.alias),
        );
        setRemark(asString(detail.remark));
        setGroupId(
          asNumber(
            detail.websiteGroupId ??
              detail.webSiteGroupID ??
              detail.websiteGroupID ??
              detail.groupID,
          ),
        );
        setIpv6(asBool(detail.IPV6 ?? detail.ipv6));
        setFavorite(asBool(detail.favorite));
        const expire = asString(detail.expireDate ?? detail.expire_date);
        setExpireDate(expire.slice(0, 10));
      } catch (err) {
        if (!cancelled) setError(formatEditError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, websiteId]);

  const canSubmit = useMemo(
    () => Boolean(websiteId != null && primaryDomain.trim()),
    [websiteId, primaryDomain],
  );

  const handleSubmit = async () => {
    if (server.serviceType !== "1panel" || websiteId == null) {
      setError(t("server.create.onePanelOnly"));
      return;
    }
    if (!canSubmit) {
      setError(t("server.create.website.required"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      const body: OnePanelWebsiteUpdate = {
        id: websiteId,
        primaryDomain: primaryDomain.trim(),
        remark: remark.trim(),
        webSiteGroupID: groupId || undefined,
        IPV6: ipv6,
        favorite,
      };
      if (expireDate.trim()) {
        body.expireDate = expireDate.trim();
      }
      await client.updateWebsite(body);
      showToast(t("server.websites.editSuccess"));
      await refreshServer(server);
      reset();
      onClose();
      onUpdated?.();
    } catch (err) {
      setError(formatEditError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("server.websites.editTitle")}
      size="lg"
      clipboardAssist={false}
      cancelDisabled={busy}
      closeDisabled={busy}
      primaryAction={{
        label: busy ? t("common.saving") : t("common.confirm"),
        disabled: busy || loading || !canSubmit,
        onClick: () => void handleSubmit(),
      }}
      status={error ? { kind: "error", message: error } : null}
    >
      {loading ? (
        <p className="form-hint">{t("common.loading")}</p>
      ) : (
        <>
          <FormField label={t("server.create.website.domain")}>
            <TextInput
              value={primaryDomain}
              onChange={setPrimaryDomain}
              placeholder="example.com"
              disabled={busy}
            />
          </FormField>

          <FormField label={t("server.create.website.group")}>
            <select
              className="input"
              value={groupId}
              disabled={busy || groups.length === 0}
              onChange={(e) => setGroupId(Number(e.target.value) || 0)}
            >
              {groups.length === 0 ? (
                <option value={0}>{t("server.create.website.groupDefault")}</option>
              ) : (
                groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name === "Default"
                      ? t("server.create.website.groupDefault")
                      : group.name}
                  </option>
                ))
              )}
            </select>
          </FormField>

          <FormField
            label={t("server.websites.expireDate")}
            hint={t("server.websites.expireDateHint")}
          >
            <TextInput
              value={expireDate}
              onChange={setExpireDate}
              placeholder="2099-12-31"
              disabled={busy}
            />
          </FormField>

          <label className="server-create-website-check">
            <input
              type="checkbox"
              checked={ipv6}
              disabled={busy}
              onChange={(e) => setIpv6(e.target.checked)}
            />
            <span>{t("server.create.website.ipv6")}</span>
          </label>

          <label className="server-create-website-check">
            <input
              type="checkbox"
              checked={favorite}
              disabled={busy}
              onChange={(e) => setFavorite(e.target.checked)}
            />
            <span>{t("server.websites.favorite")}</span>
          </label>

          <FormField label={t("server.create.remark")}>
            <TextInput
              value={remark}
              onChange={setRemark}
              placeholder={t("server.create.remarkPlaceholder")}
              disabled={busy}
            />
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
