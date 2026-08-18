import {
  stepSqlEditorFontSize,
  useSettingsStore,
} from "../../../stores/settingsStore";

/** 累计滚轮位移达到该像素则缩放一档（鼠标一格约 100–120px）。 */
const WHEEL_STEP_PX = 80;

function applyFontSizeStep(direction: 1 | -1): void {
  const { sqlEditorFontSize, setDatabaseSettings } = useSettingsStore.getState();
  const next = stepSqlEditorFontSize(sqlEditorFontSize, direction);
  if (next === sqlEditorFontSize) return;
  setDatabaseSettings({ sqlEditorFontSize: next });
}

function wheelDeltaY(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * WHEEL_STEP_PX;
  return event.deltaY;
}

/** Ctrl/Cmd+滚轮缩放 SQL 编辑器字号（写入设置，与工具栏字号选择同步）。 */
export function attachSqlEditorWheelZoom(el: HTMLElement): () => void {
  let acc = 0;
  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    acc += wheelDeltaY(event);
    while (acc <= -WHEEL_STEP_PX) {
      acc += WHEEL_STEP_PX;
      applyFontSizeStep(1);
    }
    while (acc >= WHEEL_STEP_PX) {
      acc -= WHEEL_STEP_PX;
      applyFontSizeStep(-1);
    }
  };
  el.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => el.removeEventListener("wheel", onWheel, { capture: true });
}
