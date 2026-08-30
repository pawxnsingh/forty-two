// Adapted from shadcn/ui's React Aria-compatible skeleton and Nova style sources at
// commit 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

import { cn } from "./cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("cn-skeleton animate-pulse motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
