/** 从 compose 文件绝对路径拆出工作目录、文件名与默认项目名。 */
export function splitComposeFilePath(filePath: string): {
  workingDir: string;
  configFile: string;
  project: string;
} {
  const trimmed = filePath.trim();
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const workingDir = idx >= 0 ? trimmed.slice(0, idx) : ".";
  const configFile = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const dirParts = workingDir.split(/[/\\]/).filter(Boolean);
  const project = dirParts[dirParts.length - 1] || "compose";
  return { workingDir, configFile, project };
}
