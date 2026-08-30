"use client";

import {
  ApplicationShell,
  type ApplicationBreadcrumb,
  type ApplicationNavigationSection,
} from "@repo/app-shell";
import { Database, MessageSquareText, Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { connectorDefinition } from "./connectors/connector-registry";

interface SessionSummary {
  id: string;
  status: string;
  title?: string;
  updatedAt: string;
}

const sidebarConnectorIcons = [
  { color: "#277960", type: "csv" },
  { color: "#287a4b", type: "xlsx" },
  { color: "#336791", type: "postgresql" },
  { color: "#29b5e8", type: "snowflake" },
  { color: "#4285f4", type: "bigquery" },
].flatMap(({ color, type }) => {
  const connector = connectorDefinition(type);
  if (!connector) return [];
  const Icon = connector.icon;
  return [
    {
      icon: <Icon aria-hidden="true" color={color} strokeWidth={1.8} />,
      label: connector.label,
    },
  ];
});

function sessionLabel(session: SessionSummary) {
  if (session.title) return session.title;
  const savedTitle =
    typeof window === "undefined"
      ? null
      : localStorage.getItem(`forty-two-session-title:${session.id}`);
  if (savedTitle) return savedTitle;
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(session.updatedAt));
}

function breadcrumbsFor(pathname: string): readonly ApplicationBreadcrumb[] {
  if (pathname.startsWith("/chat")) {
    if (pathname === "/chat") return [{ id: "chat", label: "New session" }];
    return [
      { id: "chat", href: "/chat", label: "Sessions" },
      { id: pathname, label: "Session" },
    ];
  }

  if (pathname.startsWith("/connectors")) {
    const trail: ApplicationBreadcrumb[] = [
      { id: "connectors", href: "/connectors", label: "Connectors" },
    ];
    if (pathname === "/connectors/new")
      trail.push({ id: "new", label: "New connector" });
    else if (pathname.startsWith("/connectors/new/"))
      trail.push(
        { id: "new", href: "/connectors/new", label: "New connector" },
        { id: pathname, label: "Setup" },
      );
    return trail;
  }

  const label =
    pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? "Workspace";

  return [{ id: pathname, label }];
}

export function FortyTwoApplicationShell({
  children,
  defaultSidebarOpen,
}: {
  children: ReactNode;
  defaultSidebarOpen: boolean;
}) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const loadSessions = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(
          "/api/chat/sessions?limit=25&status=active",
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data: SessionSummary[];
        };
        setSessions(payload.data);
      } catch {
        // Keep the last successful sidebar state when refresh fails.
      }
    };
    void loadSessions();
    window.addEventListener("forty-two:sessions-changed", loadSessions);
    return () => {
      controller?.abort();
      window.removeEventListener("forty-two:sessions-changed", loadSessions);
    };
  }, []);

  const navigation = useMemo<readonly ApplicationNavigationSection[]>(
    () => [
      {
        id: "primary",
        items: [
          { exact: true, href: "/chat", icon: Plus, label: "New session" },
          { href: "/connectors", icon: Database, label: "Connectors" },
        ],
      },
      {
        id: "recents",
        label: "Recents",
        scrollable: true,
        items: sessions.map((session) => ({
          exact: true,
          href: `/chat/${session.id}`,
          icon: MessageSquareText,
          label: sessionLabel(session),
          variant: "recent" as const,
        })),
      },
    ],
    [sessions],
  );

  return (
    <ApplicationShell
      brand={
        <span aria-hidden="true" className="forty-two-wordmark">
          Forty <em>Two</em>
        </span>
      }
      brandHref="/chat"
      brandLabel="Forty Two workspace"
      breadcrumbs={breadcrumbsFor(pathname)}
      currentPath={pathname}
      defaultSidebarOpen={defaultSidebarOpen}
      navigation={navigation}
      resourceCard={{
        description: "Databases, warehouses, CSV and Excel",
        href: "/connectors/new",
        icons: sidebarConnectorIcons,
        label: "Browse connectors",
        title: "Connect apps",
      }}
      topbarEnd="Ignited by Trueforge"
      workspaceLabel="Forty Two workspace"
    >
      {children}
    </ApplicationShell>
  );
}
