export type ManualMatchRow = {
  id: string
  identityId: string
  status: 'open' | 'resolved' | 'superseded'
  handleType: string | null
  /** Masked. The real handle is encrypted and never leaves the server. */
  handleDisplayLabel: string | null
  confidence: number | null
  matchMethod: string | null
  unlinkInProgress: boolean
  createdAt: string
  updatedAt: string
  identityUpdatedAt: string | null
}

export type ManualMatchListResponse = {
  items: ManualMatchRow[]
  total: number
  page: number
  pageSize: number
}

export type CandidateKind = 'person' | 'company'

export type CandidateRow = {
  id: string
  label: string
  /** Masked contact hint, shown as evidence for the match — never a full address. */
  contactHint: string | null
}

export type UnlinkStatus = {
  identityId: string
  sagaId?: string
  state: 'none' | 'pending_hide' | 'committing' | 'finalizing' | 'completed' | 'aborted'
  decision?: 'undecided' | 'commit' | 'abort'
  unlinkInProgress: boolean
  pendingFinalizeCount?: number
  failedFinalizeCount?: number
  retryable: boolean
  lastError?: string | null
}
