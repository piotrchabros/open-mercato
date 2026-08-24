"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useT } from "@open-mercato/shared/lib/i18n/context";
import {
  CrudForm,
  type CrudFormGroup,
} from "@open-mercato/ui/backend/CrudForm";
import { createCrud, updateCrud } from "@open-mercato/ui/backend/utils/crud";
import {
  apiCall,
  withScopedApiRequestHeaders,
} from "@open-mercato/ui/backend/utils/apiCall";
import { buildOptimisticLockHeader } from "@open-mercato/ui/backend/utils/optimisticLock";
import { createCrudFormError } from "@open-mercato/ui/backend/utils/serverErrors";
import { useGuardedMutation } from "@open-mercato/ui/backend/injection/useGuardedMutation";
import { surfaceRecordConflict } from "@open-mercato/ui/backend/conflicts";
import { LoadingMessage, ErrorMessage } from "@open-mercato/ui/backend/detail";
import { flash } from "@open-mercato/ui/backend/FlashMessages";
import { Page, PageBody } from "@open-mercato/ui/backend/Page";

type Kind = "calendar" | "policy";
type RecordValue = Record<string, unknown> & { id: string; updatedAt: string };
type ItemResponse = { item?: RecordValue } & Record<string, unknown>;

export function SlaAdminForm({
  kind,
  mode,
  recordId = "",
}: {
  kind: Kind;
  mode: "create" | "edit";
  recordId?: string;
}) {
  const t = useT();
  const router = useRouter();
  const plural = kind === "calendar" ? "calendars" : "policies";
  const endpoint = `/api/connect-sla/${plural}`;
  const backHref = `/backend/connect/sla/${plural}`;
  const [initialValues, setInitialValues] = React.useState<RecordValue | null>(
    mode === "create" ? { id: "", updatedAt: "" } : null,
  );
  const [loading, setLoading] = React.useState(mode === "edit");
  const [error, setError] = React.useState(false);
  const contextId = `connect_sla.${kind}.publish`;
  const { runMutation, retryLastMutation } = useGuardedMutation({
    contextId,
    blockedMessage: t("connect_sla.form.blocked"),
  });

  React.useEffect(() => {
    if (mode !== "edit") return;
    if (!recordId) {
      setError(true);
      setLoading(false);
      return;
    }
    let active = true;
    apiCall<ItemResponse>(`${endpoint}/${encodeURIComponent(recordId)}`, undefined, {
      fallback: {},
    })
      .then((call) => {
        if (!active) return;
        if (!call.ok) {
          setError(true);
          return;
        }
        const value = call.result?.item ?? call.result;
        if (!value || typeof value.id !== "string") {
          setError(true);
          return;
        }
        setInitialValues(value as RecordValue);
      })
      .catch(() => active && setError(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [endpoint, mode, recordId]);

  const groups = React.useMemo<CrudFormGroup[]>(
    () => (kind === "calendar" ? calendarGroups(t) : policyGroups(t)),
    [kind, t],
  );
  if (loading) return <LoadingMessage label={t("connect_sla.form.loading")} />;
  if (error || !initialValues)
    return <ErrorMessage label={t("connect_sla.form.loadError")} />;

  return (
    <Page>
      <PageBody>
        <CrudForm
          title={t(`connect_sla.form.${kind}.${mode}`)}
          backHref={backHref}
          cancelHref={backHref}
          submitLabel={t("connect_sla.form.save")}
          fields={[]}
          groups={groups}
          initialValues={mode === "edit" ? initialValues : undefined}
          onSubmit={async (values) => {
            const base =
              kind === "calendar"
                ? {
                    name: required(values.name, "name", t),
                    isDefault: values.isDefault === true,
                  }
                : {
                    name: required(values.name, "name", t),
                    priority: integer(values.priority, "priority", t),
                    isActive: values.isActive !== false,
                  };
            const publication =
              values.publishNow === true
                ? kind === "calendar"
                  ? calendarPublication(values, t)
                  : policyPublication(values, t)
                : null;
            let id: string;
            let versionToken: string;
            if (mode === "create") {
              const created = await createCrud<{ id: string; updatedAt: string }>(
                `connect-sla/${plural}`,
                base,
              );
              if (!created.result?.id || !created.result.updatedAt)
                throw createCrudFormError(t("connect_sla.form.saveError"));
              id = created.result.id;
              versionToken = created.result.updatedAt;
            } else {
              id = initialValues.id;
              const updated = await updateCrud<{ updatedAt: string }>(
                `connect-sla/${plural}/${encodeURIComponent(id)}`,
                {
                  ...base,
                  id,
                },
              );
              versionToken = updated.result?.updatedAt ?? initialValues.updatedAt;
            }
            if (publication) {
              try {
                await runMutation({
                  operation: async () => {
                    const call = await withScopedApiRequestHeaders(
                      buildOptimisticLockHeader(versionToken),
                      () =>
                        apiCall(`${endpoint}/${id}/publish`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(publication),
                        }),
                    );
                    if (!call.ok)
                      throw Object.assign(
                        new Error("[internal] connect_sla publish failed"),
                        {
                          status: call.status,
                          ...((call.result as object) ?? {}),
                        },
                      );
                    return call;
                  },
                  context: {
                    formId: contextId,
                    resourceKind: `connect_sla.${kind}`,
                    resourceId: id,
                    retryLastMutation,
                  },
                  mutationPayload: publication,
                });
              } catch (publishError) {
                if (mode === "create")
                  router.replace(`${backHref}/${encodeURIComponent(id)}`);
                if (surfaceRecordConflict(publishError, t))
                  throw createCrudFormError(t("connect_sla.form.conflict"));
                throw createCrudFormError(t("connect_sla.form.publishError"));
              }
            }
            flash(
              t(
                mode === "create"
                  ? "connect_sla.form.created"
                  : "connect_sla.form.updated",
              ),
              "success",
            );
            router.push(backHref);
          }}
        />
      </PageBody>
    </Page>
  );
}

function calendarGroups(t: ReturnType<typeof useT>): CrudFormGroup[] {
  return [
    {
      id: "details",
      title: t("connect_sla.form.details"),
      column: 1,
      fields: [
        {
          id: "name",
          type: "text",
          label: t("connect_sla.admin.name"),
          required: true,
        },
        {
          id: "isDefault",
          type: "checkbox",
          label: t("connect_sla.admin.default"),
        },
      ],
    },
    {
      id: "publication",
      title: t("connect_sla.form.publication"),
      column: 2,
      fields: [
        {
          id: "publishNow",
          type: "checkbox",
          label: t("connect_sla.form.publishNow"),
        },
        {
          id: "timezone",
          type: "text",
          label: t("connect_sla.form.timezone"),
          placeholder: t("connect_sla.form.timezonePlaceholder"),
          description: t("connect_sla.form.timezoneHelp"),
        },
        {
          id: "windows",
          type: "textarea",
          label: t("connect_sla.form.windows"),
        },
        {
          id: "holidays",
          type: "textarea",
          label: t("connect_sla.form.holidays"),
        },
      ],
    },
  ];
}
function policyGroups(t: ReturnType<typeof useT>): CrudFormGroup[] {
  return [
    {
      id: "details",
      title: t("connect_sla.form.details"),
      column: 1,
      fields: [
        {
          id: "name",
          type: "text",
          label: t("connect_sla.admin.name"),
          required: true,
        },
        {
          id: "priority",
          type: "number",
          label: t("connect_sla.admin.priority"),
          required: true,
        },
        {
          id: "isActive",
          type: "checkbox",
          label: t("connect_sla.admin.active"),
          defaultValue: true,
        },
      ],
    },
    {
      id: "publication",
      title: t("connect_sla.form.publication"),
      column: 2,
      fields: [
        {
          id: "publishNow",
          type: "checkbox",
          label: t("connect_sla.form.publishNow"),
        },
        { id: "channelId", type: "text", label: t("connect_sla.form.channel") },
        {
          id: "calendarVersionId",
          type: "text",
          label: t("connect_sla.form.calendarVersion"),
        },
        {
          id: "responseTargetMinutes",
          type: "number",
          label: t("connect_sla.form.responseTarget"),
        },
        {
          id: "responseWarningMinutes",
          type: "number",
          label: t("connect_sla.form.responseWarning"),
        },
        {
          id: "resolutionTargetMinutes",
          type: "number",
          label: t("connect_sla.form.resolutionTarget"),
        },
        {
          id: "resolutionWarningMinutes",
          type: "number",
          label: t("connect_sla.form.resolutionWarning"),
        },
        {
          id: "effectiveFrom",
          type: "datetime-local",
          label: t("connect_sla.form.effectiveFrom"),
        },
      ],
    },
  ];
}

export function calendarPublication(
  values: Record<string, unknown>,
  t: ReturnType<typeof useT>,
) {
  const timezone = required(values.timezone, "timezone", t);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw createCrudFormError(t("connect_sla.form.timezoneInvalid"), {
      timezone: t("connect_sla.form.timezoneInvalid"),
    });
  }
  const windows = parseLines(values.windows, 3, "windows", t).map(
    ([weekday, localStart, localEnd]) => ({
      weekday: Number(weekday),
      localStart,
      localEnd,
    }),
  );
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (
    windows.some(
      (window) =>
        !Number.isInteger(window.weekday) ||
        window.weekday < 0 ||
        window.weekday > 6 ||
        !timePattern.test(window.localStart) ||
        !timePattern.test(window.localEnd),
    )
  )
    throw createCrudFormError(t("connect_sla.form.linesInvalid"), {
      windows: t("connect_sla.form.linesInvalid"),
    });
  const holidays = parseLines(values.holidays, 1, "holidays", t, true).map(
    ([localDate, label]) => ({ localDate, label: label || null }),
  );
  if (
    holidays.some((holiday) => !/^\d{4}-\d{2}-\d{2}$/.test(holiday.localDate))
  )
    throw createCrudFormError(t("connect_sla.form.linesInvalid"), {
      holidays: t("connect_sla.form.linesInvalid"),
    });
  return {
    timezone,
    windows,
    holidays,
  };
}
export function policyPublication(
  values: Record<string, unknown>,
  t: ReturnType<typeof useT>,
) {
  const responseTargetMinutes = positive(
    values.responseTargetMinutes,
    "responseTargetMinutes",
    t,
  );
  const resolutionTargetMinutes = positive(
    values.resolutionTargetMinutes,
    "resolutionTargetMinutes",
    t,
  );
  const responseWarningMinutes = nonnegative(
    values.responseWarningMinutes,
    "responseWarningMinutes",
    t,
  );
  const resolutionWarningMinutes = nonnegative(
    values.resolutionWarningMinutes,
    "resolutionWarningMinutes",
    t,
  );
  if (
    responseWarningMinutes >= responseTargetMinutes ||
    resolutionWarningMinutes >= resolutionTargetMinutes
  )
    throw createCrudFormError(t("connect_sla.form.warningInvalid"));
  const effectiveFrom = new Date(
    required(values.effectiveFrom, "effectiveFrom", t),
  );
  if (!Number.isFinite(effectiveFrom.getTime()))
    throw createCrudFormError(t("connect_sla.form.required"), {
      effectiveFrom: t("connect_sla.form.required"),
    });
  return {
    channelId: optional(values.channelId),
    calendarVersionId: required(
      values.calendarVersionId,
      "calendarVersionId",
      t,
    ),
    responseTargetMinutes,
    resolutionTargetMinutes,
    responseWarningMinutes,
    resolutionWarningMinutes,
    effectiveFrom: effectiveFrom.toISOString(),
  };
}
function required(
  value: unknown,
  field: string,
  t: ReturnType<typeof useT>,
): string {
  const result = String(value ?? "").trim();
  if (!result)
    throw createCrudFormError(t("connect_sla.form.required"), {
      [field]: t("connect_sla.form.required"),
    });
  return result;
}
function optional(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}
function integer(
  value: unknown,
  field: string,
  t: ReturnType<typeof useT>,
): number {
  const result = Number(value);
  if (!Number.isInteger(result))
    throw createCrudFormError(t("connect_sla.form.numberInvalid"), {
      [field]: t("connect_sla.form.numberInvalid"),
    });
  return result;
}
function positive(
  value: unknown,
  field: string,
  t: ReturnType<typeof useT>,
): number {
  const result = integer(value, field, t);
  if (result <= 0)
    throw createCrudFormError(t("connect_sla.form.numberInvalid"), {
      [field]: t("connect_sla.form.numberInvalid"),
    });
  return result;
}
function nonnegative(
  value: unknown,
  field: string,
  t: ReturnType<typeof useT>,
): number {
  const result = integer(value, field, t);
  if (result < 0)
    throw createCrudFormError(t("connect_sla.form.numberInvalid"), {
      [field]: t("connect_sla.form.numberInvalid"),
    });
  return result;
}
function parseLines(
  value: unknown,
  minimumParts: number,
  field: string,
  t: ReturnType<typeof useT>,
  emptyAllowed = false,
): string[][] {
  const lines = String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!emptyAllowed && !lines.length)
    throw createCrudFormError(t("connect_sla.form.required"), {
      [field]: t("connect_sla.form.required"),
    });
  const parsed = lines.map((line) =>
    line.split(",").map((part) => part.trim()),
  );
  if (parsed.some((parts) => parts.length < minimumParts))
    throw createCrudFormError(t("connect_sla.form.linesInvalid"), {
      [field]: t("connect_sla.form.linesInvalid"),
    });
  return parsed;
}
