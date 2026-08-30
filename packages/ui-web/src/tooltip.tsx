"use client";

// Adapted from shadcn/ui's React Aria tooltip and Nova style sources at
// commit 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

import * as React from "react";
import {
  Focusable,
  OverlayArrow,
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "react-aria-components";

import { cn } from "./cn";

export type TooltipTriggerProps = React.ComponentProps<typeof TooltipTriggerPrimitive>;

function TooltipTrigger({ delay = 0, children, ...props }: TooltipTriggerProps) {
  const [trigger, tooltip] = React.Children.toArray(children);

  return (
    <TooltipTriggerPrimitive data-slot="tooltip-trigger" delay={delay} {...props}>
      <Focusable>{trigger as React.ComponentProps<typeof Focusable>["children"]}</Focusable>
      {tooltip}
    </TooltipTriggerPrimitive>
  );
}

export type TooltipProps = Omit<
  React.ComponentProps<typeof TooltipPrimitive>,
  "children" | "className"
> & {
  "data-theme"?: "light" | "dark";
  className?: string;
  children?: React.ReactNode;
};

function Tooltip({
  className,
  placement = "top",
  offset = 4,
  crossOffset = 0,
  children,
  "data-theme": dataTheme,
  ...props
}: TooltipProps) {
  return (
    <TooltipPrimitive
      placement={placement}
      offset={offset}
      crossOffset={crossOffset}
      className={cn(
        "cn-tooltip-content-aria z-50 w-fit max-w-xs origin-(--trigger-anchor-point) bg-surface-inverse text-foreground-inverse motion-reduce:transition-none",
        className,
      )}
      render={(renderProps) => (
        <div {...renderProps} data-slot="tooltip-content" data-theme={dataTheme} />
      )}
      {...props}
    >
      {children}
      <OverlayArrow
        className="cn-tooltip-arrow z-50 bg-surface-inverse fill-[var(--op-surface-inverse)]"
        style={({ placement: arrowPlacement, defaultStyle }) => ({
          ...defaultStyle,
          rotate: "0deg",
          translate: "0 0",
          transform:
            arrowPlacement === "bottom"
              ? "translate(-50%, calc(50% + 2px)) rotate(45deg)"
              : arrowPlacement === "top"
                ? "translate(-50%, calc(-50% - 2px)) rotate(45deg)"
                : arrowPlacement === "left"
                  ? "translate(calc(-50% - 2px), -50%) rotate(45deg)"
                  : "translate(calc(50% + 2px), -50%) rotate(45deg)",
        })}
      />
    </TooltipPrimitive>
  );
}

export { Tooltip, TooltipTrigger };
