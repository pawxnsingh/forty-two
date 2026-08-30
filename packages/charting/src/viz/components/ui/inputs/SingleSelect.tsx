"use client";

import { useId } from "react";
import { cn } from "@viz/lib/classMerge";

export interface SingleSelectOption {
  value: string;
  label: string;
}

export interface SingleSelectProps {
  options: readonly SingleSelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  alwaysShowValue?: boolean;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SingleSelect({
  options,
  value,
  onChange,
  label,
  disabled = false,
  className,
}: SingleSelectProps) {
  const id = useId();

  return (
    <label className={cn("block min-w-0", className)} htmlFor={id}>
      {label ? <span className="sr-only">{label}</span> : null}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-control border border-boundary bg-surface-raised px-3 text-label text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
