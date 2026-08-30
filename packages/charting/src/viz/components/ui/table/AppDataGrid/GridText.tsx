import type { PropsWithChildren } from "react";
import { cn } from "@viz/lib/classMerge";

export const Text: React.FC<PropsWithChildren<{ className?: string }>> = ({
  children,
  className,
}) => {
  return (
    <span className={cn("text-foreground text-body", className)}>
      {children}
    </span>
  );
};
