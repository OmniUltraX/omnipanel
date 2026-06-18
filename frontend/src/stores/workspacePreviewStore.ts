/** 工作区缩略图预览缓存（Docker 日志等无全局 store 的模块写入） */

const dockerLogPreviews = new Map<string, string>();

export function setDockerLogPreview(tabKey: string, text: string): void {
  dockerLogPreviews.set(tabKey, text);
}

export function getDockerLogPreview(tabKey: string): string | null {
  return dockerLogPreviews.get(tabKey) ?? null;
}

export function dockerPreviewKey(connectionId: string, containerId: string): string {
  return `${connectionId}:${containerId}`;
}
