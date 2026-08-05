import { useCallback, useState } from "react";
import { useI18n } from "../../i18n";
import { showToast } from "../../stores/toastStore";
import { useProtocolTopbarStore } from "../../stores/protocolTopbarStore";
import { useProtocolHttpOptional } from "./ProtocolHttpContext";
import { loadProtocolImportDocument } from "./import/loadProtocolImportFile";
import { ProtocolImportParseError } from "./import/parseProtocolImport";

/** 侧栏工具栏：新建 + 导入 */
export function ProtocolSidebarNewButton({
  importParentFolderId = null,
}: {
  importParentFolderId?: string | null;
}) {
  const { t } = useI18n();
  const http = useProtocolHttpOptional();
  const requestNewRequestPicker = useProtocolTopbarStore((s) => s.requestNewRequestPicker);
  const [importing, setImporting] = useState(false);

  const handleImport = useCallback(async () => {
    if (!http || importing) return;
    setImporting(true);
    try {
      const loaded = await loadProtocolImportDocument();
      if (!loaded) return;
      const stats = await http.importHttpDocument(loaded.document, importParentFolderId);
      showToast(
        t("protocol.sidebar.importSuccess", {
          requests: String(stats.requestCount),
          folders: String(stats.folderCount),
        }),
      );
    } catch (e) {
      if (e instanceof ProtocolImportParseError) {
        if (e.code === "INVALID_JSON") {
          showToast(t("protocol.sidebar.importInvalidJson"));
        } else if (e.code === "UNSUPPORTED_FORMAT") {
          showToast(t("protocol.sidebar.importUnsupported"));
        } else if (e.code === "EMPTY") {
          showToast(t("protocol.sidebar.importEmpty"));
        } else {
          showToast(t("protocol.sidebar.importFailed"));
        }
      } else {
        console.error("[protocol] import failed:", e);
        showToast(t("protocol.sidebar.importFailed"));
      }
    } finally {
      setImporting(false);
    }
  }, [http, importParentFolderId, importing, t]);

  return (
    <div className="schema-toolbar schema-toolbar--inline">
      <button
        type="button"
        className="proto-sidebar-new"
        title={t("protocol.sidebar.import")}
        aria-label={t("protocol.sidebar.import")}
        disabled={!http || importing}
        onClick={(event) => {
          event.stopPropagation();
          void handleImport();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </button>
      <button
        type="button"
        className="proto-sidebar-new"
        title={t("protocol.sidebar.newRequest")}
        aria-label={t("protocol.sidebar.newRequest")}
        onClick={(event) => {
          event.stopPropagation();
          requestNewRequestPicker(null);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/** 供右键菜单复用的导入入口 */
export async function runProtocolHttpImport(options: {
  parentFolderId: string | null;
  importHttpDocument: NonNullable<ReturnType<typeof useProtocolHttpOptional>>["importHttpDocument"];
  t: (key: string, vars?: Record<string, string>) => string;
}): Promise<void> {
  const { parentFolderId, importHttpDocument, t } = options;
  try {
    const loaded = await loadProtocolImportDocument();
    if (!loaded) return;
    const stats = await importHttpDocument(loaded.document, parentFolderId);
    showToast(
      t("protocol.sidebar.importSuccess", {
        requests: String(stats.requestCount),
        folders: String(stats.folderCount),
      }),
    );
  } catch (e) {
    if (e instanceof ProtocolImportParseError) {
      if (e.code === "INVALID_JSON") {
        showToast(t("protocol.sidebar.importInvalidJson"));
      } else if (e.code === "UNSUPPORTED_FORMAT") {
        showToast(t("protocol.sidebar.importUnsupported"));
      } else if (e.code === "EMPTY") {
        showToast(t("protocol.sidebar.importEmpty"));
      } else {
        showToast(t("protocol.sidebar.importFailed"));
      }
      return;
    }
    console.error("[protocol] import failed:", e);
    showToast(t("protocol.sidebar.importFailed"));
  }
}
