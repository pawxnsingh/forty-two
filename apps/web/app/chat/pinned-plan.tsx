"use client";

import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleDotDashed,
  CircleX,
} from "lucide-react";
import { useState } from "react";
import styles from "./chat.module.css";

export interface PinnedPlanItem {
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  summary?: string;
  text: string;
}

export interface PinnedPlanValue {
  items: PinnedPlanItem[];
  title: string;
}

type PlanStatus = PinnedPlanItem["status"];

function rollupStatus(items: PinnedPlanItem[], running: boolean): PlanStatus {
  if (items.some((item) => item.status === "failed")) return "failed";
  if (running || items.some((item) => item.status === "in_progress")) {
    return "in_progress";
  }
  if (
    items.length > 0 &&
    items.every(
      (item) => item.status === "completed" || item.status === "skipped",
    )
  ) {
    return "completed";
  }
  return "pending";
}

function StatusIcon({ status }: { status: PlanStatus }) {
  if (status === "completed") return <CheckCircle2 aria-hidden="true" />;
  if (status === "in_progress") return <CircleDotDashed aria-hidden="true" />;
  if (status === "failed") return <CircleX aria-hidden="true" />;
  if (status === "skipped") return <CircleAlert aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

export function PinnedPlan({
  plan,
  running,
}: {
  plan: PinnedPlanValue;
  running: boolean;
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? running;
  const status = rollupStatus(plan.items, running);
  const completed = plan.items.filter(
    (item) => item.status === "completed",
  ).length;
  const statusLabel =
    status === "in_progress"
      ? "Working"
      : status === "completed"
        ? "Complete"
        : status === "failed"
          ? "Needs attention"
          : "Ready";

  return (
    <section
      className={styles.pinnedPlan}
      data-open={open || undefined}
      data-status={status}
    >
      <button
        aria-expanded={open}
        onClick={() => setOpenOverride(!open)}
        type="button"
      >
        <StatusIcon status={status} />
        <span className={styles.planHeading}>
          <small>{statusLabel}</small>
          <strong>{plan.title || "Plan"}</strong>
        </span>
        <span className={styles.planCount}>
          {completed}/{plan.items.length}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>

      <progress
        aria-label={`${completed} of ${plan.items.length} plan steps complete`}
        max={Math.max(plan.items.length, 1)}
        value={completed}
      />

      <div className={styles.pinnedPlanBody}>
        <div>
          <ol>
            {plan.items.map((item, index) => (
              <li data-status={item.status} key={`${index}-${item.text}`}>
                <span>
                  <StatusIcon status={item.status} />
                </span>
                <div>
                  <p>{item.text}</p>
                  {item.summary ? <small>{item.summary}</small> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
