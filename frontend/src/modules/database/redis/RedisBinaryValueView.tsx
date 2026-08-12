import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import {
  buildRedisBinaryHexDump,
  detectRedisBinaryFormat,
  parseRedisEscapedBinary,
  type RedisEscapedBinary,
} from "./redisBinaryPreview";

type BinaryViewMode = "hex" | "escaped";

interface RedisBinaryValueViewProps {
  escaped: string;
  parsed: RedisEscapedBinary;
  sizeBytes?: number | null;
}

export function RedisBinaryValueView({ escaped, parsed, sizeBytes }: RedisBinaryValueViewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<BinaryViewMode>("hex");

  const formatId = useMemo(() => detectRedisBinaryFormat(parsed.bytes), [parsed.bytes]);
  const hexDump = useMemo(() => buildRedisBinaryHexDump(parsed.bytes), [parsed.bytes]);

  const formatLabel = t(`database.redisQuery.binaryFormats.${formatId}`);
  const previewBytes = parsed.bytes.length;
  const totalBytes = sizeBytes ?? previewBytes;

  return (
    <div className="redis-binary-value">
      <div className="redis-binary-value__head">
        <div className="redis-binary-value__meta">
          <span className="redis-binary-value__badge">{formatLabel}</span>
          <span className="redis-binary-value__size">
            {parsed.truncated
              ? t("database.redisQuery.binaryPreviewBytes", {
                  preview: previewBytes,
                  total: totalBytes,
                })
              : t("database.redisQuery.binaryBytes", { count: previewBytes })}
          </span>
          {parsed.truncated ? (
            <span className="redis-binary-value__hint">
              {t("database.redisQuery.binaryPreviewTruncated")}
            </span>
          ) : null}
        </div>
        <div className="redis-binary-value__modes" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "hex"}
            className={`redis-binary-value__mode${mode === "hex" ? " is-active" : ""}`}
            onClick={() => setMode("hex")}
          >
            {t("database.redisQuery.binaryViewHex")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "escaped"}
            className={`redis-binary-value__mode${mode === "escaped" ? " is-active" : ""}`}
            onClick={() => setMode("escaped")}
          >
            {t("database.redisQuery.binaryViewEscaped")}
          </button>
        </div>
      </div>
      <pre className="redis-binary-value__body">{mode === "hex" ? hexDump : escaped}</pre>
      <div className="redis-binary-value__footer">{t("database.redisQuery.binaryReadonly")}</div>
    </div>
  );
}

interface RedisStringValueViewProps {
  value: string;
  sizeBytes?: number | null;
}

export function RedisStringValueView({ value, sizeBytes }: RedisStringValueViewProps) {
  const parsed = useMemo(() => parseRedisEscapedBinary(value), [value]);
  if (parsed) {
    return <RedisBinaryValueView escaped={value} parsed={parsed} sizeBytes={sizeBytes} />;
  }
  return <pre className="redis-key-detail-string">{value}</pre>;
}
