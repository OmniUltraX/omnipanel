import {
  parseResourceTag,
  sortTagsForDisplay,
  type ResourceTagKey,
} from "../../../lib/resourceTags";

type Props = {
  tags?: string[];
  /** 只展示指定键（如列表行只显示 os＀*/
  keys?: ResourceTagKey[];
  /** compact：列表行；detail：详情头 */
  variant?: "compact" | "detail";
  className?: string;
};

function tagClassName(key: string, variant: "compact" | "detail"): string {
  const base = variant === "detail" ? "resource-tag resource-tag--detail" : "resource-tag";
  if (key === "os") return `${base} resource-tag--os`;
  if (key === "kernel") return `${base} resource-tag--kernel`;
  if (key === "arch") return `${base} resource-tag--arch`;
  return `${base} resource-tag--custom`;
}

export function ResourceTags({
  tags,
  keys,
  variant = "compact",
  className,
}: Props) {
  if (!tags?.length) return null;

  let visible = sortTagsForDisplay(tags);
  if (keys?.length) {
    const allowed = new Set(keys.map((k) => `${k}:`));
    visible = visible.filter((t) => {
      const { key } = parseResourceTag(t);
      return allowed.has(`${key}:`) || keys.includes(key);
    });
  }
  if (!visible.length) return null;

  return (
    <span className={["resource-tags", className].filter(Boolean).join(" ")}>
      {visible.map((tag) => {
        const { key, value } = parseResourceTag(tag);
        return (
          <span
            key={tag}
            className={tagClassName(key, variant)}
            title={key === "custom" ? value : `${key}: ${value}`}
          >
            {value}
          </span>
        );
      })}
    </span>
  );
}
