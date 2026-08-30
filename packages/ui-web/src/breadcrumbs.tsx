"use client";

import type { ReactNode } from "react";
import { Breadcrumb, Breadcrumbs as ReactAriaBreadcrumbs } from "react-aria-components/Breadcrumbs";

import { Link } from "./link";

export interface BreadcrumbItem {
  href?: string;
  id: string;
  label: ReactNode;
}

export interface BreadcrumbsProps {
  "aria-label"?: string;
  items: readonly BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({
  "aria-label": ariaLabel = "Breadcrumb",
  className,
  items,
}: BreadcrumbsProps) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ReactAriaBreadcrumbs
        items={items}
        className="flex min-w-0 items-center gap-2 text-body-small text-foreground-muted"
      >
        {(item) => (
          <Breadcrumb
            id={item.id}
            className="flex min-w-0 items-center gap-2 data-[current]:text-foreground"
          >
            {({ isCurrent }) => (
              <>
                {isCurrent || !item.href ? (
                  <span
                    className="truncate font-medium"
                    aria-current={isCurrent ? "page" : undefined}
                  >
                    {item.label}
                  </span>
                ) : (
                  <Link
                    className="min-h-0 truncate text-foreground-muted no-underline"
                    href={item.href}
                    variant="navigation"
                  >
                    {item.label}
                  </Link>
                )}
                {!isCurrent ? (
                  <span className="text-foreground-muted" aria-hidden="true">
                    /
                  </span>
                ) : null}
              </>
            )}
          </Breadcrumb>
        )}
      </ReactAriaBreadcrumbs>
    </nav>
  );
}
