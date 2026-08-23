import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

/**
 * Published identifiers and the single error vocabulary the cost-input surface
 * speaks. Kept in its own file so the command module, the CRUD route and the
 * options route cannot drift into three different spellings of the same
 * refusal — a machine `code` a client branches on is a contract, not a string.
 */
export const COST_INPUT_ENTITY_ID = 'connect_analytics:cost_input'
export const COST_INPUT_RESOURCE_KIND = 'connect_analytics.cost_input'

export const COST_INPUT_ERROR_CODES = {
  organization_scope_required: 'connect_analytics.errors.organizationScopeRequired',
  cost_input_not_found: 'connect_analytics.errors.costInputNotFound',
  amount_minor_invalid: 'connect_analytics.errors.amountMinorInvalid',
  currency_invalid: 'connect_analytics.errors.currencyInvalid',
  currency_validation_unavailable: 'connect_analytics.errors.currencyValidationUnavailable',
  currency_dependency_unavailable: 'connect_analytics.errors.currencyDependencyUnavailable',
  period_invalid: 'connect_analytics.errors.periodInvalid',
  period_too_large: 'connect_analytics.errors.periodTooLarge',
  dimension_invalid: 'connect_analytics.errors.dimensionInvalid',
  provenance_invalid: 'connect_analytics.errors.provenanceInvalid',
  provider_ref_invalid: 'connect_analytics.errors.providerRefInvalid',
  provider_ref_length: 'connect_analytics.errors.providerRefLength',
  provider_line_conflict: 'connect_analytics.errors.providerLineConflict',
  description_too_long: 'connect_analytics.errors.descriptionTooLong',
} as const

export type CostInputErrorCode = keyof typeof COST_INPUT_ERROR_CODES

const FALLBACK_MESSAGES: Record<CostInputErrorCode, string> = {
  organization_scope_required: 'Select an organization before recording cost inputs.',
  cost_input_not_found: 'This cost input no longer exists.',
  amount_minor_invalid: 'Enter the amount as a whole number of minor units.',
  currency_invalid: 'Cost inputs must use the organization base currency.',
  currency_validation_unavailable: 'The base currency could not be verified, so the cost input was not saved.',
  currency_dependency_unavailable: 'The base currency is unavailable for this organization.',
  period_invalid: 'The period end must be after the period start.',
  period_too_large: 'A cost period may not span more than 366 days.',
  dimension_invalid: 'Agent costs need an agent, channel costs need a channel, and AI costs need neither.',
  provenance_invalid: 'Provider invoice rows need both an invoice and a line reference; manual rows need neither.',
  provider_ref_invalid: 'The provider reference contains characters that cannot be stored.',
  provider_ref_length: 'The provider reference must be between 1 and 255 characters.',
  provider_line_conflict: 'A different cost input already uses this provider invoice line.',
  description_too_long: 'The description may not exceed 500 characters.',
}

export type CostInputErrorBody = {
  error: string
  code: CostInputErrorCode
}

export function costInputErrorBody(
  code: CostInputErrorCode,
  translate: (key: string, fallback?: string) => string,
): CostInputErrorBody {
  return { error: translate(COST_INPUT_ERROR_CODES[code], FALLBACK_MESSAGES[code]), code }
}

export function costInputHttpError(
  status: number,
  code: CostInputErrorCode,
  translate: (key: string, fallback?: string) => string,
): CrudHttpError {
  return new CrudHttpError(status, costInputErrorBody(code, translate))
}

/**
 * Maps a Zod issue message emitted by `data/validators.ts` onto the published
 * error vocabulary. Anything unrecognised stays a generic schema failure rather
 * than being guessed into a specific code.
 */
export function costInputCodeFromIssueMessage(message: string): CostInputErrorCode | null {
  return message in COST_INPUT_ERROR_CODES ? message as CostInputErrorCode : null
}
