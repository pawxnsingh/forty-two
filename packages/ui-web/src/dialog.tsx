"use client";

import { XIcon } from "lucide-react";
import * as React from "react";
import {
  composeRenderProps,
  Dialog as DialogPrimitive,
  DialogTrigger as DialogTriggerPrimitive,
  Heading,
  Modal as ModalPrimitive,
  ModalOverlay as ModalOverlayPrimitive,
  Text,
  type DialogTriggerProps as DialogTriggerPrimitiveProps,
} from "react-aria-components";

import { Button } from "./button";
import { cn } from "./cn";

/**
 * A centered modal dialog.
 *
 * React Aria's ModalOverlay owns everything that is easy to get wrong and
 * hard to notice: focus moves in on open and back to the trigger on close,
 * the rest of the page is marked inert so a screen reader cannot walk out of
 * the dialog, scroll is locked, and the `dialog`/`alertdialog` role and the
 * `aria-labelledby`/`aria-describedby` pair are wired from the title and
 * description slots below.
 *
 * Three dismissal contracts, because the product needs all three:
 *
 * - `dismissible` (the default) — Escape and a backdrop click both close.
 * - `destructive` — same dismissal, but `alertdialog` semantics so the
 *   consequence is announced with the dialog rather than only on focus.
 * - `acknowledge` — for a value shown exactly once. Escape and the backdrop
 *   are both disabled, so the only way out is a control inside the dialog
 *   that records the acknowledgement. This is the one case where taking
 *   Escape away is correct: dismissing by reflex destroys a secret that
 *   cannot be retrieved again.
 *
 * The overlay is `overflow: clip`, not `auto`, and that is load-bearing. When
 * a control inside the dialog takes focus the browser scrolls it into view,
 * and that walks up *every* scrollable ancestor. Chrome reports this overlay
 * as scrollable — its `scrollHeight` picks up the body's scrollable overflow
 * even though the dialog clips it and fits the viewport — so ticking a
 * checkbox scrolled the overlay and carried the whole dialog off the top of
 * the screen. `clip` clips exactly as `hidden` did without making the element
 * a scroll container, so there is nothing left for the browser to scroll. The
 * dialog is height-clamped with its own scrolling body below, so the overlay
 * never needed to scroll in the first place.
 *
 * One thing React Aria does *not* do here: `Dialog` links its title through
 * `aria-labelledby`, but it has no description slot, so a `<Text
 * slot="description">` renders unlinked. The description is where the
 * consequence of a destructive action lives, so it is wired below — the id is
 * minted here and the header registers it once it actually renders something.
 */

interface DialogDescription {
  id: string;
  register: (present: boolean) => void;
}

const DialogDescriptionContext = React.createContext<DialogDescription | null>(null);

export type DialogMode = "dismissible" | "destructive" | "acknowledge";

function DialogTrigger(props: DialogTriggerPrimitiveProps) {
  return <DialogTriggerPrimitive {...props} />;
}

export interface DialogProps {
  /**
   * A render function receives React Aria's `close`, which is how a control
   * inside the dialog dismisses it without the consumer having to thread its
   * own open state back down.
   */
  children: React.ReactNode | ((options: { close: () => void }) => React.ReactNode);
  className?: string;
  /** Dismissal and role contract. Defaults to `dismissible`. */
  mode?: DialogMode;
  /**
   * Temporarily disable every implicit dismissal path. This keeps an ordinary
   * form or destructive confirmation mounted while its command is in flight,
   * without changing its role to the one-time-value `acknowledge` contract.
   */
  isDismissable?: boolean;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  /** Pins the token theme the console runs in, since the modal is portalled. */
  "data-theme"?: "light" | "dark";
  /** Wider composition for review and configuration forms. */
  size?: "default" | "wide";
}

function Dialog({
  children,
  className,
  "data-theme": dataTheme,
  defaultOpen,
  isDismissable = true,
  isOpen,
  mode = "dismissible",
  onOpenChange,
  size = "default",
}: DialogProps) {
  const acknowledge = mode === "acknowledge";
  const canDismiss = !acknowledge && isDismissable;
  const descriptionId = React.useId();
  const [hasDescription, setHasDescription] = React.useState(false);
  const description = React.useMemo<DialogDescription>(
    () => ({ id: descriptionId, register: setHasDescription }),
    [descriptionId],
  );

  return (
    <ModalOverlayPrimitive
      className="cn-dialog-overlay fixed inset-0 z-[90] grid place-items-center overflow-clip p-4 transition-opacity duration-exit data-entering:opacity-0 data-exiting:opacity-0 motion-reduce:transition-none"
      defaultOpen={defaultOpen}
      isDismissable={canDismiss}
      isKeyboardDismissDisabled={!canDismiss}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      render={(renderProps) => (
        <div {...renderProps} data-slot="dialog-overlay" data-theme={dataTheme} />
      )}
    >
      <ModalPrimitive
        className={cn(
          "cn-dialog-modal w-full outline-none transition-[opacity,transform] duration-enter ease-enter data-entering:translate-y-1 data-entering:opacity-0 data-exiting:opacity-0 motion-reduce:transform-none motion-reduce:transition-none",
          size === "wide" ? "max-w-[42.5rem]" : "max-w-[32.5rem]",
        )}
        data-slot="dialog-modal"
      >
        <DialogPrimitive
          aria-describedby={hasDescription ? descriptionId : undefined}
          className={cn("cn-dialog", className)}
          data-mode={mode}
          data-slot="dialog"
          role={mode === "dismissible" ? "dialog" : "alertdialog"}
        >
          {composeRenderProps(children, (resolved) => (
            <DialogDescriptionContext.Provider value={description}>
              {resolved}
            </DialogDescriptionContext.Provider>
          ))}
        </DialogPrimitive>
      </ModalPrimitive>
    </ModalOverlayPrimitive>
  );
}

export interface DialogHeaderProps {
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  /**
   * Close control in the corner. Omit it for `acknowledge` dialogs — an
   * escape hatch there would defeat the whole contract.
   */
  onClose?: () => void;
  closeLabel?: string;
  title: React.ReactNode;
}

function DialogHeader({
  children,
  className,
  closeLabel = "Close dialog",
  description,
  onClose,
  title,
}: DialogHeaderProps) {
  const descriptionContext = React.useContext(DialogDescriptionContext);
  const register = descriptionContext?.register;
  const present = description !== undefined && description !== null;
  React.useEffect(() => {
    if (register === undefined) return;
    register(present);
    return () => register(false);
  }, [present, register]);

  return (
    <header className={cn("cn-dialog-header", className)} data-slot="dialog-header">
      <div className="cn-dialog-heading">
        <Heading className="cn-dialog-title" slot="title">
          {title}
        </Heading>
        {description ? (
          <Text className="cn-dialog-description" id={descriptionContext?.id} slot="description">
            {description}
          </Text>
        ) : null}
        {children}
      </div>
      {onClose ? (
        <Button
          aria-label={closeLabel}
          className="cn-dialog-close"
          onPress={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </header>
  );
}

function DialogBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("cn-dialog-body", className)} data-slot="dialog-body">
      {children}
    </div>
  );
}

function DialogFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <footer className={cn("cn-dialog-footer", className)} data-slot="dialog-footer">
      {children}
    </footer>
  );
}

export { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTrigger };
