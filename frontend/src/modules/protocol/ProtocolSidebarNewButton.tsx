import { useI18n } from "../../i18n";
import { useProtocolTopbarStore } from "../../stores/protocolTopbarStore";

/** 侧栏「新建」：先选协议再创建请求/会话 */
export function ProtocolSidebarNewButton() {
  const { t } = useI18n();
  const requestNewRequestPicker = useProtocolTopbarStore((s) => s.requestNewRequestPicker);

  return (
    <div className="schema-toolbar schema-toolbar--inline">
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
