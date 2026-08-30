"use client";

// Adapted from shadcn/ui's React Aria separator and Nova style sources at
// commit 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

import { Separator as SeparatorPrimitive } from "react-aria-components";

import { cn } from "./cn";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive>) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "cn-separator block shrink-0 border-0 aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=vertical]:w-px aria-[orientation=vertical]:self-stretch [:is(hr)]:h-px [:is(hr)]:w-full",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
