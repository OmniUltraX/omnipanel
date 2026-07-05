export type TextEditorPanelStatus = "loading" | "error" | "ready";

/** 文本读写适配器：本地 / SFTP / Docker 等场景统一接口。 */
export interface TextEditorIO {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** 基于字节读写的适配器（文件管理 / 终端 SFTP 等）。 */
export interface TextEditorBytesIO {
  readBytes(path: string, maxBytes: number): Promise<number[]>;
  writeBytes(path: string, bytes: number[]): Promise<void>;
}

export type TextEditorHandle = {
  canSave: () => boolean;
  save: () => Promise<void>;
};
