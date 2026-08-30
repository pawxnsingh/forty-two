"use client";

import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import type * as React from "react";
import {
  Button as ButtonPrimitive,
  composeRenderProps,
  FieldError as FieldErrorPrimitive,
  Label,
  ListBox as ListBoxPrimitive,
  ListBoxItem as ListBoxItemPrimitive,
  Popover as PopoverPrimitive,
  Select as SelectPrimitive,
  SelectValue as SelectValuePrimitive,
  Text,
  type ListBoxItemProps as ListBoxItemPrimitiveProps,
  type SelectProps as SelectPrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * A single-choice picker composed from React Aria's Select, Popover and
 * ListBox.
 *
 * Not a native `<select>`: the console needs option rows that carry a
 * secondary line (a machine value beside a friendly name) and a popover that
 * matches the surrounding surfaces. React Aria keeps what a native select
 * gives for free — typeahead, arrow-key movement, `aria-activedescendant`,
 * the `listbox` role, focus return to the trigger on close — so none of that
 * is re-implemented here.
 */

export interface SelectProps<T extends object> extends Omit<
  SelectPrimitiveProps<T>,
  "className" | "children"
> {
  children: React.ReactNode | ((item: T) => React.ReactNode);
  /** The field's accessible name. Rendered unless `aria-label` is supplied. */
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ComponentProps<typeof FieldErrorPrimitive>["children"];
  items?: Iterable<T>;
  /** Placeholder shown while nothing is selected. */
  placeholder?: string;
  className?: string;
}

function Select<T extends object>({
  children,
  className,
  description,
  errorMessage,
  items,
  label,
  placeholder,
  ...props
}: SelectProps<T>) {
  return (
    <SelectPrimitive
      data-slot="select"
      className={composeRenderProps(className, (className) => cn("cn-field", className))}
      {...props}
    >
      {label ? <Label className="cn-field-label">{label}</Label> : null}
      {description ? (
        <Text className="cn-field-description" slot="description">
          {description}
        </Text>
      ) : null}
      <ButtonPrimitive className="cn-select-trigger" data-slot="select-trigger">
        <SelectValuePrimitive className="cn-select-value">
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder ? (placeholder ?? defaultChildren) : defaultChildren
          }
        </SelectValuePrimitive>
        <ChevronsUpDownIcon aria-hidden="true" className="cn-select-icon" />
      </ButtonPrimitive>
      <FieldErrorPrimitive className="cn-field-error">{errorMessage}</FieldErrorPrimitive>
      <PopoverPrimitive className="cn-select-popover" data-slot="select-popover" offset={4}>
        <ListBoxPrimitive className="cn-select-listbox" items={items}>
          {children}
        </ListBoxPrimitive>
      </PopoverPrimitive>
    </SelectPrimitive>
  );
}

export interface SelectItemProps extends Omit<ListBoxItemPrimitiveProps, "className"> {
  className?: string;
  /** Secondary line under the option's name — a machine value, say. */
  detail?: React.ReactNode;
}

function SelectItem({ children, className, detail, textValue, ...props }: SelectItemProps) {
  return (
    <ListBoxItemPrimitive
      data-slot="select-item"
      className={composeRenderProps(className, (className) => cn("cn-select-item", className))}
      /**
       * Type-to-select needs a string, and this component always wraps its
       * children in spans and an indicator — so from the collection's point of
       * view every option had non-plain-text children and none of them could be
       * typed to, no matter what the caller passed as children. React Aria says
       * so on the console at render time.
       *
       * The option's own text is the answer whenever it is text. An explicit
       * `textValue` still wins, and an option built out of elements still has
       * to supply one.
       */
      textValue={textValue ?? (typeof children === "string" ? children : undefined)}
      {...props}
    >
      {composeRenderProps(children, (children, { isSelected }) => (
        <>
          <span className="cn-select-item-content">
            <span>{children}</span>
            {detail ? <span className="cn-select-item-detail">{detail}</span> : null}
          </span>
          {isSelected ? (
            <CheckIcon aria-hidden="true" className="cn-select-item-indicator" />
          ) : null}
        </>
      ))}
    </ListBoxItemPrimitive>
  );
}

export { Select, SelectItem };
