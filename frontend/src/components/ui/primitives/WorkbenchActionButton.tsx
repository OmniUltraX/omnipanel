import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";
import { headerActionButtonClass } from "./headerActionButton";

type ButtonProps = ComponentProps<typeof Button>;

export type WorkbenchActionButtonProps = Omit<ButtonProps, "variant" | "size"> & {
  danger?: boolean;
  icon?: boolean;
};

/** 工作台操作：统一扁矩形；悬停白底细描边，对齐 SSH 页头。 */
export function WorkbenchActionButton({
  danger = false,
  icon = false,
  className,
  type = "button",
  ...props
}: WorkbenchActionButtonProps) {
  return (
    <Button
      {...props}
      type={type}
      variant={icon ? "icon" : "ghost"}
      size={icon ? "icon-xs" : "xs"}
      className={cn(headerActionButtonClass(danger), className)}
    />
  );
}
