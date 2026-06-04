import { APP_LOGO_SRC } from "../../lib/appBrand";

export interface AppLogoProps {
  size?: number;
  className?: string;
}

export function AppLogo({ size = 36, className }: AppLogoProps) {
  return (
    <img
      src={APP_LOGO_SRC}
      alt=""
      width={size}
      height={size}
      className={className ?? "app-logo"}
      draggable={false}
    />
  );
}
