"use client";

import type React from "react";
import { cn } from "@viz/lib/classMerge";

type CellValue = React.ReactNode;

export interface ExcelTableProps {
  columns: readonly string[];
  rows: readonly (readonly CellValue[])[];
  title?: string;
  align?: "auto" | "center" | "right";
  fillHeight?: boolean;
  className?: string;
}

function alignmentClass(align: ExcelTableProps["align"]): string {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "text-left";
}

export default function ExcelTable({
  columns,
  rows,
  title,
  align = "auto",
  fillHeight = false,
  className,
}: ExcelTableProps) {
  const textAlignment = alignmentClass(align);

  return (
    <section
      aria-label={title || "Chart data"}
      className={cn(
        "w-full overflow-auto rounded-surface-soft border border-boundary bg-surface-raised",
        fillHeight ? "h-full" : "max-h-[440px]",
        className,
      )}
    >
      <table className="w-full border-collapse text-label">
        <thead className="sticky top-0 z-10 bg-surface-sunken">
          <tr>
            {columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                scope="col"
                className={cn(
                  "whitespace-nowrap border-b border-boundary px-3 py-2 font-semibold",
                  textAlignment,
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-boundary last:border-b-0 hover:bg-surface-sunken/50"
            >
              {columns.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  className={cn(
                    "whitespace-nowrap px-3 py-2 text-foreground",
                    textAlignment,
                  )}
                >
                  {row[columnIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
