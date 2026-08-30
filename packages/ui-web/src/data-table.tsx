"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type * as React from "react";
import {
  Cell as CellPrimitive,
  Column as ColumnPrimitive,
  composeRenderProps,
  Row as RowPrimitive,
  Table as TablePrimitive,
  TableBody as TableBodyPrimitive,
  TableHeader as TableHeaderPrimitive,
  type CellProps as CellPrimitiveProps,
  type ColumnProps as ColumnPrimitiveProps,
  type RowProps as RowPrimitiveProps,
  type TableBodyProps as TableBodyPrimitiveProps,
  type TableHeaderProps as TableHeaderPrimitiveProps,
  type TableProps as TablePrimitiveProps,
} from "react-aria-components";

import { cn } from "./cn";

/**
 * A data table for operational records.
 *
 * Built on React Aria's Table, which renders real `<table>` markup with grid
 * semantics on top: arrow-key movement between cells, Home/End, typeahead,
 * row selection and activation, and sortable columns that announce their
 * direction through `aria-sort`. Rows that open a detail route use
 * `onRowAction`, so keyboard users reach the same destination Enter would
 * give them on a link — which a `<tr onClick>` never provides.
 *
 * The console's dense tables have to survive 320px. The roles are set on the
 * elements themselves, so `console.css` can restack a row into a card at
 * narrow widths without changing what assistive technology reports. Each cell
 * carries its column's name for that stacked presentation; it is hidden from
 * the accessibility tree because the column header already supplies it.
 */

export interface DataTableProps extends Omit<TablePrimitiveProps, "className"> {
  className?: string;
}

function DataTable({ className, ...props }: DataTableProps) {
  return (
    <TablePrimitive
      data-slot="data-table"
      className={composeRenderProps(className, (className) => cn("cn-data-table", className))}
      {...props}
    />
  );
}

export interface DataTableHeaderProps<T extends object> extends Omit<
  TableHeaderPrimitiveProps<T>,
  "className"
> {
  className?: string;
}

function DataTableHeader<T extends object>({ className, ...props }: DataTableHeaderProps<T>) {
  return (
    <TableHeaderPrimitive
      data-slot="data-table-header"
      className={composeRenderProps(className, (className) =>
        cn("cn-data-table-header", className),
      )}
      {...props}
    />
  );
}

export interface DataTableColumnProps extends Omit<ColumnPrimitiveProps, "className"> {
  className?: string;
}

function DataTableColumn({ children, className, ...props }: DataTableColumnProps) {
  return (
    <ColumnPrimitive
      data-slot="data-table-column"
      className={composeRenderProps(className, (className) =>
        cn("cn-data-table-column", className),
      )}
      {...props}
    >
      {composeRenderProps(children, (children, { allowsSorting, sortDirection }) => (
        <span className="cn-data-table-column-content">
          <span>{children}</span>
          {allowsSorting ? (
            <span aria-hidden="true" className="cn-data-table-sort">
              {sortDirection === "descending" ? (
                <ChevronDownIcon className="cn-data-table-sort-icon" />
              ) : sortDirection === "ascending" ? (
                <ChevronUpIcon className="cn-data-table-sort-icon" />
              ) : null}
            </span>
          ) : null}
        </span>
      ))}
    </ColumnPrimitive>
  );
}

export interface DataTableBodyProps<T extends object> extends Omit<
  TableBodyPrimitiveProps<T>,
  "className"
> {
  className?: string;
}

function DataTableBody<T extends object>({ className, ...props }: DataTableBodyProps<T>) {
  return (
    <TableBodyPrimitive
      data-slot="data-table-body"
      className={composeRenderProps(className, (className) => cn("cn-data-table-body", className))}
      {...props}
    />
  );
}

export interface DataTableRowProps<T extends object> extends Omit<
  RowPrimitiveProps<T>,
  "className"
> {
  className?: string;
}

function DataTableRow<T extends object>({ className, ...props }: DataTableRowProps<T>) {
  return (
    <RowPrimitive
      data-slot="data-table-row"
      className={composeRenderProps(className, (className) => cn("cn-data-table-row", className))}
      {...props}
    />
  );
}

export interface DataTableCellProps extends Omit<CellPrimitiveProps, "className"> {
  className?: string;
  /**
   * The column's name, repeated for the stacked narrow-width presentation.
   * Hidden from assistive technology: the column header already names it.
   */
  label?: string;
}

function DataTableCell({ children, className, label, ...props }: DataTableCellProps) {
  return (
    <CellPrimitive
      data-slot="data-table-cell"
      className={composeRenderProps(className, (className) => cn("cn-data-table-cell", className))}
      {...props}
    >
      {composeRenderProps(children, (children) => (
        <>
          {label ? (
            <span aria-hidden="true" className="cn-data-table-cell-label">
              {label}
            </span>
          ) : null}
          <span className="cn-data-table-cell-content">{children}</span>
        </>
      ))}
    </CellPrimitive>
  );
}

export { DataTable, DataTableBody, DataTableCell, DataTableColumn, DataTableHeader, DataTableRow };
