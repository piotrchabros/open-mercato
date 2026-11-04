import type {
  MetaConnection,
  MetaForm,
  MetaLeadEvent,
  MetaPage,
  MetaSettings,
  MetaSyncRun,
} from '../data/entities'
import type {
  ConnectionDto,
  FormDto,
  LeadEventSummaryDto,
  PageDto,
  SettingsDto,
  SyncRunDto,
} from '../api/openapi'

function toIso(value: Date): string {
  return value.toISOString()
}

function toNullableIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function serializeConnection(connection: MetaConnection, pageCount: number): ConnectionDto {
  return {
    id: connection.id,
    metaUserId: connection.metaUserId,
    metaUserName: connection.metaUserName ?? null,
    status: connection.status,
    grantedScopes: connection.grantedScopes ?? [],
    tokenExpiresAt: toNullableIso(connection.tokenExpiresAt),
    lastHealthCheckAt: toNullableIso(connection.lastHealthCheckAt),
    lastError: connection.lastError ?? null,
    pageCount,
    connectedByUserId: connection.connectedByUserId ?? null,
    createdAt: toIso(connection.createdAt),
    updatedAt: toIso(connection.updatedAt),
  }
}

export function serializePage(page: MetaPage, formCount: number): PageDto {
  return {
    id: page.id,
    connectionId: page.connectionId,
    metaPageId: page.metaPageId,
    name: page.name,
    subscriptionStatus: page.subscriptionStatus,
    statusCheckedAt: toNullableIso(page.statusCheckedAt),
    lastError: page.lastError ?? null,
    formCount,
    createdAt: toIso(page.createdAt),
    updatedAt: toIso(page.updatedAt),
  }
}

export function serializeForm(form: MetaForm): FormDto {
  return {
    id: form.id,
    pageId: form.pageId,
    metaFormId: form.metaFormId,
    name: form.name,
    locale: form.locale ?? null,
    isEnabled: form.isEnabled,
    questions: (form.questions ?? []).map((question) => ({
      key: question.key,
      label: question.label,
      type: question.type,
      ...(question.options ? { options: question.options } : {}),
    })),
    questionsFingerprint: form.questionsFingerprint ?? null,
    needsAttention: form.needsAttention,
    attentionReason: form.attentionReason ?? null,
    fieldMapping: (form.fieldMapping ?? []).map((entry) => ({
      questionKey: entry.questionKey,
      target: entry.target,
    })),
    createDeal: form.createDeal,
    pipelineId: form.pipelineId ?? null,
    pipelineStageId: form.pipelineStageId ?? null,
    ownerMode: form.ownerMode,
    ownerUserId: form.ownerUserId ?? null,
    ownerUserIds: form.ownerUserIds ?? [],
    createdAt: toIso(form.createdAt),
    updatedAt: toIso(form.updatedAt),
  }
}

export function serializeLeadEventSummary(
  event: MetaLeadEvent,
  names: { pageName: string | null; formName: string | null },
): LeadEventSummaryDto {
  return {
    id: event.id,
    metaLeadId: event.metaLeadId,
    pageId: event.pageId ?? null,
    pageName: names.pageName,
    formId: event.formId ?? null,
    formName: names.formName,
    source: event.source,
    status: event.status,
    platform: event.platform ?? null,
    isOrganic: event.isOrganic ?? null,
    campaignName: event.campaignName ?? null,
    submittedAt: toNullableIso(event.submittedAt),
    receivedAt: toIso(event.createdAt),
    processedAt: toNullableIso(event.processedAt),
    attemptCount: event.attemptCount,
    manualRetryCount: event.manualRetryCount,
    nextAttemptAt: toNullableIso(event.nextAttemptAt),
    lastErrorCode: event.lastErrorCode ?? null,
    lastError: event.lastError ?? null,
    personId: event.personId ?? null,
    companyId: event.companyId ?? null,
    interactionId: event.interactionId ?? null,
    dealId: event.dealId ?? null,
    matchType: event.matchType ?? null,
    payloadPurgedAt: toNullableIso(event.payloadPurgedAt),
  }
}

export function serializeSyncRun(run: MetaSyncRun, formName: string | null): SyncRunDto {
  return {
    id: run.id,
    kind: run.kind,
    formId: run.formId ?? null,
    formName,
    rangeFrom: toNullableIso(run.rangeFrom),
    rangeTo: toNullableIso(run.rangeTo),
    status: run.status,
    checked: run.checked,
    imported: run.imported,
    duplicates: run.duplicates,
    failed: run.failed,
    progressJobId: run.progressJobId ?? null,
    error: run.error ?? null,
    startedAt: toIso(run.startedAt),
    finishedAt: toNullableIso(run.finishedAt),
    createdAt: toIso(run.createdAt),
  }
}

export function serializeSettings(settings: MetaSettings): SettingsDto {
  return {
    id: settings.id,
    retentionDays: settings.retentionDays,
    defaultCountry: settings.defaultCountry,
    updatedAt: toIso(settings.updatedAt),
  }
}
