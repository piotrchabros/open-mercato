"use client";

import * as React from "react";
import Link from "next/link";
import type { LegacyColumnDef as ColumnDef } from "@tanstack/react-table/legacy";
import { Plus, RefreshCw } from "lucide-react";
import { useT } from "@open-mercato/shared/lib/i18n/context";
import { DataTable } from "@open-mercato/ui/backend/DataTable";
import { ListEmptyState } from "@open-mercato/ui/backend/filters/ListEmptyState";
import { Page, PageBody } from "@open-mercato/ui/backend/Page";
import { RowActions } from "@open-mercato/ui/backend/RowActions";
import {
  apiCall,
  withScopedApiRequestHeaders,
} from "@open-mercato/ui/backend/utils/apiCall";
import { buildOptimisticLockHeader } from "@open-mercato/ui/backend/utils/optimisticLock";
import { useGuardedMutation } from "@open-mercato/ui/backend/injection/useGuardedMutation";
import { surfaceRecordConflict } from "@open-mercato/ui/backend/conflicts";
import { flash } from "@open-mercato/ui/backend/FlashMessages";
import { Button } from "@open-mercato/ui/primitives/button";
import { StatusBadge } from "@open-mercato/ui/primitives/status-badge";

type ListResponse<Row> = {
  items: Row[];
  total: number;
  page: number;
  totalPages: number;
  totalIsCapped?: boolean;
};
type CursorResponse<Row> = { items: Row[]; nextCursor: string | null };
type BaseRow = { id: string; updatedAt: string };

