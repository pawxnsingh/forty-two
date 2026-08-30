"use client";

import {
  Link as ReactAriaLink,
  type LinkProps as ReactAriaLinkProps,
  type LinkRenderProps,
} from "react-aria-components/Link";

import { composeClassName } from "./class-name";

export interface LinkProps extends Omit<ReactAriaLinkProps, "className"> {
  className?: string | ((values: LinkRenderProps) => string);
  variant?: LinkVariant;
}

export type LinkVariant = "inline" | "navigation";

const linkClasses = [
  "inline-flex",
  "min-h-[var(--op-target-minimum)]",
  "items-center",
  "outline-none",
  "transition-colors",
  "duration-feedback",
  "ease-feedback",
  "data-[pressed]:text-foreground-secondary",
  "data-[focus-visible]:outline-[length:var(--op-focus-width)]",
  "data-[focus-visible]:outline-boundary-focus",
  "data-[focus-visible]:outline-offset-[var(--op-focus-offset)]",
  "data-[disabled]:cursor-not-allowed",
  "data-[disabled]:text-foreground-muted",
  "data-[disabled]:opacity-[var(--op-interaction-disabled-opacity)]",
  "motion-reduce:transition-none",
  "forced-colors:data-[disabled]:text-[GrayText]",
] as const;

const variantClasses: Record<LinkVariant, readonly string[]> = {
  inline: [
    "text-link",
    "underline",
    "decoration-[length:var(--op-boundary-thickness)]",
    "data-[hovered]:decoration-[length:var(--op-focus-width)]",
  ],
  navigation: ["text-foreground", "no-underline", "data-[hovered]:bg-surface-sunken"],
};

export function Link({ className, variant = "inline", ...props }: LinkProps) {
  return (
    <ReactAriaLink
      {...props}
      className={composeClassName<LinkRenderProps>(
        [...linkClasses, ...variantClasses[variant]],
        className,
      )}
    />
  );
}
