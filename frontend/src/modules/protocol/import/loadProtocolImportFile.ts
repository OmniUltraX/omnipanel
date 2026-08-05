import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { isTauriRuntime } from "../../../lib/isTauriRuntime";
import { parseProtocolImportText } from "./parseProtocolImport";
import type { ProtocolImportDocument } from "./protocolImportTypes";

async function pickJsonWithInput(): Promise<{ text: string; fileName: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          text: typeof reader.result === "string" ? reader.result : "",
          fileName: file.name,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

/** 选择并解析协议导入文件（Apifox 等）。 */
export async function loadProtocolImportDocument(): Promise<{
  fileName: string;
  document: ProtocolImportDocument;
} | null> {
  let text = "";
  let fileName = "import.json";

  if (isTauriRuntime()) {
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        { name: "API Export", extensions: ["json"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (!picked || Array.isArray(picked)) {
      return null;
    }
    text = await readTextFile(picked);
    fileName = picked.split(/[/\\]/).pop() ?? fileName;
  } else {
    const picked = await pickJsonWithInput();
    if (!picked) return null;
    text = picked.text;
    fileName = picked.fileName;
  }

  const document = parseProtocolImportText(text);
  return { fileName, document };
}
