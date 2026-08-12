import { useState } from "react";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { TextInput } from "../../../components/ui/form/TextInput";
import {
  redisHashDelFields,
  redisHashSetField,
  redisListPush,
  redisListRemove,
  redisSetAdd,
  redisSetRemove,
  redisZsetAdd,
  redisZsetRemove,
  type DbConnectionConfig,
} from "../api";

interface RedisKeyCrudToolbarProps {
  connection: DbConnectionConfig;
  keyName: string;
  keyType: string;
  onChanged: () => void;
}

export function RedisKeyCrudToolbar({
  connection,
  keyName,
  keyType,
  onChanged,
}: RedisKeyCrudToolbarProps) {
  const { t } = useI18n();
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [score, setScore] = useState("0");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (!["hash", "list", "set", "zset"].includes(keyType)) {
    return null;
  }

  return (
    <div className="redis-key-crud-toolbar">
      {keyType === "hash" ? (
        <>
          <TextInput
            placeholder={t("database.redisOps.fieldName")}
            value={field}
            onChange={(v) => setField(v)}
          />
          <TextInput
            placeholder={t("database.redisOps.fieldValue")}
            value={value}
            onChange={(v) => setValue(v)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !field}
            onClick={() => void run(() => redisHashSetField(connection, keyName, field, value))}
          >
            {t("database.redisOps.hashSet")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !field}
            onClick={() => void run(() => redisHashDelFields(connection, keyName, [field]))}
          >
            {t("database.redisOps.hashDel")}
          </Button>
        </>
      ) : null}
      {keyType === "list" ? (
        <>
          <TextInput
            placeholder={t("database.redisOps.listValue")}
            value={value}
            onChange={(v) => setValue(v)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => redisListPush(connection, keyName, "left", [value]))}
          >
            LPUSH
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => redisListPush(connection, keyName, "right", [value]))}
          >
            RPUSH
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => redisListRemove(connection, keyName, 0, value))}
          >
            LREM
          </Button>
        </>
      ) : null}
      {keyType === "set" ? (
        <>
          <TextInput
            placeholder={t("database.redisOps.setMember")}
            value={value}
            onChange={(v) => setValue(v)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => redisSetAdd(connection, keyName, [value]))}
          >
            SADD
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => redisSetRemove(connection, keyName, [value]))}
          >
            SREM
          </Button>
        </>
      ) : null}
      {keyType === "zset" ? (
        <>
          <TextInput
            placeholder={t("database.redisOps.setMember")}
            value={value}
            onChange={(v) => setValue(v)}
          />
          <TextInput
            placeholder="Score"
            value={score}
            onChange={(v) => setScore(v)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() =>
              void run(() =>
                redisZsetAdd(connection, keyName, value, Number.parseFloat(score) || 0),
              )
            }
          >
            ZADD
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => redisZsetRemove(connection, keyName, [value]))}
          >
            ZREM
          </Button>
        </>
      ) : null}
    </div>
  );
}
