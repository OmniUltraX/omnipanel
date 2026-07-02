import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { isTauriRuntime } from "../../../lib/isTauriRuntime";
import type { DbConnectionConfig } from "../api";
import { buildNavicatImportPreview } from "./buildImportPreview";
import { parseNavicatNcx } from "./parseNavicatNcx";
import type { NavicatImportPreviewItem } from "./types";

export async function decryptNavicatPasswords(ciphertexts: string[]): Promise<string[]> {
  if (ciphertexts.length === 0) {
    return [];
  }
  if (isTauriRuntime()) {
    return invoke<string[]>("decrypt_navicat_passwords", { ciphertexts });
  }
  return ciphertexts.map(() => "");
}

async function pickNcxFileWithInput(): Promise<{ text: string; fileName: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ncx,.xml,text/xml,application/xml";
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

export async function loadNavicatImportPreview(
  existingConnections: DbConnectionConfig[],
): Promise<{ fileName: string; items: NavicatImportPreviewItem[] } | null> {
  let text = "";
  let fileName = "connections.ncx";

  if (isTauriRuntime()) {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Navicat Connections", extensions: ["ncx", "xml"] }],
    });
    if (!picked || Array.isArray(picked)) {
      return null;
    }
    text = await readTextFile(picked);
    fileName = picked.split(/[/\\]/).pop() ?? fileName;
  } else {
    const picked = await pickNcxFileWithInput();
    if (!picked) {
      return null;
    }
    text = picked.text;
    fileName = picked.fileName;
  }

  const rawItems = parseNavicatNcx(text);
  if (rawItems.length === 0) {
    throw new Error("EMPTY");
  }

  const ciphertexts = rawItems.map((item) =>
    item.savePassword && item.encryptedPassword.trim() ? item.encryptedPassword : "",
  );
  const decrypted = await decryptNavicatPasswords(ciphertexts);
  const items = buildNavicatImportPreview(rawItems, decrypted, existingConnections);
  return { fileName, items };
}
