export const PLUGIN_STUDIO_FILE_WRITTEN_EVENT = "plugin-studio:file-written";

export type PluginStudioFileWrittenDetail = {
  project: string;
  path: string;
};

export function notifyPluginStudioFileWritten(project: string, path: string): void {
  window.dispatchEvent(
    new CustomEvent<PluginStudioFileWrittenDetail>(PLUGIN_STUDIO_FILE_WRITTEN_EVENT, {
      detail: { project, path },
    }),
  );
}
