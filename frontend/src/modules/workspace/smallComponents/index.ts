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
export { formatWidgetSizeLabel, resolveWidgetSizeId } from "./formatWidgetSizeLabel";
export {
  DockerTargetSelect,
  type DockerTargetSelectProps,
} from "./DockerTargetSelect";

// 侧效注册内置小组件
import "./serverResourceMonitor/ServerResourceMonitorWidget";
import "./dockerContainerMonitor/DockerContainerMonitorWidget";
import "./dockerComposeMonitor/DockerComposeMonitorWidget";
