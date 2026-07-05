import { readRemotePreview, uploadRemote } from "../../../modules/files/fileApi";
import { decodePreviewBytes } from "../../../modules/files/filePreviewKind";
import type { TextEditorBytesIO, TextEditorIO } from "../types";
import { decodeUtf8, encodeUtf8 } from "../bytes";

export function createFilePathTextIO(options: {
  connectionId: string;
  path: string;
  maxBytes: number;
  bytesIO?: TextEditorBytesIO;
}): TextEditorIO {
  const { connectionId, path, maxBytes, bytesIO } = options;
  return {
    readText: async () => {
      const bytes = bytesIO
        ? await bytesIO.readBytes(path, maxBytes)
        : await readRemotePreview(connectionId, path, maxBytes);
      return bytesIO ? decodeUtf8(bytes) : decodePreviewBytes(bytes);
    },
    writeText: async (text) => {
      const data = encodeUtf8(text);
      if (bytesIO) {
        await bytesIO.writeBytes(path, data);
      } else {
        await uploadRemote(connectionId, path, data);
      }
    },
  };
}
