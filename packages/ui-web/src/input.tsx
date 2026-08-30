"use client";

// Adapted from shadcn/ui's React Aria input and Nova style sources at
// commit 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

import * as React from "react";
import { composeRenderProps, Input as InputPrimitive } from "react-aria-components";

import { cn } from "./cn";

function Input({ className, type, ...props }: React.ComponentProps<typeof InputPrimitive>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={composeRenderProps(className, (className) =>
        cn(
          "cn-input w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-foreground-muted disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        ),
      )}
      {...props}
    />
  );
}

export { Input };
