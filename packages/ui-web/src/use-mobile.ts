import * as React from "react";

// Adapted from shadcn/ui's React Aria use-mobile hook at commit
// 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

export function useIsMobile(mobileBreakpoint = 768) {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    try {
      if (typeof window.matchMedia !== "function") return;
      const query = window.matchMedia(`(max-width: ${mobileBreakpoint - 1}px)`);
      const update = () => setIsMobile(query.matches);

      update();
      query.addEventListener?.("change", update);
      return () => query.removeEventListener?.("change", update);
    } catch {
      setIsMobile(false);
    }
  }, [mobileBreakpoint]);

  return isMobile;
}
