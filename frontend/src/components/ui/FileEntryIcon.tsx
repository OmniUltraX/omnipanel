import { IconLink } from "./Icons";
import {
  DOTEXT_FOLDER_ICON_URL,
  resolveFileExtensionIconUrl,
} from "../../lib/fileExtensionIcon";

export type FileEntryType = "dir" | "file" | "symlink";

interface FileEntryIconProps {
  type: FileEntryType;
  /** 文件名，用于匹配 dotext 后缀图标 */
  fileName?: string;
  size?: number;
  className?: string;
}

function DotextIcon({ src, size, className }: { src: string; size: number; className: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`${className} file-ext-icon`}
      draggable={false}
    />
  );
}

/** 文件/目录/符号链接行内图标，SFTP 与 Docker 文件浏览共用。 */
export function FileEntryIcon({ type, fileName, size = 14, className }: FileEntryIconProps) {
  const mergedClass = className ? `file-entry-icon ${className}` : "file-entry-icon";

  if (type === "symlink") {
    return <IconLink size={size} className={mergedClass} />;
  }

  if (type === "dir") {
    return (
      <DotextIcon src={DOTEXT_FOLDER_ICON_URL} size={size} className={mergedClass} />
    );
  }

  return (
    <DotextIcon
      src={resolveFileExtensionIconUrl(fileName)}
      size={size}
      className={mergedClass}
    />
  );
}
