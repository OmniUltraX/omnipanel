import onePanelIcon from "../../assets/icons/1Panel.svg";
import baotaIcon from "../../assets/icons/Baota.svg";
import aliyunIcon from "../../assets/icons/Aliyun.svg";
import dockerIcon from "../../assets/icons/docker.svg";

/** 第三方 / 面板品牌图标（侧栏树、引擎选择等复用）。 */
export type BrandIconKind = "bt" | "1panel" | "aliyun" | "docker";

const BRAND_ICONS: Record<BrandIconKind, string> = {
  bt: baotaIcon,
  "1panel": onePanelIcon,
  aliyun: aliyunIcon,
  docker: dockerIcon,
};

export function getBrandIcon(kind: BrandIconKind): string {
  return BRAND_ICONS[kind];
}

export function resolvePanelBrandIcon(
  serviceType: string | null | undefined,
): BrandIconKind | null {
  const raw = (serviceType ?? "").trim().toLowerCase();
  if (raw === "bt" || raw === "baota") return "bt";
  if (raw === "1panel" || raw === "onepanel") return "1panel";
  return null;
}

export function BrandIconImg({
  kind,
  size = 13,
  className = "server-tree-brand-icon",
  title,
}: {
  kind: BrandIconKind;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <img
      src={getBrandIcon(kind)}
      alt=""
      width={size}
      height={size}
      className={className}
      title={title}
      aria-hidden
      draggable={false}
    />
  );
}
