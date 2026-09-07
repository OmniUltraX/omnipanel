export type {
  ModuleDescriptor,
  ModuleKeepAlivePolicy,
  ModulePinWhen,
  ModuleRegistryId,
  ModuleSessionService,
  ModuleViewComponent,
  SessionHandle,
  ViewSink,
} from "./types";
export {
  registerModule,
  unregisterModule,
  getModule,
  listModules,
  clearModuleRegistryForTests,
} from "./registry";
export {
  ensureBuiltinModulesRegistered,
  resetBuiltinModulesRegistrationForTests,
} from "./builtinModules";
export { ModuleHost, type ModuleHostProps } from "./ModuleHost";
export { ModuleRuntimeOutlet } from "./ModuleRuntimeOutlet";
export {
  ensureSessionService,
  getSessionService,
  notifyModuleEvicted,
  clearSessionServicesForTests,
} from "./sessionServices";