function useRows<Row>(endpoint: string) {
  const t = useT();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [page, setPage] = React.useState(1);
  const [metadata, setMetadata] = React.useState({
    total: 0,
    totalPages: 1,
    totalIsCapped: false,
  });
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    apiCall<ListResponse<Row>>(
      `${endpoint}?page=${page}&pageSize=50`,
      undefined,
      { fallback: { items: [], total: 0, page, totalPages: 1 } },
    )
      .then((call) => {
        if (!active) return;
        if (!call.ok) throw new Error("[internal] connect_sla list failed");
        const result = call.result;
        setRows(result?.items ?? []);
        setMetadata({
          total: result?.total ?? 0,
          totalPages: result?.totalPages ?? 1,
          totalIsCapped: result?.totalIsCapped === true,
        });
      })
      .catch(() => active && flash(t("connect_sla.admin.loadError"), "error"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [endpoint, page, reload, t]);
  return {
    rows,
    page,
    setPage,
    metadata,
    loading,
    refresh: () => setReload((value) => value + 1),
  };
}

function useCursorRows<Row>(endpoint: string) {
  const t = useT();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [page, setPage] = React.useState(1);
  const [metadata, setMetadata] = React.useState({
    total: 0,
    totalPages: 1,
    totalIsCapped: true,
  });
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);
  const cursors = React.useRef(new Map<number, string | null>([[1, null]]));
  React.useEffect(() => {
    const cursor = cursors.current.get(page);
    if (cursor === undefined) {
      setPage(1);
      return;
    }
    let active = true;
    setLoading(true);
    const query = cursor
      ? `?pageSize=50&cursor=${encodeURIComponent(cursor)}`
      : "?pageSize=50";
    apiCall<CursorResponse<Row>>(`${endpoint}${query}`, undefined, {
      fallback: { items: [], nextCursor: null },
    })
      .then((call) => {
        if (!active) return;
        if (!call.ok) throw new Error("[internal] connect_sla list failed");
        const items = call.result?.items ?? [];
        const nextCursor = call.result?.nextCursor ?? null;
        setRows(items);
        if (nextCursor) cursors.current.set(page + 1, nextCursor);
        else cursors.current.delete(page + 1);
        setMetadata({
          total: (page - 1) * 50 + items.length + (nextCursor ? 1 : 0),
          totalPages: page + (nextCursor ? 1 : 0),
          totalIsCapped: nextCursor !== null,
        });
      })
      .catch(() => active && flash(t("connect_sla.admin.loadError"), "error"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [endpoint, page, reload, t]);
  return {
    rows,
    page,
    setPage,
    metadata,
    loading,
    refresh: () => {
      cursors.current = new Map([[1, null]]);
      setPage(1);
      setReload((value) => value + 1);
    },
  };
}

type CalendarRow = BaseRow & {
  name: string;
  isDefault: boolean;
  currentVersion: number | null;
  createdAt: string;
};
type PolicyRow = BaseRow & {
  name: string;
  priority: number;
  isActive: boolean;
  currentVersion: number | null;
  createdAt: string;
};
type ClockRow = BaseRow & {
  caseId: string;
  generation: number;
  responseState: string;
  resolutionState: string;
  responseDueAt: string;
  resolutionDueAt: string;
  respondedAt: string | null;
  resolvedAt: string | null;
};

export function CalendarsPage() {
  const t = useT();
  const data = useRows<CalendarRow>("/api/connect-sla/calendars");
  const columns = React.useMemo<ColumnDef<CalendarRow>[]>(
    () => [
      { accessorKey: "name", header: t("connect_sla.admin.name") },
      {
        accessorKey: "currentVersion",
        header: t("connect_sla.admin.version"),
        cell: ({ row }) =>
          row.original.currentVersion ?? t("connect_sla.admin.unpublished"),
      },
      {
        accessorKey: "isDefault",
        header: t("connect_sla.admin.default"),
        cell: ({ row }) =>
          row.original.isDefault
            ? t("connect_sla.admin.yes")
            : t("connect_sla.admin.no"),
      },
    ],
    [t],
  );
  return (
    <ResourceTable
      titleKey="connect_sla.admin.calendars"
      endpoint="/api/connect-sla/calendars"
      createHref="/backend/connect/sla/calendars/create"
      columns={columns}
      data={data}
    />
  );
}

export function PoliciesPage() {
  const t = useT();
  const data = useRows<PolicyRow>("/api/connect-sla/policies");
  const columns = React.useMemo<ColumnDef<PolicyRow>[]>(
    () => [
      { accessorKey: "name", header: t("connect_sla.admin.name") },
      { accessorKey: "priority", header: t("connect_sla.admin.priority") },
      {
        accessorKey: "currentVersion",
        header: t("connect_sla.admin.version"),
        cell: ({ row }) =>
          row.original.currentVersion ?? t("connect_sla.admin.unpublished"),
      },
      {
        accessorKey: "isActive",
        header: t("connect_sla.admin.status"),
        cell: ({ row }) => (
          <StatusBadge variant={row.original.isActive ? "success" : "neutral"}>
            {row.original.isActive
              ? t("connect_sla.admin.active")
              : t("connect_sla.admin.inactive")}
          </StatusBadge>
        ),
      },
    ],
    [t],
  );
  return (
    <ResourceTable
      titleKey="connect_sla.admin.policies"
      endpoint="/api/connect-sla/policies"
      createHref="/backend/connect/sla/policies/create"
      columns={columns}
      data={data}
    />
  );
}

function ResourceTable<Row extends BaseRow>({
  titleKey,
  endpoint,
  createHref,
  columns,
  data,
}: {
  titleKey: string;
  endpoint: string;
  createHref: string;
  columns: ColumnDef<Row>[];
  data: ReturnType<typeof useRows<Row>>;
}) {
  const t = useT();
  const contextId = `${titleKey}:mutation`;
  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId });
  const remove = async (row: Row) => {
    try {
      await runMutation({
        operation: async () => {
          const call = await withScopedApiRequestHeaders(
            buildOptimisticLockHeader(row.updatedAt),
            () =>
              apiCall(`${endpoint}/${encodeURIComponent(row.id)}`, {
                method: "DELETE",
              }),
          );
          if (!call.ok)
            throw Object.assign(
              new Error("[internal] connect_sla delete failed"),
              { status: call.status, ...((call.result as object) ?? {}) },
            );
          return call;
        },
        context: {
          formId: contextId,
          resourceKind: titleKey,
          resourceId: row.id,
          retryLastMutation,
        },
        mutationPayload: { id: row.id, updatedAt: row.updatedAt },
      });
      flash(t("connect_sla.admin.deleted"), "success");
      data.refresh();
    } catch (error) {
      if (!surfaceRecordConflict(error, t, { onRefresh: data.refresh }))
        flash(t("connect_sla.admin.deleteError"), "error");
    }
  };
  return (
    <Page>
      <PageBody>
        <DataTable
          title={t(titleKey)}
          data={data.rows}
          columns={columns}
          isLoading={data.loading}
          actions={
            <Button asChild>
              <Link href={createHref}>
                <Plus className="mr-2 h-4 w-4" />
                {t("connect_sla.admin.create")}
              </Link>
            </Button>
          }
          rowActions={(row) => (
            <RowActions
              items={[
                {
                  id: "edit",
                  label: t("connect_sla.admin.edit"),
                  href: `${createHref.replace("/create", "")}/${row.id}`,
                },
                {
                  id: "delete",
                  label: t("connect_sla.admin.delete"),
                  destructive: true,
                  onSelect: () => remove(row),
                },
              ]}
            />
          )}
          emptyState={
            <ListEmptyState
              entityName={t(titleKey)}
              createHref={createHref}
              createLabel={t("connect_sla.admin.create")}
            />
          }
          pagination={{
            page: data.page,
            pageSize: 50,
            total: data.metadata.total,
            totalPages: data.metadata.totalPages,
            totalIsCapped: data.metadata.totalIsCapped,
            onPageChange: data.setPage,
          }}
        />
      </PageBody>
    </Page>
  );
}

export function ClocksPage() {
  const t = useT();
  const data = useCursorRows<ClockRow>("/api/connect-sla/clocks");
  const contextId = "connect_sla.clocks.rebuild";
  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId });
  const rebuild = async () => {
    try {
      await runMutation({
        operation: async () => {
          const call = await apiCall("/api/connect-sla/clocks/rebuild", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandKey: crypto.randomUUID(),
              reason: "admin_rebuild",
            }),
          });
          if (!call.ok)
            throw new Error("[internal] connect_sla rebuild failed");
          return call;
        },
        context: {
          formId: contextId,
          resourceKind: "connect_sla.clock",
          resourceId: "all",
          retryLastMutation,
        },
        mutationPayload: {},
      });
      flash(t("connect_sla.admin.rebuildStarted"), "success");
    } catch {
      flash(t("connect_sla.admin.rebuildError"), "error");
    }
  };
  const columns = React.useMemo<ColumnDef<ClockRow>[]>(
    () => [
      { accessorKey: "caseId", header: t("connect_sla.admin.case") },
      { accessorKey: "generation", header: t("connect_sla.admin.generation") },
      {
        accessorKey: "responseState",
        header: t("connect_sla.inbox.response"),
        cell: ({ row }) => (
          <StatusBadge
            variant={
              row.original.responseState === "breached"
                ? "error"
                : row.original.responseState === "met"
                  ? "success"
                  : "neutral"
            }
          >
            {t(`connect_sla.state.${row.original.responseState}`)}
          </StatusBadge>
        ),
      },
      {
        accessorKey: "resolutionState",
        header: t("connect_sla.inbox.resolution"),
        cell: ({ row }) => (
          <StatusBadge
            variant={
              row.original.resolutionState === "breached"
                ? "error"
                : row.original.resolutionState === "met"
                  ? "success"
                  : "neutral"
            }
          >
            {t(`connect_sla.state.${row.original.resolutionState}`)}
          </StatusBadge>
        ),
      },
    ],
    [t],
  );
  return (
    <Page>
      <PageBody>
        <DataTable
          title={t("connect_sla.admin.clocks")}
          data={data.rows}
          columns={columns}
          isLoading={data.loading}
          actions={
            <Button type="button" onClick={rebuild}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("connect_sla.admin.rebuild")}
            </Button>
          }
          emptyState={
            <ListEmptyState entityName={t("connect_sla.admin.clocks")} />
          }
          pagination={{
            page: data.page,
            pageSize: 50,
            total: data.metadata.total,
            totalPages: data.metadata.totalPages,
            totalIsCapped: data.metadata.totalIsCapped,
            onPageChange: data.setPage,
          }}
        />
      </PageBody>
    </Page>
  );
}
