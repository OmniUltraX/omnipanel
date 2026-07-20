export interface DockerModuleContext {
  connectionId: string | null;
  connectionName: string | null;
  containerId: string | null;
  containerName: string | null;
  navKey: string | null;
}

export function isDockerModuleContextEmpty(context: DockerModuleContext): boolean {
  return !context.connectionId;
}
