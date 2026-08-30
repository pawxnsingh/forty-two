"use client";

import type { ReactNode } from "react";
import { Dialog } from "react-aria-components/Dialog";
import { Modal, ModalOverlay } from "react-aria-components/Modal";

import { cn } from "./cn";

export interface DrawerProps {
  "aria-label": string;
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  side?: "left" | "right";
}

export function Drawer({
  "aria-label": ariaLabel,
  children,
  className,
  isOpen,
  onOpenChange,
  side = "left",
}: DrawerProps) {
  return (
    <ModalOverlay
      isDismissable
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className="fixed inset-0 z-50 flex bg-scrim outline-none transition-colors duration-enter ease-enter data-[entering]:bg-transparent data-[exiting]:bg-transparent motion-reduce:transition-none"
    >
      <Modal
        className={cn(
          "h-dvh w-[min(20rem,calc(100vw-2rem))] overflow-hidden bg-surface-raised shadow-[0_1rem_4rem_color-mix(in_srgb,var(--op-brand-emphasized)_20%,transparent)] outline-none transition-transform duration-enter ease-enter motion-reduce:transform-none motion-reduce:transition-none forced-colors:border forced-colors:border-[CanvasText]",
          side === "left"
            ? "data-[entering]:-translate-x-full data-[exiting]:-translate-x-full"
            : "ml-auto data-[entering]:translate-x-full data-[exiting]:translate-x-full",
          className,
        )}
      >
        <Dialog aria-label={ariaLabel} className="h-full outline-none">
          {({ close }) => (typeof children === "function" ? children(close) : children)}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
