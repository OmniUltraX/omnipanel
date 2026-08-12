export type {
  HomeCustomPanelWidget,
  HomeCustomPanelWidgetTarget,
  SmallComponentController,
  SmallComponentDataSourceKind,
  SmallComponentDefaultSize,
  SmallComponentDefinition,
  SmallComponentInstanceContext,
  SmallComponentRenderProps,
  SmallComponentSize,
  SmallComponentTargetKind,
} from "./types";
export {
  getDefaultSize,
  sizeBoundsFromPresets,
} from "./types";
export {
  SmallComponentBase,
  bindSmallComponentView,
  definitionFromSmallComponentClass,
  getLiveSmallComponent,
  listLiveSmallComponents,
  registerSmallComponentClass,
  updateAllSmallComponents,
  updateSmallComponent,
  type SmallComponentClass,
} from "./base";
export {
  getSmallComponent,
  hasSmallComponents,
  listSmallComponents,
  registerSmallComponent,
} from "./registry";
export {
  SmallComponentDataSourceSelect,
  useDataSourceOptions,
} from "./DataSourceSelect";
export {
  SmallComponentSizeSelect,
  resolveSelectedSizeValue,
  sizePresetValue,
} from "./SizeSelect";
export { SmallComponentScaleSelect } from "./ScaleSelect";
export {
  applyWidgetScale,
  DEFAULT_WIDGET_SCALE,
  inferWidgetScale,
  normalizeWidgetScale,
  resolveBaseSizePreset,
  sizeBoundsWithScale,
  WIDGET_SCALE_FACTORS,
  type WidgetScale,
} from "./widgetScale";
export { formatWidgetSizeLabel, resolveWidgetSizeId } from "./formatWidgetSizeLabel";
export {
  DatabaseSchemaTargetSelect,
  type DatabaseSchemaTargetSelectProps,
} from "./DatabaseSchemaTargetSelect";
export {
  DockerTargetSelect,
  type DockerTargetSelectProps,
} from "./DockerTargetSelect";

// 侧效注册内置小组件
import "./serverResourceMonitor/ServerResourceMonitorWidget";
import "./dockerContainerMonitor/DockerContainerMonitorWidget";
import "./dockerComposeMonitor/DockerComposeMonitorWidget";
import "./mysqlOverview/MysqlOverviewWidget";
import "./redisOverview/RedisOverviewWidget";
