"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import type * as React from "react";
import {
  Checkbox as CheckboxPrimitive,
  CheckboxGroup as CheckboxGroupPrimitive,
  composeRenderProps,
  FieldError as FieldErrorPrimitive,
  Label,
  Text,
  type CheckboxGroupProps as CheckboxGroupPrimitiveProps,
  type CheckboxProps as CheckboxPrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * A checkbox, and a group of them under one accessible name.
 *
 * React Aria renders a visually hidden native input and owns the mixed state,
 * so the drawn box below is decoration: the semantics a screen reader reports
 * come from the real control, not from `aria-checked` written by hand. The
 * group carries the label, description and validation for a multi-select
 * choice — permissions and event subscriptions here — so the set is announced
 * as one field rather than as loose adjacent checkboxes.
 */

export interface CheckboxProps extends Omit<CheckboxPrimitiveProps, "className"> {
  className?: string;
}

function Checkbox({ children, className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive
      data-slot="checkbox"
      className={composeRenderProps(className, (className) => cn("cn-checkbox", className))}
      {...props}
    >
      {composeRenderProps(children, (children, { isIndeterminate, isSelected }) => (
        <>
          <span aria-hidden="true" className="cn-checkbox-control">
            {isIndeterminate ? (
              <MinusIcon className="cn-checkbox-mark" />
            ) : isSelected ? (
              <CheckIcon className="cn-checkbox-mark" />
            ) : null}
          </span>
          {children ? <span className="cn-checkbox-content">{children}</span> : null}
        </>
      ))}
    </CheckboxPrimitive>
  );
}

export interface CheckboxGroupProps extends Omit<CheckboxGroupPrimitiveProps, "className"> {
  /** The group's accessible name. Rendered unless `aria-label` is supplied. */
  label?: React.ReactNode;
  /** Supporting copy announced with the group. */
  description?: React.ReactNode;
  errorMessage?: React.ComponentProps<typeof FieldErrorPrimitive>["children"];
  className?: string;
}

function CheckboxGroup({
  children,
  className,
  description,
  errorMessage,
  label,
  ...props
}: CheckboxGroupProps) {
  return (
    <CheckboxGroupPrimitive
      data-slot="checkbox-group"
      className={composeRenderProps(className, (className) => cn("cn-checkbox-group", className))}
      {...props}
    >
      {composeRenderProps(children, (children) => (
        <>
          {label ? <Label className="cn-field-label">{label}</Label> : null}
          {description ? (
            <Text className="cn-field-description" slot="description">
              {description}
            </Text>
          ) : null}
          <div className="cn-checkbox-group-items">{children}</div>
          <FieldErrorPrimitive className="cn-field-error">{errorMessage}</FieldErrorPrimitive>
        </>
      ))}
    </CheckboxGroupPrimitive>
  );
}

export { Checkbox, CheckboxGroup };
