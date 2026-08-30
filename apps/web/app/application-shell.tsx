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
  const savedTitle =
    typeof window === "undefined"
      ? null
      : localStorage.getItem(`forty-two-session-title:${session.id}`);
  if (savedTitle) return savedTitle;
  if (session.title) return session.title;
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(session.updatedAt));
}

function turnTitle(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("data" in payload))
    return null;
  const turns = (payload as { data?: unknown }).data;
  if (!Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || !("input" in turn)) continue;
    const input = (turn as { input?: unknown }).input;
    if (!Array.isArray(input)) continue;
    const message = input.find(
      (item) =>
        item &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "user.message" &&
        "content" in item &&
        typeof item.content === "string",
    ) as { content: string } | undefined;
    if (message) {
      const title = message.content.replace(/\s+/g, " ").trim();
      if (title) return title.length > 48 ? `${title.slice(0, 47)}…` : title;
    }
  }
  return null;
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
    const controller = new AbortController();
    void (async () => {
      const loaded: SessionSummary[] = [];
      let pageToken: string | null = null;
      do {
        const search = new URLSearchParams({ limit: "25" });
        if (pageToken) search.set("pageToken", pageToken);
        const response = await fetch(`/api/chat/sessions?${search}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data: SessionSummary[];
          pagination: { nextPageToken: string | null };
        };
        loaded.push(
          ...payload.data.filter((session) => session.status === "active"),
        );
        pageToken = payload.pagination.nextPageToken;
      } while (pageToken && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      setSessions(loaded);
      const titled = await Promise.all(
        loaded.slice(0, 50).map(async (session) => {
          if (localStorage.getItem(`forty-two-session-title:${session.id}`))
            return session;
          const response = await fetch(
            `/api/chat/sessions/${session.id}/turns?limit=25`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) return session;
          const title = turnTitle(await response.json());
          if (title)
            localStorage.setItem(
              `forty-two-session-title:${session.id}`,
              title,
            );
          return title ? { ...session, title } : session;
        }),
      );
      if (!controller.signal.aborted) setSessions(titled);
    })().catch(() => undefined);
    return () => controller.abort();
  }, [pathname]);

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
