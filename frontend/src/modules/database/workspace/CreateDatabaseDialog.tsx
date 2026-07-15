import { useEffect, useMemo, useState } from "react";

import { FormDialog, FormField } from "../../../components/ui/form/FormDialog";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/form";
import { useI18n } from "../../../i18n";
import {
  createDatabase,
  isMysqlConnectionInfoCapable,
  listCharacterSets,
  type DbCharsetMeta,
  type DbConnectionConfig,
} from "../api";

export interface CreateDatabaseDialogProps {
  open: boolean;
  connection: DbConnectionConfig | null;
  onCancel: () => void;
  onCreated: (name: string) => void;
}

const RESERVED_DB_NAMES = ["information_schema", "performance_schema", "mysql", "sys"];
const DB_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

export function CreateDatabaseDialog({
  open,
  connection,
  onCancel,
  onCreated,
}: CreateDatabaseDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [charset, setCharset] = useState<string>("");
  const [charsets, setCharsets] = useState<DbCharsetMeta[]>([]);
  const [charsetsLoading, setCharsetsLoading] = useState(false);
  const [charsetsError, setCharsetsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMysql = connection ? isMysqlConnectionInfoCapable(connection) : false;

  useEffect(() => {
    if (!open) {
      setName("");
      setCharset("");
      setCharsets([]);
      setCharsetsLoading(false);
      setCharsetsError(null);
      setBusy(false);
      setError(null);
    }
  }, [open, connection?.id]);

  useEffect(() => {
    if (!open || !connection || !isMysql) {
      return;
    }
    let cancelled = false;
    setCharsetsLoading(true);
    setCharsetsError(null);
    void listCharacterSets(connection)
      .then((list) => {
        if (!cancelled) setCharsets(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setCharsets([]);
          setCharsetsError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setCharsetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connection, isMysql]);

  const validate = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return t("database.createDatabase.nameRequired");
    if (trimmed.length > 64) return t("database.createDatabase.nameTooLong");
    if (!DB_NAME_RE.test(trimmed)) return t("database.createDatabase.nameInvalid");
    if (RESERVED_DB_NAMES.some((r) => r.toLowerCase() === trimmed.toLowerCase())) {
      return t("database.createDatabase.nameReserved", { name: trimmed });
    }
    return null;
  };

  const handleSubmit = async () => {
    if (!connection) return;
    const trimmed = name.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selectedCharset = charsets.find((c) => c.charset === charset) ?? null;
      const created = await createDatabase({
        connection,
        name: trimmed,
        charset: charset || null,
        collation: selectedCharset?.defaultCollation ?? null,
      });
      onCreated(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(t("database.createDatabase.failed", { message }));
    } finally {
      setBusy(false);
    }
  };

  const charsetOptions = useMemo(
    () => [
      { value: "", label: t("database.createDatabase.charsetServerDefault") },
      ...charsets.map((c) => ({
        value: c.charset,
        label: c.description ? `${c.charset} (${c.description})` : c.charset,
      })),
    ],
    [charsets, t],
  );
  const selectedCharset = charsets.find((c) => c.charset === charset) ?? null;
  const statusMessage =
    error ??
    charsetsError ??
    (charsetsLoading ? t("database.createDatabase.charsetLoading") : null);

  return (
    <FormDialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      closeDisabled={busy}
      title={t("database.createDatabase.title")}
      subtitle={connection ? t("database.createDatabase.subtitle", { name: connection.name }) : undefined}
      size="sm"
      onCancel={onCancel}
      cancelDisabled={busy}
      status={
        statusMessage
          ? {
              kind: error || charsetsError ? "error" : "info",
              message: statusMessage,
            }
          : null
      }
      primaryAction={{
        label: busy ? t("database.createDatabase.creating") : t("database.createDatabase.create"),
        disabled: busy,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormField
        label={t("database.createDatabase.nameLabel")}
        htmlFor="create-db-name"
        description={t("database.createDatabase.nameDescription")}
      >
        <TextInput
          id="create-db-name"
          className="input"
          autoFocus
          placeholder={t("database.createDatabase.namePlaceholder")}
          value={name}
          disabled={busy}
          onChange={(value) => {
            setName(value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
      </FormField>
      {isMysql && (
        <FormField
          label={t("database.createDatabase.charsetLabel")}
          htmlFor="create-db-charset"
          description={t("database.createDatabase.charsetDescription")}
        >
          <Select
            value={charset}
            onChange={setCharset}
            options={charsetOptions}
            size="sm"
            disabled={busy || charsetsLoading}
          />
        </FormField>
      )}
      {selectedCharset && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--muted, #8e8e93)",
            marginTop: "-2px",
          }}
        >
          {t("database.createDatabase.collationLabel")}:{" "}
          <code>{selectedCharset.defaultCollation}</code>
        </div>
      )}
    </FormDialog>
  );
}
