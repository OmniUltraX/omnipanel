import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { CodeEditor } from "../../components/ui/CodeEditor";
import { ContentPreviewView } from "../../components/ui/ContentPreviewView";
import { ModuleEmptyState } from "../../components/ui/ModuleEmptyState";
import { VirtualJsonView } from "../../components/ui/VirtualJsonView";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import {
  formatHttpBodySize,
  formatHttpJsonBody,
  MAX_HTTP_JSON_FORMAT_BYTES,
  resolveHttpResponseBodyPreview,
  tryFormatHttpJsonBody,
  type HttpResponseBodyPreview,
} from "./httpJsonBody";
import type { HttpResponseSession } from "./httpResponseState";

type ResponseTab = "headers" | "body";
type JsonBodyViewMode = "structured" | "source";

interface Props {
  session: HttpResponseSession;
  /** 仅激活 Tab 才解析/渲染 JSON 预览，避免 Dock 多 Tab 同时挂载 JsonView 卡死 */
  isActive?: boolean;
}

function defaultJsonViewMode(preview: HttpResponseBodyPreview | null): JsonBodyViewMode {
  if (preview?.kind === "json-tree") return "structured";
  if (preview?.kind === "json-large") return "structured";
  if (preview?.kind === "json-source") return "source";
  return "structured";
}

function isJsonPreview(preview: HttpResponseBodyPreview | null): boolean {
  return (
    preview?.kind === "json-tree" ||
    preview?.kind === "json-large" ||
    preview?.kind === "json-source"
  );
}

