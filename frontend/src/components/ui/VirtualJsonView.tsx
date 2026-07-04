import { cn } from "../../lib/utils";

export interface VirtualJsonViewProps {
  value: object;
  className?: string;
}

export function VirtualJsonView({
  value,
  className,
}: VirtualJsonViewProps) {
  return (
    <pre className={cn("virtual-json-view", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
