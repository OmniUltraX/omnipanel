import { BackendProtocolV2, EditResult, FileDownloadResponse, FileUploadResponse, GlobResult, GrepResult, LsResult, MaybePromise, ReadRawResult, ReadResult, WriteResult } from "deepagents";

export class OmniBackend implements BackendProtocolV2 {
    ls(path: string): MaybePromise<LsResult> {
        throw new Error("Method not implemented.");
    }
    read(filePath: string, offset?: number, limit?: number): MaybePromise<ReadResult> {
        throw new Error("Method not implemented.");
    }
    readRaw(filePath: string): MaybePromise<ReadRawResult> {
        throw new Error("Method not implemented.");
    }
    grep(pattern: string, path?: string | null, glob?: string | null): MaybePromise<GrepResult> {
        throw new Error("Method not implemented.");
    }
    glob(pattern: string, path?: string): MaybePromise<GlobResult> {
        throw new Error("Method not implemented.");
    }
    write(filePath: string, content: string): MaybePromise<WriteResult> {
        throw new Error("Method not implemented.");
    }
    edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): MaybePromise<EditResult> {
        throw new Error("Method not implemented.");
    }
    uploadFiles?(files: Array<[string, Uint8Array]>): MaybePromise<FileUploadResponse[]> {
        throw new Error("Method not implemented.");
    }
    downloadFiles?(paths: string[]): MaybePromise<FileDownloadResponse[]> {
        throw new Error("Method not implemented.");
    }
}