"use client";

import {
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableColumn,
  DataTableHeader,
  DataTableRow,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LinkButton,
} from "@repo/ui-web";
import {
  AlertTriangle,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { connectorDefinition } from "./connector-registry";
import styles from "./connectors.module.css";
import type { ApiErrorPayload, PublicDataSource } from "./types";

const statusLabels = {
  awaiting_upload: "Awaiting upload",
  testing: "Testing",
  ready: "Ready",
  failed: "Needs attention",
} as const;

type ConnectorFilter = "all" | "ready" | "pending" | "failed";

async function responseMessage(response: Response, fallback: string) {
  const payload = (await response
    .json()
    .catch(() => null)) as ApiErrorPayload | null;
  return payload?.error?.message ?? fallback;
}

export function ConnectorsList() {
  const router = useRouter();
  const [sources, setSources] = useState<PublicDataSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PublicDataSource | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState<ConnectorFilter>("all");

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/data-sources?limit=100", {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Connectors could not be loaded."),
        );
      const payload = (await response.json()) as { data: PublicDataSource[] };
      setSources(payload.data);
    } catch (loadError) {
      setSources([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Connectors could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function deleteSource() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const response = await fetch(
        `/api/data-sources/${encodeURIComponent(pendingDelete.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new Error(
          await responseMessage(
            response,
            "The connector could not be deleted.",
          ),
        );
      setPendingDelete(null);
      await load();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The connector could not be deleted.",
      );
    } finally {
      setDeleting(false);
    }
  }

  const visibleSources =
    sources?.filter((source) => {
      if (filter === "all") return true;
      if (filter === "pending")
        return (
          source.status === "testing" || source.status === "awaiting_upload"
        );
      return source.status === filter;
    }) ?? [];
  const filterOptions: readonly {
    id: ConnectorFilter;
    label: string;
    count: number;
  }[] = [
    { id: "all", label: "All", count: sources?.length ?? 0 },
    {
      id: "ready",
      label: "Ready",
      count: sources?.filter((source) => source.status === "ready").length ?? 0,
    },
    {
      id: "pending",
      label: "In progress",
      count:
        sources?.filter(
          (source) =>
            source.status === "testing" || source.status === "awaiting_upload",
        ).length ?? 0,
    },
    {
      id: "failed",
      label: "Needs attention",
      count:
        sources?.filter((source) => source.status === "failed").length ?? 0,
    },
  ];

  return (
    <div className={`${styles.page} ${styles.connectorListPage}`}>
      <header className={styles.connectorListHeader}>
        <div>
          <h1>Connectors</h1>
          <p>
            {sources === null
              ? "Data sources"
              : `${sources.length} data sources`}
          </p>
        </div>
        <LinkButton className={styles.primaryAction} href="/connectors/new">
          <Plus aria-hidden="true" />
          New connector
        </LinkButton>
      </header>

      {error ? (
        <div className={styles.errorBanner} role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
          <Button onPress={() => void load()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      ) : null}

      {sources === null ? (
        <div aria-label="Loading connectors" className={styles.sourceTable}>
          <div aria-hidden="true" className={styles.sourceTableHead}>
            <span>Source</span>
            <span>Type</span>
            <span>Status</span>
            <span>Updated</span>
            <span />
          </div>
          <div className={styles.sourceTableLoading}>
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : sources.length ? (
        <section aria-label="Connected sources" className={styles.listSection}>
          <div
            aria-label="Filter connectors"
            className={styles.connectorFilters}
          >
            {filterOptions.map((option) => (
              <button
                aria-pressed={filter === option.id}
                data-active={filter === option.id || undefined}
                key={option.id}
                onClick={() => setFilter(option.id)}
                type="button"
              >
                {option.label}
                <span>{option.count}</span>
              </button>
            ))}
          </div>
          {visibleSources.length ? (
            <div className={styles.sourceTableFrame}>
              <DataTable
                aria-label="Connected sources"
                className={styles.connectorDataTable}
              >
                <DataTableHeader>
                  <DataTableColumn isRowHeader>Source</DataTableColumn>
                  <DataTableColumn>Type</DataTableColumn>
                  <DataTableColumn>Status</DataTableColumn>
                  <DataTableColumn>Updated</DataTableColumn>
                  <DataTableColumn>
                    <span className="visually-hidden">Actions</span>
                  </DataTableColumn>
                </DataTableHeader>
                <DataTableBody items={visibleSources}>
                  {(source) => {
                    const connector = connectorDefinition(source.connectorType);
                    const Icon = connector?.icon;
                    return (
                      <DataTableRow id={source.id}>
                        <DataTableCell label="Source">
                          <span className={styles.sourcePrimary}>
                            <span
                              className={styles.connectorIcon}
                              data-connector={source.connectorType}
                            >
                              {Icon ? <Icon aria-hidden="true" /> : null}
                            </span>
                            <span className={styles.sourceIdentity}>
                              <strong>{source.name}</strong>
                              <span>
                                {source.originalFilename ?? source.id}
                              </span>
                            </span>
                          </span>
                        </DataTableCell>
                        <DataTableCell label="Type">
                          <span className={styles.sourceType}>
                            {connector?.label ?? source.connectorType}
                          </span>
                        </DataTableCell>
                        <DataTableCell label="Status">
                          <span
                            className={styles.status}
                            data-status={source.status}
                          >
                            {statusLabels[source.status]}
                          </span>
                        </DataTableCell>
                        <DataTableCell label="Updated">
                          <time
                            className={styles.sourceUpdated}
                            dateTime={source.updatedAt}
                          >
                            {new Intl.DateTimeFormat("en", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            }).format(new Date(source.updatedAt))}
                          </time>
                        </DataTableCell>
                        <DataTableCell label="Actions">
                          <span className={styles.sourceActions}>
                            <DropdownMenuTrigger>
                              <Button
                                aria-label={`Actions for ${source.name}`}
                                size="icon-sm"
                                variant="ghost"
                              >
                                <MoreHorizontal aria-hidden="true" />
                              </Button>
                              <DropdownMenu
                                aria-label={`Actions for ${source.name}`}
                                className={styles.actionMenu}
                                placement="bottom end"
                              >
                                {source.status === "ready" ? (
                                  <DropdownMenuItem
                                    id="start-conversation"
                                    onAction={() =>
                                      router.push(
                                        `/chat?source=${encodeURIComponent(source.id)}`,
                                      )
                                    }
                                    textValue="Start conversation"
                                  >
                                    <MessageSquareText aria-hidden="true" />
                                    Start conversation
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem
                                  className={styles.deleteMenuItem}
                                  id="delete"
                                  onAction={() => setPendingDelete(source)}
                                  textValue="Delete"
                                  variant="destructive"
                                >
                                  <Trash2 aria-hidden="true" /> Delete connector
                                </DropdownMenuItem>
                              </DropdownMenu>
                            </DropdownMenuTrigger>
                          </span>
                        </DataTableCell>
                      </DataTableRow>
                    );
                  }}
                </DataTableBody>
              </DataTable>
            </div>
          ) : (
            <div className={styles.filteredEmpty}>
              No connectors match this status.
            </div>
          )}
        </section>
      ) : (
        <section className={styles.emptyState}>
          <h2>No connectors yet</h2>
          <p>Add a source when you are ready.</p>
          <LinkButton className={styles.primaryAction} href="/connectors/new">
            New connector
          </LinkButton>
        </section>
      )}

      <Dialog
        isDismissable={!deleting}
        isOpen={pendingDelete !== null}
        mode="destructive"
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        {({ close }) => (
          <>
            <DialogHeader
              description="This removes the connector from Forty Two. The action cannot be undone."
              onClose={deleting ? undefined : close}
              title={`Delete ${pendingDelete?.name ?? "connector"}?`}
            />
            <DialogBody>
              <p className={styles.dialogCopy}>
                Any future analysis will no longer be able to use this source.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button isDisabled={deleting} onPress={close} variant="outline">
                Cancel
              </Button>
              <Button
                isPending={deleting}
                onPress={() => void deleteSource()}
                variant="destructive"
              >
                Delete connector
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}
