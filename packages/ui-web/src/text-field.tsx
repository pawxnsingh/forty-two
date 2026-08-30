"use client";

import type * as React from "react";
import {
  composeRenderProps,
  FieldError as FieldErrorPrimitive,
  Input as InputPrimitive,
  Label,
  Text,
  TextField as TextFieldPrimitive,
  type TextFieldProps as TextFieldPrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * A single-line text input with its label, description and validation
 * message.
 *
 * React Aria owns the wiring: the label's `for`, the `aria-describedby` chain
 * to the description, `aria-invalid`, and the fact that a validation message
 * is announced when it appears. Assembling those by hand is where field
 * accessibility usually breaks, so the composition is the primitive rather
 * than a bare `<input>` consumers then have to label themselves.
 *
 * `errorMessage` is a render prop in React Aria, so both the browser's own
 * constraint validation and an `isInvalid`/`errorMessage` pair from the server
 * surface through the same `FieldError` element.
 */

interface FieldShellProps {
  /** The field's accessible name. Rendered unless `aria-label` is supplied. */
  label?: React.ReactNode;
  /** Supporting copy, announced with the field. */
  description?: React.ReactNode;
  /** Validation copy. A string is shown whenever the field is invalid. */
  errorMessage?: React.ComponentProps<typeof FieldErrorPrimitive>["children"];
  className?: string;
}

export interface TextFieldProps
  extends Omit<TextFieldPrimitiveProps, "className" | "children">, FieldShellProps {
  inputRef?: React.Ref<HTMLInputElement>;
  placeholder?: string;
  /** Rendered after the input, inside the field, for units or affordances. */
  suffix?: React.ReactNode;
}

function TextField({
  className,
  description,
  errorMessage,
  inputRef,
  label,
  placeholder,
  suffix,
  ...props
}: TextFieldProps) {
  return (
    <TextFieldPrimitive
      data-slot="text-field"
      className={composeRenderProps(className, (className) => cn("cn-field", className))}
      {...props}
    >
      {label ? <Label className="cn-field-label">{label}</Label> : null}
      {description ? (
        <Text className="cn-field-description" slot="description">
          {description}
        </Text>
      ) : null}
      <div className="cn-field-control">
        <InputPrimitive
          className="cn-input cn-field-input w-full min-w-0 outline-none placeholder:text-foreground-muted"
          data-slot="input"
          placeholder={placeholder}
          ref={inputRef}
        />
        {suffix ? <span className="cn-field-suffix">{suffix}</span> : null}
      </div>
      <FieldErrorPrimitive className="cn-field-error">{errorMessage}</FieldErrorPrimitive>
    </TextFieldPrimitive>
  );
}

export { TextField };
