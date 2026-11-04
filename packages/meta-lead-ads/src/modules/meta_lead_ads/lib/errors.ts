import type { MetaLeadErrorCode } from './constants'

type LeadErrorOptions = { cause?: unknown }

export class TransientLeadError extends Error {
  readonly leadErrorCode: MetaLeadErrorCode

  constructor(code: MetaLeadErrorCode, message: string, options?: LeadErrorOptions) {
    super(message, options)
    this.name = 'TransientLeadError'
    this.leadErrorCode = code
  }
}

export class PermanentLeadError extends Error {
  readonly leadErrorCode: MetaLeadErrorCode

  constructor(code: MetaLeadErrorCode, message: string, options?: LeadErrorOptions) {
    super(message, options)
    this.name = 'PermanentLeadError'
    this.leadErrorCode = code
  }
}
