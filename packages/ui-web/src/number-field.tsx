"use client";

import { MinusIcon, PlusIcon } from "lucide-react";
import type * as React from "react";
import {
  Button as ButtonPrimitive,
  composeRenderProps,
  FieldError as FieldErrorPrimitive,
  Group,
  Input as InputPrimitive,
  Label,
  NumberField as NumberFieldPrimitive,
  Text,
  type NumberFieldProps as NumberFieldPrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * A bounded numeric field with stepper controls.
 *
 * Delivery limits are integers inside a server-declared range, and React Aria
 * enforces `minValue`/`maxValue`/`step` on typing, stepping, scrolling and
 * blur alike, announcing the clamped value. It also keeps the two stepper
 * buttons out of the tab order behind the input's `spinbutton` role, so
 * keyboard users adjust with arrow keys rather than tabbing through a pair of
 * unlabelled buttons.
 */

export interface NumberFieldProps extends Omit<NumberFieldPrimitiveProps, "className"> {
  /** The field's accessible name. Rendered unless `aria-label` is supplied. */
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ComponentProps<typeof FieldErrorPrimitive>["children"];
  className?: string;
}

function NumberField({ className, description, errorMessage, label, ...props }: NumberFieldProps) {
  return (
    <NumberFieldPrimitive
      data-slot="number-field"
      className={composeRenderProps(className, (className) => cn("cn-field", className))}
      {...props}
    >
      {label ? <Label className="cn-field-label">{label}</Label> : null}
      {description ? (
        <Text className="cn-field-description" slot="description">
          {description}
        </Text>
      ) : null}
      <Group className="cn-number-field-group">
        <ButtonPrimitive className="cn-number-field-step" excludeFromTabOrder slot="decrement">
          <MinusIcon aria-hidden="true" className="cn-number-field-step-icon" />
        </ButtonPrimitive>
        <InputPrimitive className="cn-number-field-input" data-slot="input" />
        <ButtonPrimitive className="cn-number-field-step" excludeFromTabOrder slot="increment">
          <PlusIcon aria-hidden="true" className="cn-number-field-step-icon" />
        </ButtonPrimitive>
      </Group>
      <FieldErrorPrimitive className="cn-field-error">{errorMessage}</FieldErrorPrimitive>
    </NumberFieldPrimitive>
  );
}

export { NumberField };
