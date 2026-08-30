"use client";

// Adapted from shadcn/ui's React Aria Collapsible source at commit
// 9846e22ce52c723554742860a0dbd3e5cf19b573. See ../LICENSE.shadcn-ui.

import {
  Button as CollapsibleTriggerPrimitive,
  Disclosure as CollapsiblePrimitive,
  DisclosurePanel as CollapsibleContentPrimitive,
  type ButtonProps,
  type DisclosurePanelProps,
  type DisclosureProps,
} from "react-aria-components";

function Collapsible({ ...props }: DisclosureProps) {
  return <CollapsiblePrimitive data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: ButtonProps) {
  return <CollapsibleTriggerPrimitive slot="trigger" data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ ...props }: DisclosurePanelProps) {
  return <CollapsibleContentPrimitive data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
