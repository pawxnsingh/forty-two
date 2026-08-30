"use client";

import {
  Button as ReactAriaButton,
  type ButtonProps as ReactAriaButtonProps,
  type ButtonRenderProps,
} from "react-aria-components/Button";

import { composeClassName } from "./class-name";

export interface IconButtonProps extends Omit<ReactAriaButtonProps, "aria-label" | "className"> {
  "aria-label": string;
  className?: string | ((values: ButtonRenderProps) => string);
}

const iconButtonClasses = [
  "inline-flex",
  "size-[var(--op-target-minimum)]",
  "shrink-0",
  "items-center",
  "justify-center",
  "rounded-control",
  "border-[length:var(--op-boundary-thickness)]",
  "border-transparent",
  "bg-transparent",
  "text-foreground-secondary",
  "outline-none",
  "transition-[background-color,color,transform]",
  "duration-feedback",
  "ease-feedback",
  "data-[hovered]:bg-surface-sunken",
  "data-[hovered]:text-foreground",
  "data-[pressed]:translate-y-px",
  "data-[pressed]:bg-action-secondary-pressed",
  "data-[focus-visible]:outline-[length:var(--op-focus-width)]",
  "data-[focus-visible]:outline-boundary-focus",
  "data-[focus-visible]:outline-offset-[var(--op-focus-offset)]",
  "data-[disabled]:cursor-not-allowed",
  "data-[disabled]:text-foreground-muted",
  "data-[disabled]:opacity-[var(--op-interaction-disabled-opacity)]",
  "motion-reduce:transform-none",
  "motion-reduce:transition-none",
  "forced-colors:border-[ButtonText]",
] as const;

export function IconButton({ className, type, ...props }: IconButtonProps) {
  return (
    <ReactAriaButton
      {...props}
      type={type ?? "button"}
      className={composeClassName<ButtonRenderProps>(iconButtonClasses, className)}
    />
  );
}
