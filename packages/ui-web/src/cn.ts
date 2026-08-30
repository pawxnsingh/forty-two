import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Adapted from shadcn/ui's installable utils source at commit
// 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
