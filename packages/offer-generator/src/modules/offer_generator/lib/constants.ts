export const MODULE_ID = 'offer_generator'

export const QUEUES = { generate: 'offer-generator-generate' } as const

export const WORKER_IDS = { generate: 'offer_generator.generate' } as const

export const ENTITY_IDS = {
  offer: 'offer_generator:offer',
  offerRevision: 'offer_generator:offer_revision',
  offerGenerationRun: 'offer_generator:offer_generation_run',
  offerView: 'offer_generator:offer_view',
  settings: 'offer_generator:settings',
} as const

export const PUBLIC_PATH_PREFIX = '/oferta'

export const ACCESS_TOKEN_LENGTH = 12
export const MAX_OFFER_HTML_CHARS = 5_000_000
export const MAX_REVISIONS_PER_OFFER = 50

export const TRACKING = {
  START_DELAY_MS: 1000,
  HEARTBEAT_MS: 15000,
  IDLE_AFTER_MS: 60000,
  NEW_VIEW_AFTER_HIDDEN_MS: 1_800_000,
  MAX_ACTIVE_MS: 14_400_000,
  MAX_BODY_BYTES: 4096,
  MAX_VIEWS_PER_OFFER_PER_DAY: 500,
  MAX_VIEWS_PER_IP_PER_HOUR: 30,
  MAX_BEATS: 2000,
  VISITOR_COOKIE: 'om_ofr_vid',
} as const

export const RATE_LIMITS = { session: 240, publicRender: 120 } as const

export const PROGRESS_JOB_TYPE = 'offer_generator.offers.generate'
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 65536
export const AI_DEFAULT_TIMEOUT_MS = 300_000
