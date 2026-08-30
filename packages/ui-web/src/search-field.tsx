"use client";

import type { ReactNode, Ref } from "react";
import { Button as ReactAriaButton } from "react-aria-components/Button";
import { Input } from "react-aria-components/Input";
import { Label } from "react-aria-components/Label";
import {
  SearchField as ReactAriaSearchField,
  type SearchFieldProps as ReactAriaSearchFieldProps,
} from "react-aria-components/SearchField";

export interface SearchFieldProps extends Omit<
  ReactAriaSearchFieldProps,
  "children" | "className" | "placeholder"
> {
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  leadingIcon?: ReactNode;
  placeholder?: string;
  shortcut?: string;
}

export function SearchField({
  inputRef,
  label,
  leadingIcon,
  placeholder,
  shortcut,
  ...props
}: SearchFieldProps) {
  return (
    <ReactAriaSearchField {...props} className="group min-w-0">
      <Label className="visually-hidden">{label}</Label>
      <div className="flex min-h-[var(--op-target-minimum)] min-w-0 items-center gap-2 rounded-control border-[length:var(--op-boundary-thickness)] border-boundary bg-surface-raised px-3 text-foreground-secondary transition-colors duration-feedback ease-feedback has-[:focus-visible]:border-boundary-focus has-[:focus-visible]:outline has-[:focus-visible]:outline-[length:var(--op-focus-width)] has-[:focus-visible]:outline-boundary-focus motion-reduce:transition-none forced-colors:border-[CanvasText]">
        {leadingIcon ? <span aria-hidden="true">{leadingIcon}</span> : null}
        <Input
          ref={inputRef}
          placeholder={placeholder}
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-body text-foreground outline-none! placeholder:text-foreground-muted"
        />
        {shortcut ? (
          <kbd className="hidden rounded-badge border border-boundary px-1.5 py-0.5 font-mono text-data text-foreground-muted sm:inline">
            {shortcut}
          </kbd>
        ) : null}
        <ReactAriaButton
          slot="clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          className="hidden size-8 items-center justify-center rounded-control text-foreground-muted outline-none group-data-[empty]:hidden data-[hovered]:bg-surface-sunken data-[focus-visible]:outline data-[focus-visible]:outline-boundary-focus [.react-aria-SearchField:not([data-empty])_&]:inline-flex"
        >
          <span aria-hidden="true">×</span>
        </ReactAriaButton>
      </div>
    </ReactAriaSearchField>
  );
}
