"use client";

import type * as React from "react";
import {
  composeRenderProps,
  Label,
  ProgressBar as ProgressBarPrimitive,
  type ProgressBarProps as ProgressBarPrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * Determinate or indeterminate progress.
 *
 * React Aria owns the `role="progressbar"` semantics and the `aria-valuetext`
 * string, so a screen reader announces "62 percent" rather than reading a
 * decorative bar. Omitting `value` yields the indeterminate presentation,
 * which is the honest state while a byte count is still unknown.
 */

export interface ProgressBarProps extends Omit<ProgressBarPrimitiveProps, "className"> {
  /** The bar's accessible name. Rendered unless `aria-label` is supplied. */
  label?: React.ReactNode;
  /** Shows the formatted value beside the label. */
  showValue?: boolean;
  className?: string;
}

function ProgressBar({ className, label, showValue = false, ...props }: ProgressBarProps) {
  return (
    <ProgressBarPrimitive
      data-slot="progress-bar"
      className={composeRenderProps(className, (className) => cn("cn-progress-bar", className))}
      {...props}
    >
      {({ percentage, valueText, isIndeterminate }) => (
        <>
          {label || showValue ? (
            <div className="cn-progress-bar-header">
              {label ? <Label className="cn-progress-bar-label">{label}</Label> : null}
              {showValue && valueText ? (
                <span className="cn-progress-bar-value">{valueText}</span>
              ) : null}
            </div>
          ) : null}
          <div className="cn-progress-bar-track">
            <div
              className="cn-progress-bar-fill"
              data-indeterminate={isIndeterminate || undefined}
              style={isIndeterminate ? undefined : { width: `${percentage ?? 0}%` }}
            />
          </div>
        </>
      )}
    </ProgressBarPrimitive>
  );
}

export { ProgressBar };
