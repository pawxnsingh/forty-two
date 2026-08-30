"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * The content width of a chart's own box.
 *
 * Charts whose marks are laid out edge-to-edge — bars sharing a fixed gap
 * rather than sitting inside proportional bands — need a real pixel width
 * before they can place anything, so measurement belongs to the wrapper
 * rather than to the page. Returns `null` until the first measurement, which
 * is the caller's cue to render nothing rather than something wrong.
 */
export function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const read = () => setWidth(element.getBoundingClientRect().width || null);
    read();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
