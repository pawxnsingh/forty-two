"use client";

import { XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "./button";
import { cn } from "./cn";

/**
 * Transient notifications with a live region, a queue, and pause-on-attention.
 *
 * **This is not a React Aria component.** React Aria Components 1.20 ships no
 * Toast primitive, so unlike every other wrapper in this package the behaviour
 * below is ours and carries no upstream accessibility guarantees. It is written
 * out rather than faked with a `role="alert"` div because the three things that
 * make a toast usable are all things a bare div gets wrong:
 *
 * 1. **Announcement.** Each toast picks its own politeness. Routine
 *    confirmations are `status`/polite so they wait for a gap in speech;
 *    failures are `alert`/assertive because a silently-lost error is worse than
 *    an interruption. The region itself is a labelled landmark, so a screen
 *    reader user can navigate back to messages they missed.
 * 2. **Pause on hover and focus.** A toast that dismisses itself while being
 *    read or reached for is a trap — the classic case is a message carrying a
 *    link that vanishes as the pointer arrives. Hovering the region, or moving
 *    focus into it, freezes every timer and banks the remaining time; leaving
 *    resumes from where it stopped rather than restarting.
 * 3. **A bounded queue.** Bursts collapse to the newest few instead of
 *    covering the page, and each toast is individually dismissible from the
 *    keyboard.
 *
 * Timers stop entirely while the document is hidden, so a toast queued in a
 * background tab is still there when the tab is looked at again.
 */

export type ToastVariant = "info" | "success" | "danger";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds on screen. `null` keeps it until dismissed. */
  duration?: number | null;
}

interface ToastRecord extends ToastOptions {
  id: string;
  variant: ToastVariant;
  duration: number | null;
  /** Time left before auto-dismiss, banked whenever the queue is paused. */
  remaining: number | null;
}

export interface ToastHandle {
  /** Queue a toast and return its id, so a caller can dismiss it early. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastHandle | null>(null);

/** Default dwell time. Long enough to read two lines without rushing. */
const DEFAULT_DURATION_MS = 6_000;
/** Failures stay longer: they usually carry something to act on. */
const DANGER_DURATION_MS = 10_000;
/** Beyond this the oldest is dropped rather than stacking over the page. */
const MAX_VISIBLE = 3;
const TICK_MS = 100;

export function useToast(): ToastHandle {
  const handle = React.useContext(ToastContext);
  if (handle === null) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return handle;
}

export interface ToastProviderProps {
  children: React.ReactNode;
  /** Accessible name of the notification landmark. */
  label?: string;
  /** Pins the token theme, since the region is fixed above the page. */
  "data-theme"?: "light" | "dark";
}

function ToastProvider({
  children,
  "data-theme": dataTheme,
  label = "Notifications",
}: ToastProviderProps) {
  const [toasts, setToasts] = React.useState<readonly ToastRecord[]>([]);
  const [paused, setPaused] = React.useState(false);

  const dismiss = React.useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = React.useCallback((options: ToastOptions) => {
    const variant = options.variant ?? "info";
    const duration =
      options.duration === undefined
        ? variant === "danger"
          ? DANGER_DURATION_MS
          : DEFAULT_DURATION_MS
        : options.duration;
    const id = `toast-${globalThis.crypto.randomUUID()}`;
    setToasts((current) =>
      [...current, { ...options, duration, id, remaining: duration, variant }].slice(-MAX_VISIBLE),
    );
    return id;
  }, []);

  const handle = React.useMemo<ToastHandle>(() => ({ dismiss, toast }), [dismiss, toast]);

  // One interval for the whole queue rather than a timer per toast: a timer
  // per toast has to be torn down and rebuilt on every pause, which is exactly
  // where "resumed" timers drift or get lost.
  const running = !paused && toasts.some((entry) => entry.remaining !== null);
  React.useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      // A hidden tab should not burn through the queue unseen.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setToasts((current) => {
        const next = current.map((entry) =>
          entry.remaining === null
            ? entry
            : { ...entry, remaining: Math.max(0, entry.remaining - TICK_MS) },
        );
        return next.filter((entry) => entry.remaining === null || entry.remaining > 0);
      });
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [running]);

  return (
    <ToastContext.Provider value={handle}>
      {children}
      <div
        aria-label={label}
        className="cn-toast-region"
        data-paused={paused ? "" : undefined}
        data-slot="toast-region"
        data-theme={dataTheme}
        // Hover and focus both mean "someone is attending to this", and both
        // must stop the clock. `focus` is the keyboard half of the same idea.
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
        }}
        onFocus={() => setPaused(true)}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        role="region"
      >
        {toasts.map((entry) => (
          <div
            className={cn("cn-toast", `cn-toast--${entry.variant}`)}
            data-slot="toast"
            data-variant={entry.variant}
            key={entry.id}
            // Polite for routine confirmations, assertive for failures. The
            // role is what carries this; `aria-live` would duplicate it.
            role={entry.variant === "danger" ? "alert" : "status"}
          >
            <div className="cn-toast-content">
              <p className="cn-toast-title">{entry.title}</p>
              {entry.description ? (
                <p className="cn-toast-description">{entry.description}</p>
              ) : null}
            </div>
            <Button
              aria-label={`Dismiss: ${entry.title}`}
              className="cn-toast-dismiss"
              onPress={() => dismiss(entry.id)}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export { ToastProvider };
