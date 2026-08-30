"use client";

import type { ReactNode } from "react";

/**
 * The two states a chart can be in that are not "here is the data".
 *
 * Both are deliberately plain: they carry the reason and, where one exists,
 * the next action — and nothing else. A chart that cannot be drawn must not
 * be replaced by something that looks like a drawn chart.
 */

export interface OpChartEmptyStateProps {
  /** What has not happened yet, in the product's own words. */
  readonly message: string;
  /** The action that would produce data, when there is one. */
  readonly action?: ReactNode;
  readonly className?: string;
}

export function OpChartEmptyState({ message, action, className }: OpChartEmptyStateProps) {
  return (
    <div className={className} data-op-chart-state="empty">
      <p data-op-chart-state-message="">{message}</p>
      {action}
    </div>
  );
}

export interface OpChartUnavailableStateProps {
  /** Why the values cannot be shown. Never a guess and never a zero. */
  readonly message: string;
  /** The period the gap covers, when the caller knows it. */
  readonly affectedPeriod?: string;
  /** Whether waiting and retrying will resolve it. */
  readonly retryable?: boolean;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function OpChartUnavailableState({
  message,
  affectedPeriod,
  retryable,
  action,
  className,
}: OpChartUnavailableStateProps) {
  return (
    <div
      className={className}
      data-op-chart-retryable={retryable === undefined ? undefined : String(retryable)}
      data-op-chart-state="unavailable"
      role="status"
    >
      <p data-op-chart-state-message="">{message}</p>
      {affectedPeriod ? <p data-op-chart-state-period="">{affectedPeriod}</p> : null}
      {action}
    </div>
  );
}