export const HttpResponseSessionPanel = memo(function HttpResponseSessionPanel({
  session,
  isActive = true,
}: Props) {
  const { t } = useI18n();
  const [responseTab, setResponseTab] = useState<ResponseTab>("body");
  const [jsonViewMode, setJsonViewMode] = useState<JsonBodyViewMode>("structured");
  const [showFullPlainBody, setShowFullPlainBody] = useState(false);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [virtualJsonValue, setVirtualJsonValue] = useState<object | null>(null);
  const [virtualJsonParsing, setVirtualJsonParsing] = useState(false);
  const [virtualJsonParseFailed, setVirtualJsonParseFailed] = useState(false);
  const { response } = session;

  const bodyPreview = useMemo(() => {
    if (!isActive) return null;
    return resolveHttpResponseBodyPreview(response.body, response.contentType);
  }, [isActive, response.body, response.contentType]);

  useEffect(() => {
    setJsonViewMode(defaultJsonViewMode(bodyPreview));
    setShowFullPlainBody(false);
    setSourceText(null);
    setFormatting(false);
    setFormatError(null);
    setVirtualJsonValue(null);
    setVirtualJsonParsing(false);
    setVirtualJsonParseFailed(false);
  }, [session.id, bodyPreview?.kind]);

  useEffect(() => {
    if (bodyPreview?.kind !== "json-large" || !isActive || jsonViewMode !== "structured") {
      return;
    }

    setVirtualJsonParsing(true);
    setVirtualJsonParseFailed(false);
    setVirtualJsonValue(null);

    const body = bodyPreview.body;
    const timer = window.setTimeout(() => {
      try {
        const parsed: unknown = JSON.parse(body.trim());
        if (parsed !== null && typeof parsed === "object") {
          setVirtualJsonValue(parsed as object);
          setVirtualJsonParseFailed(false);
        } else {
          setVirtualJsonParseFailed(true);
        }
      } catch {
        setVirtualJsonParseFailed(true);
      } finally {
        setVirtualJsonParsing(false);
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [bodyPreview, isActive, jsonViewMode, session.id]);

  const responseHeaderEntries = useMemo(
    () => Object.entries(response.headers).sort(([a], [b]) => a.localeCompare(b)),
    [response.headers],
  );

  const formattedJsonSource = useMemo(() => {
    if (!isActive || bodyPreview?.kind !== "json-tree") return "";
    return formatHttpJsonBody(response.body);
  }, [bodyPreview?.kind, isActive, response.body]);

  const sourceEditorValue = useMemo(() => {
    if (sourceText != null) return sourceText;
    if (bodyPreview?.kind === "json-source") return bodyPreview.body;
    if (bodyPreview?.kind === "json-large") return bodyPreview.body;
    if (bodyPreview?.kind === "json-tree") return formattedJsonSource;
    return "";
  }, [bodyPreview, formattedJsonSource, sourceText]);

  const canFormatLargeJson =
    (bodyPreview?.kind === "json-source" || bodyPreview?.kind === "json-large") &&
    bodyPreview.sizeBytes <= MAX_HTTP_JSON_FORMAT_BYTES;

  const handleFormatJson = useCallback(() => {
    if (formatting) return;
    setFormatError(null);
    setFormatting(true);
    window.setTimeout(() => {
      const result = tryFormatHttpJsonBody(response.body);
      if (result.ok) {
        setSourceText(result.text);
        setJsonViewMode("source");
      } else if (result.reason === "too-large") {
        setFormatError(t("protocol.http.formatJsonTooLarge"));
      } else {
        setFormatError(t("protocol.http.formatJsonInvalid"));
      }
      setFormatting(false);
    }, 0);
  }, [formatting, response.body, t]);

  const renderLargeJsonSourceHint = () => {
    if (bodyPreview?.kind !== "json-source") return null;
    return (
      <div className="http-response-large-json">
        <p className="http-response-large-json__message">
          {t("protocol.http.largeJsonSourceHint", {
            size: formatHttpBodySize(bodyPreview.sizeBytes),
            limit: formatHttpBodySize(MAX_HTTP_JSON_FORMAT_BYTES),
          })}
        </p>
        <div className="http-response-large-json__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setJsonViewMode("source")}
          >
            {t("protocol.http.viewSource")}
          </button>
          {canFormatLargeJson ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={formatting}
              onClick={handleFormatJson}
            >
              {formatting ? t("protocol.http.formattingJson") : t("protocol.http.formatJson")}
            </button>
          ) : null}
        </div>
        {formatError ? (
          <p className="http-response-large-json__error">{formatError}</p>
        ) : null}
      </div>
    );
  };

  const renderVirtualJsonBody = () => {
    if (virtualJsonParsing) {
      return (
        <div className="content-preview-view content-preview-view--embedded http-response-session__body-preview">
          <ModuleEmptyState preset="folder" title={t("protocol.http.parsingJson")} />
        </div>
      );
    }
    if (virtualJsonParseFailed || !virtualJsonValue) {
      return (
        <div className="http-response-session__body-editor">
          <CodeEditor
            className="http-response-session__body-cm"
            language="json"
            value={bodyPreview?.kind === "json-large" ? bodyPreview.body : ""}
            onChange={() => {}}
            readOnly
            height="100%"
          />
        </div>
      );
    }
    return (
      <div className="content-preview-view content-preview-view--embedded http-response-session__body-preview">
        <div className="content-preview-json content-preview-json--virtual">
          <VirtualJsonView value={virtualJsonValue} />
        </div>
      </div>
    );
  };

  const renderBody = () => {
    if (!isActive) {
      return <div className="http-response-session__body-placeholder" aria-hidden />;
    }
    if (!bodyPreview) {
      return <div className="response-body">{response.body}</div>;
    }

    if (bodyPreview.kind === "json-tree") {
      if (jsonViewMode === "structured") {
        return (
          <ContentPreviewView
            status="ready"
            content={{ kind: "json", value: bodyPreview.value }}
            showTextModeToolbar={false}
            contentResetKey={session.id}
            className="content-preview-view--embedded http-response-session__body-preview"
          />
        );
      }
      return (
        <div className="http-response-session__body-editor">
          <CodeEditor
            className="http-response-session__body-cm"
            language="json"
            value={sourceEditorValue}
            onChange={() => {}}
            readOnly
            height="100%"
          />
        </div>
      );
    }

    if (bodyPreview.kind === "json-large") {
      if (jsonViewMode === "structured") {
        return renderVirtualJsonBody();
      }
      return (
        <div className="http-response-session__body-editor">
          <CodeEditor
            className="http-response-session__body-cm"
            language="json"
            value={sourceEditorValue}
            onChange={() => {}}
            readOnly
            height="100%"
          />
        </div>
      );
    }

    if (bodyPreview.kind === "json-source") {
      if (jsonViewMode === "structured") {
        return renderLargeJsonSourceHint();
      }
      return (
        <div className="http-response-session__body-editor">
          <CodeEditor
            className="http-response-session__body-cm"
            language="json"
            value={sourceEditorValue}
            onChange={() => {}}
            readOnly
            height="100%"
          />
        </div>
      );
    }

    if (bodyPreview.kind === "text-truncated" && !showFullPlainBody) {
      return (
        <div className="http-response-truncated">
          <pre className="response-body">{bodyPreview.preview}</pre>
          <div className="http-response-truncated__footer">
            <span className="http-response-truncated__meta">
              {t("protocol.http.bodyTruncated", {
                shown: formatHttpBodySize(bodyPreview.preview.length),
                total: formatHttpBodySize(bodyPreview.totalBytes),
              })}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowFullPlainBody(true)}
            >
              {t("protocol.http.loadFullBody")}
            </button>
          </div>
        </div>
      );
    }

    if (bodyPreview.kind === "text-truncated" && showFullPlainBody) {
      return (
        <div className="http-response-session__body-editor">
          <CodeEditor
            className="http-response-session__body-cm"
            language="text"
            value={response.body}
            onChange={() => {}}
            readOnly
            height="100%"
          />
        </div>
      );
    }

    if (bodyPreview.kind === "text") {
      return <div className="response-body">{bodyPreview.text}</div>;
    }

    return null;
  };

  const showJsonToolbar = isActive && responseTab === "body" && isJsonPreview(bodyPreview);
  const treeTabDisabled = bodyPreview?.kind === "json-source";

  return (
    <div className="http-response-session">
      <div className="response-summary">
        <span
          className={`response-status ${
            response.status >= 200 && response.status < 400 ? "badge-success" : "badge-danger"
          }`}
        >
          {response.status} {response.statusText}
        </span>
        <span className="response-meta">
          {response.timeMs}ms {"·"} {(response.sizeBytes / 1024).toFixed(1)} KB
        </span>
        <span className="response-meta">{"·"}</span>
        <span className="response-meta">{response.contentType}</span>
      </div>
      <div className="response-tabs">
        {(["headers", "body"] as ResponseTab[]).map((tab) => (
          <span
            key={tab}
            className={`response-tab${responseTab === tab ? " active" : ""}`}
            onClick={() => setResponseTab(tab)}
          >
            {t(`protocol.http.responseTabs.${tab}`)}
            {tab === "headers" ? ` (${responseHeaderEntries.length})` : ""}
          </span>
        ))}
        {showJsonToolbar ? (
          <div
            className="http-response-body-mode-toolbar content-preview-text-toolbar"
            role="group"
            aria-label={t("contentPreview.textMode")}
          >
            <button
              type="button"
              className={cn(
                "content-preview-text-mode-btn",
                jsonViewMode === "structured" && "is-active",
                treeTabDisabled && "is-disabled",
              )}
              aria-pressed={jsonViewMode === "structured"}
              disabled={treeTabDisabled}
              title={treeTabDisabled ? t("protocol.http.largeJsonTreeDisabled") : undefined}
              onClick={() => setJsonViewMode("structured")}
            >
              {t("contentPreview.modeJson")}
            </button>
            <button
              type="button"
              className={cn(
                "content-preview-text-mode-btn",
                jsonViewMode === "source" && "is-active",
              )}
              aria-pressed={jsonViewMode === "source"}
              onClick={() => setJsonViewMode("source")}
            >
              {t("contentPreview.modeCode")}
            </button>
            {(bodyPreview?.kind === "json-source" || bodyPreview?.kind === "json-large") &&
            canFormatLargeJson ? (
              <button
                type="button"
                className="content-preview-text-mode-btn http-response-format-json-btn"
                disabled={formatting}
                onClick={handleFormatJson}
              >
                {formatting ? t("protocol.http.formattingJson") : t("protocol.http.formatJson")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {responseTab === "headers" ? (
        <div className="response-headers">
          {responseHeaderEntries.length === 0 ? (
            <div className="response-headers-empty">{t("protocol.http.noResponseHeaders")}</div>
          ) : (
            responseHeaderEntries.map(([key, value]) => (
              <div className="response-header-row" key={key}>
                <span className="response-header-key">{key}</span>
                <span className="response-header-value">{value}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        renderBody()
      )}
    </div>
  );
});
