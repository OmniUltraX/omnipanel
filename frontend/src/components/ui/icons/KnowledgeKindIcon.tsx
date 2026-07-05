import { IconBook, IconFile, IconRobot, IconWrench } from "./Icons";

const KIND_ICONS = {
  all: IconBook,
  snippet: IconFile,
  case: IconWrench,
  ai: IconRobot,
} as const;

export type KnowledgeKind = keyof typeof KIND_ICONS;

interface KnowledgeKindIconProps {
  kind: string;
  size?: number;
  className?: string;
}

/** 知识库分类/条目类型图标。 */
export function KnowledgeKindIcon({ kind, size = 14, className }: KnowledgeKindIconProps) {
  const Icon = KIND_ICONS[kind as KnowledgeKind] ?? IconFile;
  const mergedClass = className ? `knowledge-kind-icon ${className}` : "knowledge-kind-icon";
  return <Icon size={size} className={mergedClass} />;
}
