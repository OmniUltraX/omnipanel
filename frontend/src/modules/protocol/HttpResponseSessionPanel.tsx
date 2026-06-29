import { memo, useMemo, useState } from "react";
import { CodeEditor } from "../../components/ui/CodeEditor";
import { useI18n } from "../../i18n";
import { formatHttpJsonBody } from "./httpJsonBody";
import type { HttpResponseSession } from "./httpResponseState";

type ResponseTab = "headers" | "body";

interface Props {
  session: HttpResponseSession;
}

export const HttpResponseSessionPanel = memo(function HttpResponseSessionPanel({ session }: Props) {
  const { t } = useI18n();
  const [responseTab, setResponseTab] = useState<ResponseTab>("body");
  const { response } = session;

  const responseHeaderEntries = useMemo(
    () => Object.entries(response.headers).sort(([a], [b]) => a.localeCompare(b)),
    [response.headers],
  );

  const responseBodyDisplay = useMemo(() => {
    const isJson =
      response.contentType.includes("json") ||
      response.body.trimStart().startsWith("{") ||
      response.body.trimStart().startsWith("[");
    if (!isJson) return response.body;
    return formatHttpJsonBody(response.body);
  }, [response.body, response.contentType]);

  const responseBodyIsJson = useMemo(() => {
    return (
      response.contentType.includes("json") ||
      responseBodyDisplay !== response.body ||
      response.body.trimStart().startsWith("{") ||
      response.body.trimStart().startsWith("[")
    );
  }, [response.body, response.contentType, responseBodyDisplay]);

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
      ) : responseBodyIsJson ? (
        <div className="http-response-session__body-editor">
          <CodeEditor
            className="http-response-session__body-cm"
            language="json"
            value={responseBodyDisplay}
            onChange={() => {}}
            readOnly
            height="100%"
          />
        </div>
      ) : (
        <div className="response-body">{response.body}</div>
      )}
    </div>
  );
});
