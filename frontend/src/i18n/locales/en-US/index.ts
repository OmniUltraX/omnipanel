import tags from "./tags";
import app from "./app";
import knowledge from "./knowledge";
import notifications from "./notifications";
import logViewer from "./logViewer";
import sidebarTree from "./sidebarTree";
import resourceTags from "./resourceTags";
import common from "./common";
import skillPrompt from "./skillPrompt";
import resource from "./resource";
import quickInput from "./quickInput";
import ui from "./ui";
import share from "./share";
import shell from "./shell";
import routes from "./routes";
import cloud from "./cloud";
import moduleHost from "./moduleHost";
import plugins from "./plugins";
import taskCenter from "./taskCenter";
import workspace from "./workspace";
import env from "./env";
import resourceType from "./resourceType";
import contentPreview from "./contentPreview";
import files from "./files";
import database from "./database";
import dashboard from "./dashboard";
import homeWorkspace from "./homeWorkspace";
import terminal from "./terminal";
import ssh from "./ssh";
import docker from "./docker";
import server from "./server";
import stepUp from "./stepUp";
import settings from "./settings";
import tasks from "./tasks";
import protocol from "./protocol";
import workflow from "./workflow";
import ai from "./ai";
import userCenter from "./userCenter";
import syncTeamKeySetup from "./syncTeamKeySetup";
import syncDeviceAuth from "./syncDeviceAuth";
import dataSync from "./dataSync";

export const enUS = {
  tags,
  app,
  knowledge,
  notifications,
  logViewer,
  sidebarTree,
  resourceTags,
  common,
  skillPrompt,
  resource,
  quickInput,
  ui,
  share,
  shell,
  routes,
  cloud,
  moduleHost,
  plugins,
  taskCenter,
  workspace,
  env,
  resourceType,
  contentPreview,
  files,
  database,
  dashboard,
  homeWorkspace,
  terminal,
  ssh,
  docker,
  server,
  stepUp,
  settings,
  tasks,
  protocol,
  workflow,
  ai,
  userCenter,
  syncTeamKeySetup,
  syncDeviceAuth,
  dataSync
} as const;

export default enUS;
