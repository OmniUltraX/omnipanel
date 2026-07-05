import type { ReactElement, ReactNode } from "react";
import {
  IconBook,
  IconCompose,
  IconContainer,
  IconDocker,
  IconFile,
  IconFolder,
  IconImage,
  IconInbox,
  IconNetwork,
  IconRobot,
  IconVolume,
} from "../icons/Icons";

export type EmptyStatePreset =
  | "container"
  | "image"
  | "compose"
  | "network"
  | "volume"
  | "folder"
  | "file"
  | "book"
  | "robot"
  | "docker"
  | "inbox"
  | "document";

const PRESET_ICONS: Record<
  EmptyStatePreset,
  (props: { size?: number; className?: string }) => ReactElement
> = {
  container: IconContainer,
  image: IconImage,
  compose: IconCompose,
  network: IconNetwork,
  volume: IconVolume,
  folder: IconFolder,
  file: IconFile,
  book: IconBook,
  robot: IconRobot,
  docker: IconDocker,
  inbox: IconInbox,
  document: IconFile,
};

export interface ModuleEmptyStateProps {
  preset?: EmptyStatePreset;
  icon?: ReactNode;
  title: string;
  desc?: string;
  className?: string;
}

/** 模块内空状态：线性 SVG 图标 + 标题/描述，与 Shell 侧栏风格一致。 */
export function ModuleEmptyState({ preset, icon, title, desc, className }: ModuleEmptyStateProps) {
  const IconComponent = preset ? PRESET_ICONS[preset] : null;

  return (
    <div className={`module-empty-state${className ? ` ${className}` : ""}`}>
      <div className="module-empty-state__icon-wrap" aria-hidden>
        {icon ??
          (IconComponent ? (
            <IconComponent size={36} className="module-empty-state__icon" />
          ) : null)}
      </div>
      <div className="module-empty-state__title">{title}</div>
      {desc ? <div className="module-empty-state__desc">{desc}</div> : null}
    </div>
  );
}
