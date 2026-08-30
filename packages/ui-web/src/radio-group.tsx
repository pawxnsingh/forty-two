"use client";

import type * as React from "react";
import {
  composeRenderProps,
  Label,
  Radio as RadioPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Text,
  type RadioGroupProps as RadioGroupPrimitiveProps,
  type RadioProps as RadioPrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * A single-choice group.
 *
 * Built on React Aria's RadioGroup so the set behaves as one stop in the tab
 * order with arrow-key movement between options — the behaviour assistive
 * technology expects of a radio group, and the reason this is not a row of
 * buttons.
 */

export interface RadioGroupProps extends Omit<RadioGroupPrimitiveProps, "className"> {
  /** The group's accessible name. Rendered unless `aria-label` is supplied. */
  label?: React.ReactNode;
  /** Supporting copy announced with the group. */
  description?: React.ReactNode;
  className?: string;
}

function RadioGroup({ className, label, description, children, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={composeRenderProps(className, (className) => cn("cn-radio-group", className))}
      {...props}
    >
      {composeRenderProps(children, (children) => (
        <>
          {label ? <Label className="cn-radio-group-label">{label}</Label> : null}
          {description ? (
            <Text slot="description" className="cn-radio-group-description">
              {description}
            </Text>
          ) : null}
          <div className="cn-radio-group-items">{children}</div>
        </>
      ))}
    </RadioGroupPrimitive>
  );
}

export interface RadioProps extends Omit<RadioPrimitiveProps, "className"> {
  className?: string;
}

/**
 * One option.
 *
 * The visual control is a sibling `<span>` rather than a styled input: React
 * Aria renders a visually hidden native radio for semantics, and drawing on
 * top of it is what lets the whole card carry the selected state.
 */
function Radio({ className, children, ...props }: RadioProps) {
  return (
    <RadioPrimitive
      data-slot="radio"
      className={composeRenderProps(className, (className) => cn("cn-radio", className))}
      {...props}
    >
      {composeRenderProps(children, (children) => (
        <>
          <span aria-hidden="true" className="cn-radio-control" />
          <span className="cn-radio-content">{children}</span>
        </>
      ))}
    </RadioPrimitive>
  );
}

export { Radio, RadioGroup };
